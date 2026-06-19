// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Task-label services — shared by the web Server Actions (lib/actions.ts) and
// the MCP server. Labels are reusable per-project tags (name + color), but
// many-to-many: a task can carry several (vs. a single category). Membership
// lives in the task_task_labels join table, so assigning/unassigning never
// rewrites the task row. Authz mirrors categories: managing label definitions
// (create/update/delete) needs the "taxonomy.manage" capability (owner/leader/
// admin, or a member when the project enables it); assigning labels to tasks
// needs "label.apply". Like categories, label changes are not written to the
// activity feed.
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Viewer } from "@/lib/auth-server";
import { canAccessProject } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { taskLabels, taskTaskLabels } from "@/lib/db/schema";
import {
  assertProjectCapability,
  assertTaskInProject,
  touchProject,
  touchTask,
} from "@/lib/services/_shared";
import { isValidProjectColor, PROJECT_SWATCHES } from "@/lib/swatches";

const DEFAULT_LABEL_COLOR = PROJECT_SWATCHES[0].value;
const COLOR_HINT =
  "Hex swatch from the palette, e.g. #eb5757 (Red), #ef8b3a (Orange), #27a644 (Emerald), #15a8af (Teal), #5e6ad2 (Aether). Use list-color-swatches for the full set.";

const labelNameField = z.string().trim().min(1).max(40);
const optionalLabelColorField = z
  .string()
  .trim()
  .refine((value) => value === "" || isValidProjectColor(value), {
    message: "Color must be a hex swatch from the palette (e.g. #eb5757).",
  })
  .optional();

// --- Input schemas -----------------------------------------------------------

export const listTaskLabelsInputSchema = z.object({
  projectId: z.string().min(1),
});
export type ListTaskLabelsInput = z.infer<typeof listTaskLabelsInputSchema>;

export const createTaskLabelInputSchema = z.object({
  projectId: z.string().min(1),
  name: labelNameField.describe("Label name (1-40 chars, unique per project)."),
  color: optionalLabelColorField.describe(
    `${COLOR_HINT} Defaults to slate (${DEFAULT_LABEL_COLOR}) if omitted.`,
  ),
});
export type CreateTaskLabelInput = z.infer<typeof createTaskLabelInputSchema>;

export const updateTaskLabelInputSchema = z.object({
  labelId: z.string().min(1),
  name: labelNameField.optional().describe("New name. Omit to keep current."),
  color: optionalLabelColorField.describe(`${COLOR_HINT} Omit to keep current.`),
});
export type UpdateTaskLabelInput = z.infer<typeof updateTaskLabelInputSchema>;

export const deleteTaskLabelInputSchema = z.object({
  labelId: z.string().min(1),
});
export type DeleteTaskLabelInput = z.infer<typeof deleteTaskLabelInputSchema>;

export const setTaskLabelsInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  labelIds: z
    .array(z.string().min(1))
    .describe("The complete set of label ids the task should have (replaces)."),
});
export type SetTaskLabelsInput = z.infer<typeof setTaskLabelsInputSchema>;

export const addTaskLabelInputSchema = z.object({
  projectId: z.string().min(1),
  taskIds: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .describe("Task ids to tag — one, or many for a bulk tag."),
  labelIds: z
    .array(z.string().min(1))
    .min(1)
    .describe("Label ids to add (from list-task-labels)."),
});
export type AddTaskLabelInput = z.infer<typeof addTaskLabelInputSchema>;

export const removeTaskLabelInputSchema = z.object({
  projectId: z.string().min(1),
  taskIds: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .describe("Task ids to untag — one, or many for a bulk removal."),
  labelIds: z
    .array(z.string().min(1))
    .min(1)
    .describe("Label ids to remove."),
});
export type RemoveTaskLabelInput = z.infer<typeof removeTaskLabelInputSchema>;

type LabelRow = { id: string; name: string; color: string };

// --- Helpers -----------------------------------------------------------------

/** Resolve label ids that belong to the project; throw if any is unknown. */
async function resolveProjectLabels(
  labelIds: string[],
  projectId: string,
): Promise<LabelRow[]> {
  const unique = [...new Set(labelIds)];
  if (unique.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({ id: taskLabels.id, name: taskLabels.name, color: taskLabels.color })
    .from(taskLabels)
    .where(
      and(eq(taskLabels.projectId, projectId), inArray(taskLabels.id, unique)),
    );
  if (rows.length !== unique.length) {
    throw new Error(
      "One or more labels were not found in this project. Use list-task-labels for valid ids.",
    );
  }
  return rows;
}

async function assertLabelOwner(viewer: Viewer, labelId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      id: taskLabels.id,
      projectId: taskLabels.projectId,
      name: taskLabels.name,
      color: taskLabels.color,
    })
    .from(taskLabels)
    .where(eq(taskLabels.id, labelId))
    .limit(1);
  if (!row) throw new Error("Label not found.");
  await assertProjectCapability(viewer, row.projectId, "taxonomy.manage");
  return row;
}

function isUniqueNameError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message);
}

// --- Label definitions -------------------------------------------------------

export async function listTaskLabels(
  viewer: Viewer,
  input: ListTaskLabelsInput,
): Promise<Array<{ id: string; name: string; color: string; taskCount: number }>> {
  if (!(await canAccessProject(viewer, input.projectId))) return [];
  const db = getDb();

  const [rows, counts] = await Promise.all([
    db
      .select({ id: taskLabels.id, name: taskLabels.name, color: taskLabels.color })
      .from(taskLabels)
      .where(eq(taskLabels.projectId, input.projectId))
      .orderBy(asc(taskLabels.name)),
    db
      .select({ labelId: taskTaskLabels.labelId, n: count() })
      .from(taskTaskLabels)
      .innerJoin(taskLabels, eq(taskLabels.id, taskTaskLabels.labelId))
      .where(eq(taskLabels.projectId, input.projectId))
      .groupBy(taskTaskLabels.labelId),
  ]);

  const countByLabel = new Map(counts.map((c) => [c.labelId, c.n]));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    taskCount: countByLabel.get(row.id) ?? 0,
  }));
}

