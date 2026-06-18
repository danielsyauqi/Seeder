// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Task-category services — shared by the web server actions (lib/actions.ts)
// and the MCP server (lib/mcp/server.ts). Each takes a Viewer + typed input,
// performs the authz check + DB mutation, and returns a plain result (no
// revalidatePath / FormData). Categories are reusable, per-project labels with a
// color swatch; the name/color are denormalized onto each task row, so a
// rename/recolor must cascade to linked tasks. Authz mirrors the web exactly:
// listing is member-aware (canAccessProject), but creating / editing / deleting
// a category is owner-only, identical to lib/actions.ts (assertProjectManageship /
// assertCategoryAccess). No activity logging — the web category actions don't log
// either, so MCP matches.
import { asc, count, eq } from "drizzle-orm";
import { z } from "zod";

import type { Viewer } from "@/lib/auth-server";
import { canAccessProject } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { taskCategories, tasks } from "@/lib/db/schema";
import { assertProjectManage } from "@/lib/services/_shared";
import { isValidProjectColor, PROJECT_SWATCHES } from "@/lib/swatches";

// Default when a caller creates a category without naming a color (the web
// picker defaults to this same first swatch).
const DEFAULT_CATEGORY_COLOR = PROJECT_SWATCHES[0].value;

// A short hint of valid swatches for the agent — the full palette is the 24
// header-safe project swatches (isValidProjectColor).
const COLOR_HINT =
  "Hex swatch from the palette, e.g. #eb5757 (Red), #ef8b3a (Orange), #27a644 (Emerald), #15a8af (Teal), #5e6ad2 (Aether), #8b5cf6 (Amethyst), #6b7077 (Slate).";

const categoryNameField = z.string().trim().min(1).max(40);

// Optional color: missing/"" falls back to the default (create) or the existing
// color (update); any non-empty value must be a known swatch.
const optionalCategoryColorField = z
  .string()
  .trim()
  .refine((value) => value === "" || isValidProjectColor(value), {
    message: "Color must be a hex swatch from the palette (e.g. #eb5757).",
  })
  .optional();

// --- Input schemas (exported so the MCP tools can reuse them) ----------------

export const listTaskCategoriesInputSchema = z.object({
  projectId: z.string().min(1),
});
export type ListTaskCategoriesInput = z.infer<
  typeof listTaskCategoriesInputSchema
>;

export const createTaskCategoryInputSchema = z.object({
  projectId: z.string().min(1),
  name: categoryNameField.describe("Category name (1-40 chars, unique per project)."),
  color: optionalCategoryColorField.describe(
    `${COLOR_HINT} Defaults to slate (${DEFAULT_CATEGORY_COLOR}) if omitted.`,
  ),
});
export type CreateTaskCategoryInput = z.infer<
  typeof createTaskCategoryInputSchema
>;

export const updateTaskCategoryInputSchema = z.object({
  categoryId: z.string().min(1),
  name: categoryNameField
    .optional()
    .describe("New category name. Omit to keep the current name."),
  color: optionalCategoryColorField.describe(
    `${COLOR_HINT} Omit to keep the current color.`,
  ),
});
export type UpdateTaskCategoryInput = z.infer<
  typeof updateTaskCategoryInputSchema
>;

export const deleteTaskCategoryInputSchema = z.object({
  categoryId: z.string().min(1),
});
export type DeleteTaskCategoryInput = z.infer<
  typeof deleteTaskCategoryInputSchema
>;

// --- Internal helpers --------------------------------------------------------

/**
 * Resolve a category and assert the viewer owns its project. Opaque
 * "Category not found." for both a missing category and one on a project the
 * viewer doesn't own (mirrors assertProjectManage's no-oracle posture).
 */
async function assertCategoryManage(viewer: Viewer, categoryId: string) {
  const db = getDb();
  const [row] = await db
    .select({
      id: taskCategories.id,
      projectId: taskCategories.projectId,
      name: taskCategories.name,
      color: taskCategories.color,
    })
    .from(taskCategories)
    .where(eq(taskCategories.id, categoryId))
    .limit(1);
  if (!row) throw new Error("Category not found.");
  // Leader-level (owner or leader, plus workspace admins) — matches the create
  // gate and the labels/notes/status-update siblings.
  await assertProjectManage(viewer, row.projectId);
  return row;
}

