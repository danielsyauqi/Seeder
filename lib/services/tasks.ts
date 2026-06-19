// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Task mutation services — shared by the web route (app/api/workspace) and the
// MCP server. Each takes a Viewer + typed input, performs the DB mutation +
// activity logging, and returns a plain result. NO revalidatePath / redirect /
// FormData (those stay in the callers). Moved verbatim from the workspace route.
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { toActivityRow } from "@/lib/activity";
import {
  diffChanges,
  formatActivityDate,
  priorityLabel,
} from "@/lib/activity-diff";
import { isAdminTier, type Viewer } from "@/lib/auth-server";
import { formatTaskCode } from "@/lib/codes";
import { getDb } from "@/lib/db";
import {
  clientRequests,
  priorityValues,
  projectActivity,
  projects,
  tasks,
} from "@/lib/db/schema";
import { normalizeRichTextInput } from "@/lib/rich-text";
import {
  assertProjectCapability,
  assertTaskInProject,
  getNextTaskSortOrder,
  getProjectInitialStatus,
  getProjectSlug,
  isUniqueConstraintError,
  nextTaskCodeNumber,
  optionalText,
  resolveAssignee,
  resolveBranchId,
  resolveCategory,
  resolveDefaultBranchId,
  resolveDueDate,
  resolveStatusForWrite,
  userNameMap,
} from "@/lib/services/_shared";

const descriptionField = optionalText.describe(
  "Task description. Markdown is accepted (headings, bold/italic, lists, links, `code`, fenced code blocks, tables) and converted to rich text — paste a Jira description as-is.",
);

export const createTaskInputSchema = z.object({
  projectId: z.string().min(1),
  branchId: optionalText.describe(
    "Branch id to create the task on (an id, not a name; get it from list-branches). Defaults to the project's Main branch.",
  ),
  title: z.string().trim().min(1).max(140),
  description: descriptionField,
  categoryId: optionalText.describe(
    "Task category id from the project (an id, not a category name).",
  ),
  phase: optionalText.describe("Free-text phase/milestone label."),
  priority: z.enum(priorityValues).default("medium"),
  dueDate: optionalText.describe(
    "Due date as an ISO-8601 date, e.g. 2026-06-04.",
  ),
  requestId: optionalText.describe(
    "Client-request id to link this task to (must be in the same project).",
  ),
  assigneeId: optionalText.describe(
    "User id of a project member to assign (an id, not a name).",
  ),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(140),
  description: descriptionField,
  categoryId: optionalText.describe(
    "Task category id from the project (an id, not a category name).",
  ),
  phase: optionalText.describe("Free-text phase/milestone label."),
  statusId: z
    .string()
    .min(1)
    .describe(
      "Status id from the project (an id, not a name; get it from list-task-statuses).",
    ),
  priority: z.enum(priorityValues),
  dueDate: optionalText.describe(
    "Due date as an ISO-8601 date, e.g. 2026-06-04.",
  ),
  assigneeId: optionalText.describe(
    "User id of a project member to assign (an id, not a name).",
  ),
});
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export const deleteTaskInputSchema = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
});
export type DeleteTaskInput = z.infer<typeof deleteTaskInputSchema>;