export async function createTaskLabel(
  viewer: Viewer,
  input: CreateTaskLabelInput,
): Promise<{ labelId: string; name: string; color: string }> {
  await assertProjectCapability(viewer, input.projectId, "taxonomy.manage");
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date();
  const color = input.color ? input.color : DEFAULT_LABEL_COLOR;

  try {
    await db.insert(taskLabels).values({
      id,
      projectId: input.projectId,
      name: input.name,
      color,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (isUniqueNameError(error)) {
      throw new Error(`A label named "${input.name}" already exists.`);
    }
    throw error;
  }

  return { labelId: id, name: input.name, color };
}

export async function updateTaskLabel(
  viewer: Viewer,
  input: UpdateTaskLabelInput,
): Promise<{ labelId: string; projectId: string; name: string; color: string }> {
  const label = await assertLabelOwner(viewer, input.labelId);
  const db = getDb();
  const now = new Date();

  const name = input.name ?? label.name;
  const color = input.color ? input.color : label.color;
  if (name === label.name && color === label.color) {
    return { labelId: label.id, projectId: label.projectId, name, color };
  }

  try {
    await db
      .update(taskLabels)
      .set({ name, color, updatedAt: now })
      .where(eq(taskLabels.id, label.id));
  } catch (error) {
    if (isUniqueNameError(error)) {
      throw new Error(`A label named "${name}" already exists.`);
    }
    throw error;
  }

  return { labelId: label.id, projectId: label.projectId, name, color };
}

export async function deleteTaskLabel(
  viewer: Viewer,
  input: DeleteTaskLabelInput,
): Promise<{ labelId: string; projectId: string }> {
  const label = await assertLabelOwner(viewer, input.labelId);
  const db = getDb();
  // Join rows (task_task_labels) cascade via the FK, so this also untags every
  // task that had the label.
  await db.delete(taskLabels).where(eq(taskLabels.id, label.id));
  return { labelId: label.id, projectId: label.projectId };
}

// --- Assignment (task ↔ label) -----------------------------------------------

export async function setTaskLabels(
  viewer: Viewer,
  input: SetTaskLabelsInput,
): Promise<{ taskId: string; labels: LabelRow[] }> {
  await assertProjectCapability(viewer, input.projectId, "label.apply");
  await assertTaskInProject(input.taskId, input.projectId);
  const labels = await resolveProjectLabels(input.labelIds, input.projectId);
  const db = getDb();
  const now = new Date();

  await db
    .delete(taskTaskLabels)
    .where(eq(taskTaskLabels.taskId, input.taskId));
  if (labels.length > 0) {
    await db.insert(taskTaskLabels).values(
      labels.map((label) => ({
        id: crypto.randomUUID(),
        taskId: input.taskId,
        labelId: label.id,
        createdAt: now,
      })),
    );
  }

  await Promise.all([
    touchTask(input.taskId, now),
    touchProject(input.projectId, now),
  ]);

  return { taskId: input.taskId, labels };
}

export async function addTaskLabels(
  viewer: Viewer,
  input: AddTaskLabelInput,
): Promise<{ labels: LabelRow[]; updated: string[]; failed: { taskId: string; error: string }[] }> {
  await assertProjectCapability(viewer, input.projectId, "label.apply");
  const labels = await resolveProjectLabels(input.labelIds, input.projectId);
  const db = getDb();
  const now = new Date();
  const updated: string[] = [];
  const failed: { taskId: string; error: string }[] = [];

  for (const taskId of input.taskIds) {
    try {
      await assertTaskInProject(taskId, input.projectId);
      // INSERT OR IGNORE against the (task_id, label_id) unique index, so adding
      // an already-present label is a no-op rather than an error.
      await db
        .insert(taskTaskLabels)
        .values(
          labels.map((label) => ({
            id: crypto.randomUUID(),
            taskId,
            labelId: label.id,
            createdAt: now,
          })),
        )
        .onConflictDoNothing();
      updated.push(taskId);
    } catch (error) {
      failed.push({
        taskId,
        error: error instanceof Error ? error.message : "Update failed.",
      });
    }
  }

  if (updated.length) await touchProject(input.projectId, now);
  return { labels, updated, failed };
}

export async function removeTaskLabels(
  viewer: Viewer,
  input: RemoveTaskLabelInput,
): Promise<{ updated: string[]; failed: { taskId: string; error: string }[] }> {
  await assertProjectCapability(viewer, input.projectId, "label.apply");
  const db = getDb();
  const now = new Date();
  const labelIds = [...new Set(input.labelIds)];
  const updated: string[] = [];
  const failed: { taskId: string; error: string }[] = [];

  for (const taskId of input.taskIds) {
    try {
      await assertTaskInProject(taskId, input.projectId);
      await db
        .delete(taskTaskLabels)
        .where(
          and(
            eq(taskTaskLabels.taskId, taskId),
            inArray(taskTaskLabels.labelId, labelIds),
          ),
        );
      updated.push(taskId);
    } catch (error) {
      failed.push({
        taskId,
        error: error instanceof Error ? error.message : "Update failed.",
      });
    }
  }

  if (updated.length) await touchProject(input.projectId, now);
  return { updated, failed };
}
