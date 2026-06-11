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
  taskStatusLabel,
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
  taskStatusValues,
} from "@/lib/db/schema";
import {
  assertProjectAccess,
  assertTaskInProject,
  getNextTaskSortOrder,
  getProjectSlug,
  isUniqueConstraintError,
  nextTaskCodeNumber,
  optionalText,
  resolveAssignee,
  resolveCategory,
  resolveDueDate,
  userNameMap,
} from "@/lib/services/_shared";

export const createTaskInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(140),
  description: optionalText,
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
  description: optionalText,
  categoryId: optionalText.describe(
    "Task category id from the project (an id, not a category name).",
  ),
  phase: optionalText.describe("Free-text phase/milestone label."),
  status: z.enum(taskStatusValues),
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
  await assertProjectAccess(viewer, input.projectId);

  const taskId = crypto.randomUUID();
  const assigneeId = await resolveAssignee(input.assigneeId, input.projectId);
  const slug = await getProjectSlug(input.projectId);
  const category = await resolveCategory(input.categoryId, input.projectId);
  const sortOrder = await getNextTaskSortOrder(input.projectId, "todo");
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
          requestId,
          assigneeId,
          title: input.title,
          description: input.description ?? null,
          codeNumber,
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          categoryColor: category.categoryColor,
          phase: input.phase ?? null,
          priority: input.priority,
          dueDate,
          status: "todo",
          sortOrder,
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
  await assertProjectAccess(viewer, input.projectId);

  const existingTask = await assertTaskInProject(input.taskId, input.projectId);
  const nextSortOrder =
    existingTask.status === input.status
      ? existingTask.sortOrder
      : await getNextTaskSortOrder(input.projectId, input.status);
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
      to: input.description ?? null,
      kind: "rich",
    },
    {
      field: "status",
      label: "Status",
      from: taskStatusLabel(existingTask.status),
      to: taskStatusLabel(input.status),
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
        description: input.description ?? null,
        categoryId: category.categoryId,
        categoryName: category.categoryName,
        categoryColor: category.categoryColor,
        phase: input.phase ?? null,
        status: input.status,
        priority: input.priority,
        dueDate: nextDueDate,
        assigneeId,
        sortOrder: nextSortOrder,
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
        action: existingTask.status === input.status ? "updated" : "moved",
        label:
          existingTask.status === input.status
            ? "Updated task"
            : `Moved task to ${input.status}`,
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
  await assertProjectAccess(viewer, input.projectId);

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
  status: z.enum(taskStatusValues),
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
  await assertProjectAccess(viewer, input.projectId);
  const existing = await assertTaskInProject(input.taskId, input.projectId);

  return updateTask(viewer, {
    taskId: input.taskId,
    projectId: input.projectId,
    title: existing.title,
    description: existing.description ?? undefined,
    categoryId: existing.categoryId ?? undefined,
    phase: existing.phase ?? undefined,
    status: input.status,
    priority: existing.priority,
    dueDate: existing.dueDate ? existing.dueDate.toISOString() : undefined,
    assigneeId: existing.assigneeId ?? undefined,
  });
}