export async function createTask(
  viewer: Viewer,
  input: CreateTaskInput,
): Promise<{ taskId: string }> {
  const db = getDb();
  const now = new Date();
  await assertProjectCapability(viewer, input.projectId, "task.write");

  const taskId = crypto.randomUUID();
  const description = normalizeRichTextInput(input.description);
  const assigneeId = await resolveAssignee(input.assigneeId, input.projectId);
  const slug = await getProjectSlug(input.projectId);
  const category = await resolveCategory(input.categoryId, input.projectId);
  const branchId = await resolveBranchId(input.branchId, input.projectId);
  // New tasks land in the project's initial column (was: hardcoded "todo").
  const initial = await getProjectInitialStatus(input.projectId);
  const sortOrder = await getNextTaskSortOrder(
    input.projectId,
    initial.statusId,
    branchId,
  );
  const dueDate = resolveDueDate(input.dueDate);
  // Only link a client request that belongs to this same project; drop a
  // stale/cross-project request id rather than persisting a foreign link.
  let requestId: string | null = input.requestId ?? null;
  if (requestId) {
    const [linkedRequest] = await db
      .select({ id: clientRequests.id })
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.id, requestId),
          eq(clientRequests.projectId, input.projectId),
        ),
      )
      .limit(1);
    if (!linkedRequest) requestId = null;
  }

  // Allocate the code number and insert in a retry loop: a concurrent create
  // (web + MCP) can grab the same MAX+1 number and collide on the UNIQUE
  // (project_id, code_number) index. Recompute and retry instead of failing.
  // The insert, the project touch, and the activity row commit together as one
  // D1 batch (atomic), so a failed attempt leaves nothing behind.
  for (let attempt = 0; ; attempt++) {
    const codeNumber = await nextTaskCodeNumber(input.projectId);
    const code = formatTaskCode(slug, codeNumber);
    try {
      await db.batch([
        db.insert(tasks).values({
          id: taskId,
          ownerId: viewer.id,
          projectId: input.projectId,
          branchId,
          requestId,
          assigneeId,
          title: input.title,
          description: description ?? null,
          codeNumber,
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          categoryColor: category.categoryColor,
          phase: input.phase ?? null,
          priority: input.priority,
          dueDate,
          statusId: initial.statusId,
          statusName: initial.statusName,
          statusColor: initial.statusColor,
          isTerminal: initial.isTerminal,
          sortOrder,
          statusChangedAt: now,
          createdAt: now,
          updatedAt: now,
        }),
        db.update(projects).set({ updatedAt: now }).where(eq(projects.id, input.projectId)),
        db.insert(projectActivity).values(
          toActivityRow({
            ownerId: viewer.id,
            projectId: input.projectId,
            entityType: "task",
            entityId: taskId,
            action: "created",
            label: "Created task",
            detail: code ? `${code} · ${input.title}` : input.title,
            createdAt: now,
          }),
        ),
      ]);
      break;
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < 4) continue;
      throw error;
    }
  }

  return { taskId };
}

