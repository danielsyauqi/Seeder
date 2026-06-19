// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Task-status (board column) services — shared by the web server actions
// (lib/actions.ts) and the MCP server (lib/mcp/server.ts). Statuses are the
// Jira-style per-project board columns that replaced the fixed todo/doing/done
// enum. Each is a reusable per-project name + color + order, plus two flags:
//   - isInitial:  the column a newly-created task lands in
//   - isTerminal: a "done"-equivalent column (drives completion %, overdue
//                 suppression, the client status-update publish gate)
// name/color/isTerminal are denormalized onto each task row, so a
// rename/recolor/terminal-toggle must cascade to linked tasks (mirrors
// task_categories). Authz mirrors categories exactly: listing is member-aware
// (canAccessProject); create/edit/delete/reorder need the "taxonomy.manage"
// capability (owner/leader, or a Member with the toggle on).
import { and, asc, count, eq, ne } from "drizzle-orm";
import { z } from "zod";

import type { Viewer } from "@/lib/auth-server";
import { canAccessProject } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { taskStatuses, tasks } from "@/lib/db/schema";
import { assertProjectCapability } from "@/lib/services/_shared";
import { isValidProjectColor, PROJECT_SWATCHES } from "@/lib/swatches";

const DEFAULT_STATUS_COLOR = PROJECT_SWATCHES[0].value;

const COLOR_HINT =
  "Hex swatch from the palette, e.g. #eb5757 (Red), #ef8b3a (Orange), #27a644 (Emerald), #15a8af (Teal), #5e6ad2 (Aether), #8b5cf6 (Amethyst), #6b7077 (Slate).";

// The three statuses every new project starts with — mirrors the migration 0034
// backfill (Storm / Aether / Emerald swatches). Todo is initial, Done terminal.
export const DEFAULT_STATUS_SEED: ReadonlyArray<{
  name: string;
  color: string;
  isInitial: boolean;
  isTerminal: boolean;
}> = [
  { name: "Todo", color: "#8a8f98", isInitial: true, isTerminal: false },
  { name: "Doing", color: "#5e6ad2", isInitial: false, isTerminal: false },
  { name: "Done", color: "#27a644", isInitial: false, isTerminal: true },
];

const statusNameField = z.string().trim().min(1).max(40);

const optionalStatusColorField = z
  .string()
  .trim()
  .refine((value) => value === "" || isValidProjectColor(value), {
    message: "Color must be a hex swatch from the palette (e.g. #5e6ad2).",
  })
  .optional();

// --- Input schemas (exported so the MCP tools can reuse them) ----------------

export const listTaskStatusesInputSchema = z.object({
  projectId: z.string().min(1),
});
export type ListTaskStatusesInput = z.infer<typeof listTaskStatusesInputSchema>;

export const createTaskStatusInputSchema = z.object({
  projectId: z.string().min(1),
  name: statusNameField.describe(
    "Status / column name (1-40 chars, unique per project).",
  ),
  color: optionalStatusColorField.describe(
    `${COLOR_HINT} Defaults to ${DEFAULT_STATUS_COLOR} if omitted.`,
  ),
  isTerminal: z
    .boolean()
    .optional()
    .describe(
      "Mark this a terminal/done column (counts toward completion, suppresses overdue, allows client updates). Default false.",
    ),
});
export type CreateTaskStatusInput = z.infer<typeof createTaskStatusInputSchema>;

export const updateTaskStatusDefInputSchema = z.object({
  statusId: z.string().min(1),
  name: statusNameField
    .optional()
    .describe("New name. Omit to keep the current name."),
  color: optionalStatusColorField.describe(
    `${COLOR_HINT} Omit to keep the current color.`,
  ),
  isTerminal: z
    .boolean()
    .optional()
    .describe("Toggle terminal/done semantics. Omit to keep the current value."),
  isInitial: z
    .boolean()
    .optional()
    .describe(
      "Make this the column new tasks land in (clears the flag on the others). Omit to keep the current value.",
    ),
});
export type UpdateTaskStatusDefInput = z.infer<
  typeof updateTaskStatusDefInputSchema
>;

export const deleteTaskStatusInputSchema = z.object({
  statusId: z.string().min(1),
});
export type DeleteTaskStatusInput = z.infer<typeof deleteTaskStatusInputSchema>;

export const reorderTaskStatusesInputSchema = z.object({
  projectId: z.string().min(1),
  orderedIds: z
    .array(z.string().min(1))
    .min(1)
    .describe("All of the project's status ids in the desired left-to-right order."),
});
export type ReorderTaskStatusesInput = z.infer<
  typeof reorderTaskStatusesInputSchema
>;

// --- Internal helpers --------------------------------------------------------