function isUniqueNameError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message);
}

// --- Services ----------------------------------------------------------------

export async function listTaskCategories(
  viewer: Viewer,
  input: ListTaskCategoriesInput,
): Promise<
  Array<{ id: string; name: string; color: string; taskCount: number }>
> {
  // Read of project data any member can see; return [] (not throw) on a miss so
  // a read token can't use it as an existence oracle.
  if (!(await canAccessProject(viewer, input.projectId))) return [];
  const db = getDb();

  const [rows, counts] = await Promise.all([
    db
      .select({
        id: taskCategories.id,
        name: taskCategories.name,
        color: taskCategories.color,
      })
      .from(taskCategories)
      .where(eq(taskCategories.projectId, input.projectId))
      .orderBy(asc(taskCategories.name)),
    db
      .select({ categoryId: tasks.categoryId, n: count() })
      .from(tasks)
      .where(eq(tasks.projectId, input.projectId))
      .groupBy(tasks.categoryId),
  ]);

  const countByCategory = new Map<string, number>();
  for (const row of counts) {
    if (row.categoryId) countByCategory.set(row.categoryId, row.n);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    taskCount: countByCategory.get(row.id) ?? 0,
  }));
}

export async function createTaskCategory(
  viewer: Viewer,
  input: CreateTaskCategoryInput,
): Promise<{ categoryId: string; name: string; color: string }> {
  await assertProjectManage(viewer, input.projectId);
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date();
  const color = input.color ? input.color : DEFAULT_CATEGORY_COLOR;

  try {
    await db.insert(taskCategories).values({
      id,
      projectId: input.projectId,
      name: input.name,
      color,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    // Unique (project_id, name) collision — surface a friendlier message.
    if (isUniqueNameError(error)) {
      throw new Error(`A category named "${input.name}" already exists.`);
    }
    throw error;
  }

  return { categoryId: id, name: input.name, color };
}

export async function updateTaskCategory(
  viewer: Viewer,
  input: UpdateTaskCategoryInput,
): Promise<{
  categoryId: string;
  projectId: string;
  name: string;
  color: string;
}> {
  const category = await assertCategoryManage(viewer, input.categoryId);
  const db = getDb();
  const now = new Date();

  // Partial update: only the fields the caller passes change; omitted fields
  // keep their current value (so a rename never silently recolors).
  const name = input.name ?? category.name;
  const color = input.color ? input.color : category.color;

  if (name === category.name && color === category.color) {
    return { categoryId: category.id, projectId: category.projectId, name, color };
  }

  try {
    await db
      .update(taskCategories)
      .set({ name, color, updatedAt: now })
      .where(eq(taskCategories.id, category.id));
  } catch (error) {
    if (isUniqueNameError(error)) {
      throw new Error(`A category named "${name}" already exists.`);
    }
    throw error;
  }

  // Keep the denormalized cache on tasks in sync so the board reflects a
  // rename/recolor immediately without a join.
  await db
    .update(tasks)
    .set({ categoryName: name, categoryColor: color, updatedAt: now })
    .where(eq(tasks.categoryId, category.id));

  return { categoryId: category.id, projectId: category.projectId, name, color };
}

export async function deleteTaskCategory(
  viewer: Viewer,
  input: DeleteTaskCategoryInput,
): Promise<{ categoryId: string; projectId: string }> {
  const category = await assertCategoryManage(viewer, input.categoryId);
  const db = getDb();

  // Refuse to orphan tasks — the caller must reassign them first (matches the
  // web action).
  const [linked] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.categoryId, category.id))
    .limit(1);
  if (linked) {
    throw new Error(
      "This category is still attached to one or more tasks. Reassign them first.",
    );
  }

  await db.delete(taskCategories).where(eq(taskCategories.id, category.id));

  return { categoryId: category.id, projectId: category.projectId };
}