export async function updateTask(
  viewer: Viewer,
  input: UpdateTaskInput,
): Promise<{ taskId: string }> {
  const db = getDb();
  const now = new Date();
  await assertProjectCapability(viewer, input.projectId, "task.write");

  const existingTask = await assertTaskInProject(input.taskId, input.projectId);
  // Validate the target status belongs to this project; a bad id throws rather
  // than silently moving the card to another column.
  const resolvedStatus = await resolveStatusForWrite(
    input.statusId,
    input.projectId,
  );
  const statusChanged = existingTask.statusId !== resolvedStatus.statusId;
  // A status move re-homes the card to the bottom of the new column WITHIN its
  // own branch (sort order is scoped per branch). branchId is always set in
  // practice; fall back to Main only to satisfy the non-null contract.
  const branchId =
    existingTask.branchId ?? (await resolveDefaultBranchId(input.projectId));
  const nextSortOrder = statusChanged
    ? await getNextTaskSortOrder(input.projectId, resolvedStatus.statusId, branchId)
    : existingTask.sortOrder;
  // Stamp the moment the task enters a new column; keep the prior stamp on edits
  // that don't move it (so the "in <status> since" label reflects the real move).
  const nextStatusChangedAt = statusChanged
    ? now
    : existingTask.statusChangedAt ?? now;
  // Admins get a pass on re-validating an *unchanged* assignee, so they can edit
  // a task whose current assignee isn't a project member (never added, or since
  // removed) without being blocked on its title/status. Members don't: their
  // saves always re-validate, so a stale non-member assignee keeps blocking them.
  // A *changed* assignee is checked against membership for everyone.
  const assigneeUnchanged =
    (input.assigneeId ?? null) === existingTask.assigneeId;
  const assigneeId =
    assigneeUnchanged && isAdminTier(viewer.role)
      ? existingTask.assigneeId
      : await resolveAssignee(input.assigneeId, input.projectId);

  const category = await resolveCategory(input.categoryId, input.projectId);
  const nextDueDate = resolveDueDate(input.dueDate);
  const description = normalizeRichTextInput(input.description);

  const names = await userNameMap([existingTask.assigneeId, assigneeId]);
  const assigneeFrom = existingTask.assigneeId
    ? names.get(existingTask.assigneeId) ?? "Someone"
    : "Unassigned";
  const assigneeTo = assigneeId
    ? names.get(assigneeId) ?? "Someone"
    : "Unassigned";
  const changes = diffChanges([
    { field: "title", label: "Title", from: existingTask.title, to: input.title },
    {
      field: "description",
      label: "Description",
      from: existingTask.description,
      to: description ?? null,
      kind: "rich",
    },
    {
      field: "status",
      label: "Status",
      from: existingTask.statusName,
      to: resolvedStatus.statusName,
    },
    {
      field: "priority",
      label: "Priority",
      from: priorityLabel(existingTask.priority),
      to: priorityLabel(input.priority),
    },
    {
      field: "assignee",
      label: "Assignee",
      from: assigneeFrom,
      to: assigneeTo,
    },
    {
      field: "dueDate",
      label: "Due date",
      from: formatActivityDate(existingTask.dueDate),
      to: formatActivityDate(nextDueDate),
    },
    {
      field: "category",
      label: "Category",
      from: existingTask.categoryName,
      to: category.categoryName,
    },
    { field: "phase", label: "Phase", from: existingTask.phase, to: input.phase ?? null },
  ]);

  // Task update, project touch, and activity row commit atomically.
  await db.batch([
    db
      .update(tasks)
      .set({
        title: input.title,
        description: description ?? null,
        categoryId: category.categoryId,
        categoryName: category.categoryName,
        categoryColor: category.categoryColor,
        phase: input.phase ?? null,
        statusId: resolvedStatus.statusId,
        statusName: resolvedStatus.statusName,
        statusColor: resolvedStatus.statusColor,
        isTerminal: resolvedStatus.isTerminal,
        priority: input.priority,
        dueDate: nextDueDate,
        assigneeId,
        sortOrder: nextSortOrder,
        statusChangedAt: nextStatusChangedAt,
        updatedAt: now,
      })
      .where(eq(tasks.id, input.taskId)),
    db.update(projects).set({ updatedAt: now }).where(eq(projects.id, input.projectId)),
    db.insert(projectActivity).values(
      toActivityRow({
        ownerId: viewer.id,
        projectId: input.projectId,
        entityType: "task",
        entityId: input.taskId,
        action: statusChanged ? "moved" : "updated",
        label: statusChanged
          ? `Moved task to ${resolvedStatus.statusName}`
          : "Updated task",
        detail: input.title,
        changes,
        createdAt: now,
      }),
    ),
  ]);

  return { taskId: input.taskId };
}

export async function deleteTask(
  viewer: Viewer,
  input: DeleteTaskInput,
): Promise<{ taskId: string }> {
  const db = getDb();
  const now = new Date();
  await assertProjectCapability(viewer, input.projectId, "task.write");

  const task = await assertTaskInProject(input.taskId, input.projectId);

  // Delete, project touch, and activity row commit atomically.
  await db.batch([
    db
      .delete(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId))),
    db.update(projects).set({ updatedAt: now }).where(eq(projects.id, input.projectId)),
    db.insert(projectActivity).values(
      toActivityRow({
        ownerId: viewer.id,
        projectId: input.projectId,
        entityType: "task",
        entityId: input.taskId,
        action: "deleted",
        label: "Deleted task",
        detail: task.title,
        createdAt: now,
      }),
    ),
  ]);

  return { taskId: input.taskId };
}