async function assertStatusManage(viewer: Viewer, statusId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      id: taskStatuses.id,
      projectId: taskStatuses.projectId,
      name: taskStatuses.name,
      color: taskStatuses.color,
      sortOrder: taskStatuses.sortOrder,
      isTerminal: taskStatuses.isTerminal,
      isInitial: taskStatuses.isInitial,
    })
    .from(taskStatuses)
    .where(eq(taskStatuses.id, statusId))
    .limit(1);
  if (!row) throw new Error("Status not found.");
  await assertProjectCapability(viewer, row.projectId, "taxonomy.manage");
  return row;
}

function isUniqueNameError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // D1 surfaces the constraint in the message; libsql wraps it (the real error
  // is in .cause / a SQLITE_CONSTRAINT_UNIQUE code), so check all three.
  const code = (error as { code?: string }).code ?? "";
  const causeMsg = error.cause instanceof Error ? error.cause.message : "";
  return (
    /UNIQUE/i.test(error.message) ||
    /UNIQUE/i.test(causeMsg) ||
    /CONSTRAINT_UNIQUE/i.test(code)
  );
}

/** Count statuses, terminals, and initials for a project in one pass. */
async function statusCounts(projectId: string) {
  const db = getDb();
  const rows = await db
    .select({
      id: taskStatuses.id,
      isTerminal: taskStatuses.isTerminal,
      isInitial: taskStatuses.isInitial,
    })
    .from(taskStatuses)
    .where(eq(taskStatuses.projectId, projectId));
  return {
    total: rows.length,
    terminals: rows.filter((r) => r.isTerminal).map((r) => r.id),
    initials: rows.filter((r) => r.isInitial).map((r) => r.id),
  };
}

/**
 * Seed the three default statuses for a brand-new project. Called by
 * createProject so every new project has a board to drop tasks into (the
 * migration seeds pre-existing projects). Mirrors DEFAULT_STATUS_SEED.
 */
export async function seedDefaultStatuses(projectId: string, now = new Date()) {
  const db = getDb();
  await db.insert(taskStatuses).values(
    DEFAULT_STATUS_SEED.map((s, index) => ({
      id: crypto.randomUUID(),
      projectId,
      name: s.name,
      color: s.color,
      sortOrder: index,
      isInitial: s.isInitial,
      isTerminal: s.isTerminal,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

// --- Services ----------------------------------------------------------------

export async function listTaskStatuses(
  viewer: Viewer,
  input: ListTaskStatusesInput,
): Promise<
  Array<{
    id: string;
    name: string;
    color: string;
    sortOrder: number;
    isTerminal: boolean;
    isInitial: boolean;
    taskCount: number;
  }>
> {
  if (!(await canAccessProject(viewer, input.projectId))) return [];
  const db = getDb();

  const [rows, counts] = await Promise.all([
    db
      .select({
        id: taskStatuses.id,
        name: taskStatuses.name,
        color: taskStatuses.color,
        sortOrder: taskStatuses.sortOrder,
        isTerminal: taskStatuses.isTerminal,
        isInitial: taskStatuses.isInitial,
      })
      .from(taskStatuses)
      .where(eq(taskStatuses.projectId, input.projectId))
      .orderBy(asc(taskStatuses.sortOrder), asc(taskStatuses.name)),
    db
      .select({ statusId: tasks.statusId, n: count() })
      .from(tasks)
      .where(eq(tasks.projectId, input.projectId))
      .groupBy(tasks.statusId),
  ]);

  const countByStatus = new Map<string, number>();
  for (const row of counts) countByStatus.set(row.statusId, row.n);

  return rows.map((row) => ({
    ...row,
    taskCount: countByStatus.get(row.id) ?? 0,
  }));
}

export async function createTaskStatus(
  viewer: Viewer,
  input: CreateTaskStatusInput,
): Promise<{ statusId: string; name: string; color: string }> {
  await assertProjectCapability(viewer, input.projectId, "taxonomy.manage");
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date();
  const color = input.color ? input.color : DEFAULT_STATUS_COLOR;

  // Append after the current last column.
  const existing = await db
    .select({ sortOrder: taskStatuses.sortOrder })
    .from(taskStatuses)
    .where(eq(taskStatuses.projectId, input.projectId))
    .orderBy(asc(taskStatuses.sortOrder));
  const nextSort = existing.length
    ? Math.max(...existing.map((r) => r.sortOrder)) + 1
    : 0;

  try {
    await db.insert(taskStatuses).values({
      id,
      projectId: input.projectId,
      name: input.name,
      color,
      sortOrder: nextSort,
      isTerminal: input.isTerminal ?? false,
      // A new column is never the initial one unless it's the project's first.
      isInitial: existing.length === 0,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (isUniqueNameError(error)) {
      throw new Error(`A status named "${input.name}" already exists.`);
    }
    throw error;
  }

  return { statusId: id, name: input.name, color };
}

export async function updateTaskStatusDef(
  viewer: Viewer,
  input: UpdateTaskStatusDefInput,
): Promise<{
  statusId: string;
  projectId: string;
  name: string;
  color: string;
  isTerminal: boolean;
  isInitial: boolean;
}> {
  const status = await assertStatusManage(viewer, input.statusId);
  const db = getDb();
  const now = new Date();

  const name = input.name ?? status.name;
  const color = input.color ? input.color : status.color;
  const isTerminal = input.isTerminal ?? status.isTerminal;
  const isInitial = input.isInitial ?? status.isInitial;

  // Invariant: a project must keep at least one terminal status (completion %,
  // overdue, and client updates all key off it).
  if (status.isTerminal && !isTerminal) {
    const { terminals } = await statusCounts(status.projectId);
    if (terminals.length <= 1) {
      throw new Error(
        "A project needs at least one Done (terminal) status. Mark another status terminal first.",
      );
    }
  }
  // Invariant: keep at least one initial status (the column new tasks land in).
  if (status.isInitial && !isInitial) {
    throw new Error(
      "A project needs an initial status (where new tasks land). Make another status initial instead.",
    );
  }

  try {
    await db
      .update(taskStatuses)
      .set({ name, color, isTerminal, isInitial, updatedAt: now })
      .where(eq(taskStatuses.id, status.id));
  } catch (error) {
    if (isUniqueNameError(error)) {
      throw new Error(`A status named "${name}" already exists.`);
    }
    throw error;
  }

  // Exactly one initial per project: clear the flag on every other status.
  if (isInitial && !status.isInitial) {
    await db
      .update(taskStatuses)
      .set({ isInitial: false, updatedAt: now })
      .where(
        and(
          eq(taskStatuses.projectId, status.projectId),
          ne(taskStatuses.id, status.id),
        ),
      );
  }

  // Resync the denormalized cache on linked tasks so the board reflects a
  // rename / recolor / terminal-toggle immediately without a join.
  if (
    name !== status.name ||
    color !== status.color ||
    isTerminal !== status.isTerminal
  ) {
    await db
      .update(tasks)
      .set({
        statusName: name,
        statusColor: color,
        isTerminal,
        updatedAt: now,
      })
      .where(eq(tasks.statusId, status.id));
  }

  return {
    statusId: status.id,
    projectId: status.projectId,
    name,
    color,
    isTerminal,
    isInitial,
  };
}

export async function deleteTaskStatus(
  viewer: Viewer,
  input: DeleteTaskStatusInput,
): Promise<{ statusId: string; projectId: string }> {
  const status = await assertStatusManage(viewer, input.statusId);
  const db = getDb();

  // Refuse to orphan tasks — the caller must move them to another status first.
  const [linked] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.statusId, status.id))
    .limit(1);
  if (linked) {
    throw new Error(
      "This status still has tasks in it. Move them to another status first.",
    );
  }

  const counts = await statusCounts(status.projectId);
  if (counts.total <= 1) {
    throw new Error("A project must keep at least one status.");
  }
  if (status.isTerminal && counts.terminals.length <= 1) {
    throw new Error(
      "This is the project's only Done (terminal) status. Mark another status terminal before deleting it.",
    );
  }
  if (status.isInitial && counts.initials.length <= 1) {
    throw new Error(
      "This is the project's initial status. Make another status initial before deleting it.",
    );
  }

  await db.delete(taskStatuses).where(eq(taskStatuses.id, status.id));

  return { statusId: status.id, projectId: status.projectId };
}

export async function reorderTaskStatuses(
  viewer: Viewer,
  input: ReorderTaskStatusesInput,
): Promise<{ projectId: string }> {
  await assertProjectCapability(viewer, input.projectId, "taxonomy.manage");
  const db = getDb();
  const now = new Date();

  // Only renumber ids that actually belong to this project; a foreign/unknown id
  // is skipped rather than written cross-project.
  const owned = new Set(
    (
      await db
        .select({ id: taskStatuses.id })
        .from(taskStatuses)
        .where(eq(taskStatuses.projectId, input.projectId))
    ).map((r) => r.id),
  );

  let order = 0;
  for (const id of input.orderedIds) {
    if (!owned.has(id)) continue;
    await db
      .update(taskStatuses)
      .set({ sortOrder: order, updatedAt: now })
      .where(
        and(
          eq(taskStatuses.id, id),
          eq(taskStatuses.projectId, input.projectId),
        ),
      );
    order += 1;
  }

  return { projectId: input.projectId };
}