export const updateTaskStatusInputSchema = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  statusId: z
    .string()
    .min(1)
    .describe(
      "Status id to move the task to (an id, not a name; get it from list-task-statuses).",
    ),
});
export type UpdateTaskStatusInput = z.infer<typeof updateTaskStatusInputSchema>;

// Narrow convenience: move a task to a new status without touching other fields.
// Loads the existing row and delegates to updateTask so the change is diffed,
// activity-logged, and sort-order-recomputed exactly like a board move — never
// a second, unlogged update path.
export async function updateTaskStatus(
  viewer: Viewer,
  input: UpdateTaskStatusInput,
): Promise<{ taskId: string }> {
  await assertProjectCapability(viewer, input.projectId, "task.write");
  const existing = await assertTaskInProject(input.taskId, input.projectId);

  return updateTask(viewer, {
    taskId: input.taskId,
    projectId: input.projectId,
    title: existing.title,
    description: existing.description ?? undefined,
    categoryId: existing.categoryId ?? undefined,
    phase: existing.phase ?? undefined,
    statusId: input.statusId,
    priority: existing.priority,
    dueDate: existing.dueDate ? existing.dueDate.toISOString() : undefined,
    assigneeId: existing.assigneeId ?? undefined,
  });
}

export const setTaskCategoryInputSchema = z.object({
  projectId: z.string().min(1),
  taskIds: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .describe(
      "Task ids in this project to (re)tag — pass one to tag a single task, or many for a bulk re-tag.",
    ),
  categoryId: optionalText.describe(
    "Category id to assign (get it from list-task-categories). Omit or pass an empty string to clear the tasks' category.",
  ),
});
export type SetTaskCategoryInput = z.infer<typeof setTaskCategoryInputSchema>;

// Partial, category-only (re)tag for one or many tasks — the convenience
// analogue of update-task-status, so "just put this task in a category" doesn't
// require a full-replace update-task (which would clobber omitted fields).
// Validates the category once up front (a bad id fails the whole call rather
// than silently clearing every task), then delegates each task to updateTask so
// every change is diffed and activity-logged on the single update path. Per-task
// failures are collected, not fatal, so one bad id can't abort a bulk re-tag.
export async function setTaskCategory(
  viewer: Viewer,
  input: SetTaskCategoryInput,
): Promise<{
  category: { id: string; name: string; color: string | null } | null;
  updated: string[];
  failed: { taskId: string; error: string }[];
}> {
  await assertProjectCapability(viewer, input.projectId, "task.write");

  const categoryId = input.categoryId ? input.categoryId : undefined;
  let category: { id: string; name: string; color: string | null } | null =
    null;
  if (categoryId) {
    const resolved = await resolveCategory(categoryId, input.projectId);
    if (!resolved.categoryId) {
      throw new Error(
        "Category not found in this project. Use list-task-categories to find a valid id.",
      );
    }
    category = {
      id: resolved.categoryId,
      name: resolved.categoryName ?? "",
      color: resolved.categoryColor,
    };
  }

  const updated: string[] = [];
  const failed: { taskId: string; error: string }[] = [];

  for (const taskId of input.taskIds) {
    try {
      const existing = await assertTaskInProject(taskId, input.projectId);
      await updateTask(viewer, {
        taskId,
        projectId: input.projectId,
        title: existing.title,
        description: existing.description ?? undefined,
        categoryId, // new category, or undefined to clear
        phase: existing.phase ?? undefined,
        statusId: existing.statusId,
        priority: existing.priority,
        dueDate: existing.dueDate ? existing.dueDate.toISOString() : undefined,
        assigneeId: existing.assigneeId ?? undefined,
      });
      updated.push(taskId);
    } catch (error) {
      failed.push({
        taskId,
        error: error instanceof Error ? error.message : "Update failed.",
      });
    }
  }

  return { category, updated, failed };
}
