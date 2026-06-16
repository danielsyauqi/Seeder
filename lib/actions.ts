"use server";

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { logProjectActivity } from "@/lib/activity";
import {
  diffChanges,
  formatActivityDate,
  priorityLabel,
  requestStatusLabel,
  taskStatusLabel,
} from "@/lib/activity-diff";
import {
  isAdminTier,
  requireRole,
  requireSession,
  requireViewer,
  type Viewer,
} from "@/lib/auth-server";
import { canAccessProject } from "@/lib/authz";
import {
  formatRequestCode,
  formatTaskCode,
  isValidSlug,
  normalizeSlugInput,
  SLUG_MAX_LENGTH,
} from "@/lib/codes";
import { getDb } from "@/lib/db";
import {
  createTaskCategory as createTaskCategoryService,
  deleteTaskCategory as deleteTaskCategoryService,
  updateTaskCategory as updateTaskCategoryService,
} from "@/lib/services/categories";
import {
  createRequestComment as createRequestCommentService,
  createTaskComment as createTaskCommentService,
  deleteRequestComment as deleteRequestCommentService,
  deleteTaskComment as deleteTaskCommentService,
  updateRequestComment as updateRequestCommentService,
  updateTaskComment as updateTaskCommentService,
} from "@/lib/services/comments";
import {
  createTaskLabel as createTaskLabelService,
  deleteTaskLabel as deleteTaskLabelService,
  updateTaskLabel as updateTaskLabelService,
} from "@/lib/services/labels";
import { writeProjectNote as writeProjectNoteService } from "@/lib/services/notes";
import {
  deleteStatusUpdate as deleteStatusUpdateService,
  publishStatusUpdate as publishStatusUpdateService,
} from "@/lib/services/status-updates";
import {
  archiveProject as archiveProjectService,
  createProject as createProjectService,
  deleteProject as deleteProjectService,
  duplicateProject as duplicateProjectService,
  restoreProject as restoreProjectService,
  rotateClientShareToken as rotateClientShareTokenService,
  setClientShare as setClientShareService,
  setProjectColor as setProjectColorService,
  setProjectSlug as setProjectSlugService,
  updateProject as updateProjectService,
} from "@/lib/services/projects";
import { isValidProjectColor } from "@/lib/swatches";
import {
  clientRequests,
  dailyTaskKindValues,
  dailyTasks,
  notificationReads,
  notifications,
  priorityValues,
  projects,
  projectStatusValues,
  requestStatusValues,
  taskCategories,
  taskChecklistItems,
  tasks,
  taskStatusValues,
  user,
} from "@/lib/db/schema";
import { parseRichText, richTextIsEmpty, richTextToPlainText } from "@/lib/rich-text";
import { formatDateKey, parseDateKey } from "@/lib/daily";
import {
  createNotification,
  createNotifications,
  type NotificationInput,
} from "@/lib/notifications";
import { safeReturnPath, withSearchParams } from "@/lib/utils";
import type { FlashKey } from "@/lib/flash";

// Append a one-shot flash key to a redirect target so the client <FlashToaster/>
// (app layout) shows a success toast after the navigation.
function withFlash(path: string, key: FlashKey) {
  return withSearchParams(path, { flash: key });
}

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value.length ? value : undefined))
  .optional()
  .or(z.literal("").transform(() => undefined));

const optionalHexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .optional()
  .or(z.literal("").transform(() => undefined));

const optionalSlug = z
  .string()
  .trim()
  .transform((value) => normalizeSlugInput(value))
  .refine((value) => value === "" || isValidSlug(value), {
    message: "Slug must be 2-10 uppercase letters or numbers.",
  })
  .optional()
  .or(z.literal("").transform(() => undefined));

const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: optionalSlug,
  clientName: optionalText,
  summary: optionalText,
  status: z.enum(projectStatusValues).default("development"),
  deadline: optionalText,
  // Empty string = no color; any non-empty value must be a known swatch.
  color: z
    .string()
    .trim()
    .refine((value) => value === "" || isValidProjectColor(value), {
      message: "Unknown project color.",
    })
    .optional(),
});

const projectSlugSchema = z.object({
  projectId: z.string().min(1),
  slug: z
    .string()
    .trim()
    .transform((value) => normalizeSlugInput(value))
    .refine(isValidSlug, {
      message: `Slug must be 2-${SLUG_MAX_LENGTH} uppercase letters or numbers.`,
    }),
  returnTo: optionalText,
});

const projectUpdateSchema = projectCreateSchema.extend({
  projectId: z.string().min(1),
  returnTo: optionalText,
});

const projectActionSchema = z.object({
  projectId: z.string().min(1),
  returnTo: optionalText,
});

const projectColorSchema = z.object({
  projectId: z.string().min(1),
  // Empty string clears the color; any non-empty value must be a known swatch.
  color: z
    .string()
    .trim()
    .refine((value) => value === "" || isValidProjectColor(value), {
      message: "Unknown project color.",
    }),
  returnTo: optionalText,
});

const projectDeleteSchema = z.object({
  projectId: z.string().min(1),
});

const requestCreateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(140),
  description: optionalText,
  priority: z.enum(priorityValues).default("medium"),
  returnTo: optionalText,
});

const requestUpdateSchema = z.object({
  requestId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(140),
  description: optionalText,
  status: z.enum(requestStatusValues),
  priority: z.enum(priorityValues),
  returnTo: optionalText,
});

const taskCreateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(140),
  description: optionalText,
  categoryId: optionalText,
  phase: optionalText,
  priority: z.enum(priorityValues).default("medium"),
  dueDate: optionalText,
  requestId: optionalText,
  returnTo: optionalText,
});

const taskUpdateSchema = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(140),
  description: optionalText,
  categoryId: optionalText,
  phase: optionalText,
  status: z.enum(taskStatusValues),
  priority: z.enum(priorityValues),
  dueDate: optionalText,
  returnTo: optionalText,
});

const convertRequestSchema = z.object({
  requestId: z.string().min(1),
  projectId: z.string().min(1),
  returnTo: optionalText,
});

const requestDeleteSchema = z.object({
  requestId: z.string().min(1),
  projectId: z.string().min(1),
  returnTo: optionalText,
});

const taskDeleteSchema = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  returnTo: optionalText,
});

const noteSchema = z.object({
  projectId: z.string().min(1),
  content: z.string(),
  returnTo: optionalText,
});

const checklistCreateSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  content: z.string().trim().min(1).max(180),
  returnTo: optionalText,
});

const checklistToggleSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  checklistItemId: z.string().min(1),
  returnTo: optionalText,
});

const checklistDeleteSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  checklistItemId: z.string().min(1),
  returnTo: optionalText,
});

const STATUS_UPDATE_MAX = 5000;

const taskStatusUpdateSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  summary: z.string().trim().min(1).max(STATUS_UPDATE_MAX),
  returnTo: optionalText,
});

const taskStatusUpdateDeleteSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  returnTo: optionalText,
});

function parseDate(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

async function resolveCategoryById(
  categoryId: string | undefined,
  projectId: string,
) {
  if (!categoryId) {
    return { categoryId: null, categoryName: null, categoryColor: null };
  }
  const db = getDb();
  const [row] = await db
    .select({
      id: taskCategories.id,
      name: taskCategories.name,
      color: taskCategories.color,
      projectId: taskCategories.projectId,
    })
    .from(taskCategories)
    .where(eq(taskCategories.id, categoryId))
    .limit(1);
  if (!row || row.projectId !== projectId) {
    return { categoryId: null, categoryName: null, categoryColor: null };
  }
  return { categoryId: row.id, categoryName: row.name, categoryColor: row.color };
}

async function nextTaskCodeNumber(projectId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: max(tasks.codeNumber) })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
  return (row?.value ?? 0) + 1;
}

async function nextRequestCodeNumber(projectId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: max(clientRequests.codeNumber) })
    .from(clientRequests)
    .where(eq(clientRequests.projectId, projectId));
  return (row?.value ?? 0) + 1;
}

async function assertProjectOwnership(projectId: string, ownerId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .limit(1);

  if (!project) {
    throw new Error("Project not found.");
  }

  return project;
}

// Task mutations are open to anyone who can access the project — admin tier, the
// project owner, or a project member — matching /api/tasks/reorder and the MCP
// service layer (lib/services/tasks.ts), so the New/Edit/Delete-task modals are
// no stricter than the board itself. Returns the project row (callers need its
// slug for task codes).
async function assertProjectTaskAccess(viewer: Viewer, projectId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || !(await canAccessProject(viewer, projectId))) {
    throw new Error("Project not found.");
  }
  return project;
}

// Load a task by (id, project) with no owner filter. Callers gate access via
// assertProjectTaskAccess first, so any project collaborator — not just the
// task's creator — can act on it.
async function loadProjectTask(taskId: string, projectId: string) {
  const db = getDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .limit(1);
  if (!task) {
    throw new Error("Task not found.");
  }
  return task;
}

async function getNextTaskSortOrder(
  projectId: string,
  status: (typeof taskStatusValues)[number],
) {
  const db = getDb();
  const [latest] = await db
    .select({
      sortOrder: tasks.sortOrder,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, status)))
    .orderBy(desc(tasks.sortOrder))
    .limit(1);

  return (latest?.sortOrder ?? -1) + 1;
}

function toPayload(formData: FormData) {
  return Object.fromEntries(formData.entries());
}

function revalidateProjectsIndex() {
  revalidatePath("/projects");
}

function revalidateTodayView() {
  revalidatePath("/today");
}

function revalidateWorkspaceCollections() {
  revalidateProjectsIndex();
  revalidateTodayView();
}

function revalidateProjectViews(
  projectId: string,
  options: {
    projects?: boolean;
    today?: boolean;
    overview?: boolean;
    requests?: boolean;
    board?: boolean;
    notes?: boolean;
    settings?: boolean;
    clientBoard?: boolean;
  } = {},
) {
  const basePath = `/projects/${projectId}`;

  if (options.projects) {
    revalidateProjectsIndex();
  }

  if (options.today) {
    revalidateTodayView();
  }

  if (options.overview) {
    revalidatePath(basePath);
  }

  if (options.requests) {
    revalidatePath(`${basePath}/requests`);
  }

  if (options.board) {
    revalidatePath(`${basePath}/board`);
  }

  if (options.notes) {
    revalidatePath(`${basePath}/notes`);
  }

  if (options.settings) {
    revalidatePath(`${basePath}/settings`);
  }

  if (options.clientBoard) {
    // The public board is addressed by share token, not project id, so
    // revalidate the dynamic route itself.
    revalidatePath("/client/[token]", "page");
  }
}

async function touchProject(projectId: string, updatedAt = new Date()) {
  const db = getDb();

  await db
    .update(projects)
    .set({
      updatedAt,
    })
    .where(eq(projects.id, projectId));
}

async function touchTask(taskId: string, updatedAt = new Date()) {
  const db = getDb();

  await db
    .update(tasks)
    .set({
      updatedAt,
    })
    .where(eq(tasks.id, taskId));
}

async function getNextChecklistSortOrder(taskId: string) {
  const db = getDb();
  const [latest] = await db
    .select({
      sortOrder: taskChecklistItems.sortOrder,
    })
    .from(taskChecklistItems)
    .where(eq(taskChecklistItems.taskId, taskId))
    .orderBy(desc(taskChecklistItems.sortOrder))
    .limit(1);

  return (latest?.sortOrder ?? -1) + 1;
}

export async function createProjectAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectCreateSchema.parse(toPayload(formData));

  const { projectId } = await createProjectService(viewer, payload);

  revalidateWorkspaceCollections();
  redirect(withFlash(`/projects/${projectId}`, "project-created"));
}

export async function updateProjectAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectUpdateSchema.parse(toPayload(formData));

  await updateProjectService(viewer, payload);

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    today: true,
    overview: true,
    requests: true,
    board: true,
    notes: true,
    settings: true,
    clientBoard: true,
  });
  redirect(withFlash(destination, "project-updated"));
}

export async function setProjectSlugAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectSlugSchema.parse(toPayload(formData));

  await setProjectSlugService(viewer, payload);

  revalidateProjectViews(payload.projectId, {
    projects: true,
    today: true,
    overview: true,
    requests: true,
    board: true,
    notes: true,
    settings: true,
    clientBoard: true,
  });

  if (payload.returnTo) {
    redirect(
      withFlash(
        safeReturnPath(payload.returnTo, `/projects/${payload.projectId}`),
        "slug-updated",
      ),
    );
  }
}

export async function setProjectColorAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectColorSchema.parse(toPayload(formData));

  await setProjectColorService(viewer, payload);

  revalidateProjectViews(payload.projectId, {
    projects: true,
    today: true,
    overview: true,
    requests: true,
    board: true,
    notes: true,
    settings: true,
  });
}

export async function archiveProjectAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectActionSchema.parse(toPayload(formData));

  await archiveProjectService(viewer, payload);

  revalidateProjectViews(payload.projectId, {
    projects: true,
    today: true,
    overview: true,
    requests: true,
    board: true,
    notes: true,
    settings: true,
  });
  redirect(
    withFlash(
      safeReturnPath(payload.returnTo, "/projects?view=archived"),
      "project-archived",
    ),
  );
}

export async function restoreProjectAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectActionSchema.parse(toPayload(formData));

  await restoreProjectService(viewer, payload);

  revalidateProjectViews(payload.projectId, {
    projects: true,
    today: true,
    overview: true,
    requests: true,
    board: true,
    notes: true,
    settings: true,
  });
  redirect(
    withFlash(
      safeReturnPath(payload.returnTo, `/projects/${payload.projectId}`),
      "project-restored",
    ),
  );
}

export async function enableClientShareAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectActionSchema.parse(toPayload(formData));

  await setClientShareService(viewer, {
    projectId: payload.projectId,
    enabled: true,
  });

  revalidateProjectViews(payload.projectId, { settings: true, clientBoard: true });
  if (payload.returnTo) {
    redirect(
      withFlash(
        safeReturnPath(payload.returnTo, `/projects/${payload.projectId}/settings`),
        "share-enabled",
      ),
    );
  }
}

export async function disableClientShareAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectActionSchema.parse(toPayload(formData));

  await setClientShareService(viewer, {
    projectId: payload.projectId,
    enabled: false,
  });

  revalidateProjectViews(payload.projectId, { settings: true, clientBoard: true });
  if (payload.returnTo) {
    redirect(
      withFlash(
        safeReturnPath(payload.returnTo, `/projects/${payload.projectId}/settings`),
        "share-disabled",
      ),
    );
  }
}

export async function rotateClientShareTokenAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectActionSchema.parse(toPayload(formData));

  await rotateClientShareTokenService(viewer, payload);

  revalidateProjectViews(payload.projectId, { settings: true, clientBoard: true });
  if (payload.returnTo) {
    redirect(
      withFlash(
        safeReturnPath(payload.returnTo, `/projects/${payload.projectId}/settings`),
        "share-rotated",
      ),
    );
  }
}

export async function duplicateProjectAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectActionSchema.parse(toPayload(formData));

  const { projectId: newProjectId } = await duplicateProjectService(
    viewer,
    payload,
  );

  revalidateWorkspaceCollections();
  redirect(withFlash(`/projects/${newProjectId}`, "project-duplicated"));
}

export async function deleteProjectAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = projectDeleteSchema.parse(toPayload(formData));

  await deleteProjectService(viewer, payload);

  revalidateWorkspaceCollections();
  redirect(withFlash("/projects", "project-deleted"));
}

export async function createRequestAction(formData: FormData) {
  const session = await requireSession();
  const payload = requestCreateSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();

  const project = await assertProjectOwnership(payload.projectId, session.user.id);

  const requestId = crypto.randomUUID();
  const codeNumber = await nextRequestCodeNumber(payload.projectId);
  const code = formatRequestCode(project.slug, codeNumber);

  await db.insert(clientRequests).values({
    id: requestId,
    ownerId: session.user.id,
    projectId: payload.projectId,
    title: payload.title,
    description: payload.description ?? null,
    codeNumber,
    priority: payload.priority,
    status: "new",
    createdAt: now,
    updatedAt: now,
  });

  await touchProject(payload.projectId, now);
  await logProjectActivity(db, {
    ownerId: session.user.id,
    projectId: payload.projectId,
    entityType: "request",
    entityId: requestId,
    action: "created",
    label: "Captured request",
    detail: code ? `${code} · ${payload.title}` : payload.title,
    createdAt: now,
  });

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    requests: true,
  });
  redirect(destination);
}

export async function updateRequestAction(formData: FormData) {
  const session = await requireSession();
  const payload = requestUpdateSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();

  await assertProjectOwnership(payload.projectId, session.user.id);

  const [existingRequest] = await db
    .select()
    .from(clientRequests)
    .where(
      and(
        eq(clientRequests.id, payload.requestId),
        eq(clientRequests.projectId, payload.projectId),
        eq(clientRequests.ownerId, session.user.id),
      ),
    )
    .limit(1);

  if (!existingRequest) {
    throw new Error("Request not found.");
  }

  await db
    .update(clientRequests)
    .set({
      title: payload.title,
      description: payload.description ?? null,
      status: payload.status,
      priority: payload.priority,
      updatedAt: now,
    })
    .where(
      and(
        eq(clientRequests.id, payload.requestId),
        eq(clientRequests.projectId, payload.projectId),
        eq(clientRequests.ownerId, session.user.id),
      ),
    );

  const changes = diffChanges([
    { field: "title", label: "Title", from: existingRequest.title, to: payload.title },
    {
      field: "description",
      label: "Description",
      from: existingRequest.description,
      to: payload.description ?? null,
      kind: "rich",
    },
    {
      field: "status",
      label: "Status",
      from: requestStatusLabel(existingRequest.status),
      to: requestStatusLabel(payload.status),
    },
    {
      field: "priority",
      label: "Priority",
      from: priorityLabel(existingRequest.priority),
      to: priorityLabel(payload.priority),
    },
  ]);

  await touchProject(payload.projectId, now);
  await logProjectActivity(db, {
    ownerId: session.user.id,
    projectId: payload.projectId,
    entityType: "request",
    entityId: payload.requestId,
    action: "updated",
    label: "Updated request",
    detail: payload.title,
    changes,
    createdAt: now,
  });

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}?request=${payload.requestId}`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    requests: true,
  });
  redirect(destination);
}

export async function deleteRequestAction(formData: FormData) {
  const session = await requireSession();
  const payload = requestDeleteSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();
  const [request] = await db
    .select()
    .from(clientRequests)
    .where(
      and(
        eq(clientRequests.id, payload.requestId),
        eq(clientRequests.projectId, payload.projectId),
        eq(clientRequests.ownerId, session.user.id),
      ),
    )
    .limit(1);

  await assertProjectOwnership(payload.projectId, session.user.id);

  await db
    .delete(clientRequests)
    .where(
      and(
        eq(clientRequests.id, payload.requestId),
        eq(clientRequests.projectId, payload.projectId),
        eq(clientRequests.ownerId, session.user.id),
      ),
    );

  await touchProject(payload.projectId, now);

  if (request) {
    await logProjectActivity(db, {
      ownerId: session.user.id,
      projectId: payload.projectId,
      entityType: "request",
      entityId: payload.requestId,
      action: "deleted",
      label: "Deleted request",
      detail: request.title,
      createdAt: now,
    });
  }

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}/requests`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    requests: true,
  });
  redirect(destination);
}

export async function convertRequestToTaskAction(formData: FormData) {
  const session = await requireSession();
  const payload = convertRequestSchema.parse(toPayload(formData));
  const db = getDb();

  await assertProjectOwnership(payload.projectId, session.user.id);

  const [request] = await db
    .select()
    .from(clientRequests)
    .where(
      and(
        eq(clientRequests.id, payload.requestId),
        eq(clientRequests.projectId, payload.projectId),
        eq(clientRequests.ownerId, session.user.id),
      ),
    )
    .limit(1);

  if (!request) {
    throw new Error("Request not found.");
  }

  const [existingTask] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, payload.projectId),
        eq(tasks.ownerId, session.user.id),
        eq(tasks.requestId, request.id),
      ),
    )
    .limit(1);

  const now = new Date();

  if (!existingTask) {
    const sortOrder = await getNextTaskSortOrder(payload.projectId, "todo");
    const codeNumber = await nextTaskCodeNumber(payload.projectId);

    await db.insert(tasks).values({
      // Fresh id — do NOT reuse request.id, which would make a task's PK equal a
      // client_requests PK and break the global uniqueness of entity ids.
      id: crypto.randomUUID(),
      ownerId: session.user.id,
      projectId: payload.projectId,
      requestId: request.id,
      // Match createTaskInputSchema's max(140) so the converted task stays
      // editable through the normal update path.
      title: request.title.slice(0, 140),
      description: request.description ?? null,
      codeNumber,
      priority: request.priority,
      status: "todo",
      sortOrder,
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db
    .update(clientRequests)
    .set({
      status: "converted",
      updatedAt: now,
    })
    .where(eq(clientRequests.id, request.id));

  await touchProject(payload.projectId, now);
  await logProjectActivity(db, {
    ownerId: session.user.id,
    projectId: payload.projectId,
    entityType: "request",
    entityId: request.id,
    action: "converted",
    label: "Converted request to task",
    detail: request.title,
    createdAt: now,
  });

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    requests: true,
    board: true,
    clientBoard: true,
  });
  redirect(withFlash(destination, "request-converted"));
}

export async function createTaskAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = taskCreateSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();

  const project = await assertProjectTaskAccess(viewer, payload.projectId);

  const sortOrder = await getNextTaskSortOrder(payload.projectId, "todo");
  const taskId = crypto.randomUUID();
  const codeNumber = await nextTaskCodeNumber(payload.projectId);
  const code = formatTaskCode(project.slug, codeNumber);
  const category = await resolveCategoryById(payload.categoryId, payload.projectId);
  // Only link a client request that belongs to this same project; drop a
  // stale/cross-project request id rather than persisting a foreign link.
  let requestId: string | null = payload.requestId ?? null;
  if (requestId) {
    const [linkedRequest] = await db
      .select({ id: clientRequests.id })
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.id, requestId),
          eq(clientRequests.projectId, payload.projectId),
        ),
      )
      .limit(1);
    if (!linkedRequest) requestId = null;
  }

  await db.insert(tasks).values({
    id: taskId,
    ownerId: viewer.id,
    projectId: payload.projectId,
    requestId,
    title: payload.title,
    description: payload.description ?? null,
    codeNumber,
    categoryId: category.categoryId,
    categoryName: category.categoryName,
    categoryColor: category.categoryColor,
    phase: payload.phase ?? null,
    priority: payload.priority,
    dueDate: parseDate(payload.dueDate),
    status: "todo",
    sortOrder,
    statusChangedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await touchProject(payload.projectId, now);
  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: payload.projectId,
    entityType: "task",
    entityId: taskId,
    action: "created",
    label: "Created task",
    detail: code ? `${code} · ${payload.title}` : payload.title,
    createdAt: now,
  });

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    today: true,
    overview: true,
    board: true,
    clientBoard: true,
  });
  redirect(destination);
}

export async function updateTaskAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = taskUpdateSchema.parse(toPayload(formData));
  const db = getDb();

  await assertProjectTaskAccess(viewer, payload.projectId);

  const existingTask = await loadProjectTask(payload.taskId, payload.projectId);

  const nextSortOrder =
    existingTask.status === payload.status
      ? existingTask.sortOrder
      : await getNextTaskSortOrder(payload.projectId, payload.status);
  const now = new Date();

  const category = await resolveCategoryById(payload.categoryId, payload.projectId);
  const nextDueDate = parseDate(payload.dueDate);
  await db
    .update(tasks)
    .set({
      title: payload.title,
      description: payload.description ?? null,
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      categoryColor: category.categoryColor,
      phase: payload.phase ?? null,
      status: payload.status,
      priority: payload.priority,
      dueDate: nextDueDate,
      sortOrder: nextSortOrder,
      updatedAt: now,
    })
    .where(eq(tasks.id, payload.taskId));

  const changes = diffChanges([
    { field: "title", label: "Title", from: existingTask.title, to: payload.title },
    {
      field: "description",
      label: "Description",
      from: existingTask.description,
      to: payload.description ?? null,
      kind: "rich",
    },
    {
      field: "status",
      label: "Status",
      from: taskStatusLabel(existingTask.status),
      to: taskStatusLabel(payload.status),
    },
    {
      field: "priority",
      label: "Priority",
      from: priorityLabel(existingTask.priority),
      to: priorityLabel(payload.priority),
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
    { field: "phase", label: "Phase", from: existingTask.phase, to: payload.phase ?? null },
  ]);

  await touchProject(payload.projectId, now);
  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: payload.projectId,
    entityType: "task",
    entityId: payload.taskId,
    action: existingTask.status === payload.status ? "updated" : "moved",
    label:
      existingTask.status === payload.status
        ? "Updated task"
        : `Moved task to ${payload.status}`,
    detail: payload.title,
    changes,
    createdAt: now,
  });

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}?task=${payload.taskId}`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    today: true,
    overview: true,
    board: true,
    clientBoard: true,
  });
  redirect(destination);
}

export async function deleteTaskAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = taskDeleteSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();

  await assertProjectTaskAccess(viewer, payload.projectId);

  const [task] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, payload.taskId),
        eq(tasks.projectId, payload.projectId),
      ),
    )
    .limit(1);

  await db
    .delete(tasks)
    .where(
      and(
        eq(tasks.id, payload.taskId),
        eq(tasks.projectId, payload.projectId),
      ),
    );

  await touchProject(payload.projectId, now);

  if (task) {
    await logProjectActivity(db, {
      ownerId: viewer.id,
      projectId: payload.projectId,
      entityType: "task",
      entityId: payload.taskId,
      action: "deleted",
      label: "Deleted task",
      detail: task.title,
      createdAt: now,
    });
  }

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}/board`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    notes: true,
  });
  redirect(destination);
}

export async function saveProjectNoteAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = noteSchema.parse(toPayload(formData));

  await writeProjectNoteService(viewer, payload);

  const destination = safeReturnPath(
    payload.returnTo,
    `/projects/${payload.projectId}`,
  );

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    notes: true,
  });
  redirect(withFlash(destination, "note-saved"));
}

export async function createTaskChecklistItemAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = checklistCreateSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();

  await assertProjectTaskAccess(viewer, payload.projectId);
  await loadProjectTask(payload.taskId, payload.projectId);

  await db.insert(taskChecklistItems).values({
    id: crypto.randomUUID(),
    ownerId: viewer.id,
    projectId: payload.projectId,
    taskId: payload.taskId,
    content: payload.content,
    isCompleted: false,
    sortOrder: await getNextChecklistSortOrder(payload.taskId),
    createdAt: now,
    updatedAt: now,
  });

  await Promise.all([
    touchTask(payload.taskId, now),
    touchProject(payload.projectId, now),
  ]);

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: payload.projectId,
    entityType: "task",
    entityId: payload.taskId,
    action: "created",
    label: "Added subtask",
    detail: richExcerpt(payload.content),
    createdAt: now,
  });

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    board: true,
  });
  redirect(safeReturnPath(payload.returnTo, `/projects/${payload.projectId}`));
}

export async function toggleTaskChecklistItemAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = checklistToggleSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();

  await assertProjectTaskAccess(viewer, payload.projectId);
  await loadProjectTask(payload.taskId, payload.projectId);

  const [existingItem] = await db
    .select()
    .from(taskChecklistItems)
    .where(
      and(
        eq(taskChecklistItems.id, payload.checklistItemId),
        eq(taskChecklistItems.taskId, payload.taskId),
      ),
    )
    .limit(1);

  if (!existingItem) {
    throw new Error("Checklist item not found.");
  }

  const nextIsCompleted = !existingItem.isCompleted;
  await db
    .update(taskChecklistItems)
    .set({
      isCompleted: nextIsCompleted,
      completedAt: nextIsCompleted ? now : null,
      updatedAt: now,
    })
    .where(eq(taskChecklistItems.id, payload.checklistItemId));

  await Promise.all([
    touchTask(payload.taskId, now),
    touchProject(payload.projectId, now),
  ]);

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: payload.projectId,
    entityType: "task",
    entityId: payload.taskId,
    action: "updated",
    label: nextIsCompleted ? "Completed subtask" : "Reopened subtask",
    detail: richExcerpt(existingItem.content),
    changes: diffChanges([
      {
        field: "state",
        label: "Subtask",
        from: existingItem.isCompleted ? "Done" : "Open",
        to: nextIsCompleted ? "Done" : "Open",
      },
    ]),
    createdAt: now,
  });

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    board: true,
  });
  redirect(safeReturnPath(payload.returnTo, `/projects/${payload.projectId}`));
}

export async function deleteTaskChecklistItemAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = checklistDeleteSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();

  await assertProjectTaskAccess(viewer, payload.projectId);
  await loadProjectTask(payload.taskId, payload.projectId);

  const [removedItem] = await db
    .select({ content: taskChecklistItems.content })
    .from(taskChecklistItems)
    .where(
      and(
        eq(taskChecklistItems.id, payload.checklistItemId),
        eq(taskChecklistItems.taskId, payload.taskId),
      ),
    )
    .limit(1);

  await db
    .delete(taskChecklistItems)
    .where(
      and(
        eq(taskChecklistItems.id, payload.checklistItemId),
        eq(taskChecklistItems.taskId, payload.taskId),
      ),
    );

  await Promise.all([
    touchTask(payload.taskId, now),
    touchProject(payload.projectId, now),
  ]);

  if (removedItem) {
    await logProjectActivity(db, {
      ownerId: viewer.id,
      projectId: payload.projectId,
      entityType: "task",
      entityId: payload.taskId,
      action: "deleted",
      label: "Removed subtask",
      detail: richExcerpt(removedItem.content),
      createdAt: now,
    });
  }

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    board: true,
  });
  redirect(safeReturnPath(payload.returnTo, `/projects/${payload.projectId}`));
}

export async function saveTaskStatusUpdateAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = taskStatusUpdateSchema.parse(toPayload(formData));

  await publishStatusUpdateService(viewer, payload);

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    board: true,
    clientBoard: true,
  });
  redirect(
    withFlash(
      safeReturnPath(payload.returnTo, `/projects/${payload.projectId}`),
      "status-published",
    ),
  );
}

export async function deleteTaskStatusUpdateAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = taskStatusUpdateDeleteSchema.parse(toPayload(formData));

  await deleteStatusUpdateService(viewer, payload);

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    board: true,
    clientBoard: true,
  });
  redirect(
    withFlash(
      safeReturnPath(payload.returnTo, `/projects/${payload.projectId}`),
      "status-removed",
    ),
  );
}

// ---- Comments ---------------------------------------------------------------

const richTextContent = z
  .string()
  .min(1)
  .refine((value) => !richTextIsEmpty(parseRichText(value)), {
    message: "Comment cannot be empty.",
  });

const commentCreateSchema = z.object({
  projectId: z.string().min(1),
  parentId: z.string().min(1),
  content: richTextContent,
});

const commentUpdateSchema = z.object({
  commentId: z.string().min(1),
  content: richTextContent,
});

const commentDeleteSchema = z.object({
  commentId: z.string().min(1),
});

// Short plain-text preview of rich-text content for an activity-log detail line.
// Used by the checklist web actions below (comment excerpts now live in the
// comments service).
function richExcerpt(content: string): string {
  const text = richTextToPlainText(parseRichText(content));
  if (text.length <= 80) return text;
  return `${text.slice(0, 77).trimEnd()}…`;
}

export async function createTaskCommentAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = commentCreateSchema.parse(toPayload(formData));

  await createTaskCommentService(viewer, {
    projectId: payload.projectId,
    taskId: payload.parentId,
    content: payload.content,
  });

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    board: true,
  });
}

export async function updateTaskCommentAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = commentUpdateSchema.parse(toPayload(formData));

  const { projectId } = await updateTaskCommentService(viewer, payload);

  revalidateProjectViews(projectId, { overview: true, board: true });
}

export async function deleteTaskCommentAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = commentDeleteSchema.parse(toPayload(formData));

  const { projectId } = await deleteTaskCommentService(viewer, payload);

  if (projectId) revalidateProjectViews(projectId, { overview: true, board: true });
}

export async function createRequestCommentAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = commentCreateSchema.parse(toPayload(formData));

  await createRequestCommentService(viewer, {
    projectId: payload.projectId,
    requestId: payload.parentId,
    content: payload.content,
  });

  revalidateProjectViews(payload.projectId, {
    projects: true,
    overview: true,
    requests: true,
  });
}

export async function updateRequestCommentAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = commentUpdateSchema.parse(toPayload(formData));

  const { projectId } = await updateRequestCommentService(viewer, payload);

  revalidateProjectViews(projectId, { overview: true, requests: true });
}

export async function deleteRequestCommentAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = commentDeleteSchema.parse(toPayload(formData));

  const { projectId } = await deleteRequestCommentService(viewer, payload);

  if (projectId) revalidateProjectViews(projectId, { overview: true, requests: true });
}

// ---- Task categories --------------------------------------------------------

const categoryNameSchema = z.string().trim().min(1).max(40);
const categoryColorSchema = z
  .string()
  .trim()
  .refine(isValidProjectColor, {
    message: "Color must be a swatch from the palette.",
  });

const categoryCreateSchema = z.object({
  projectId: z.string().min(1),
  name: categoryNameSchema,
  color: categoryColorSchema,
});

const categoryUpdateSchema = z.object({
  categoryId: z.string().min(1),
  name: categoryNameSchema,
  color: categoryColorSchema,
});

const categoryDeleteSchema = z.object({
  categoryId: z.string().min(1),
});

export async function createTaskCategoryAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = categoryCreateSchema.parse(toPayload(formData));

  const { categoryId, name, color } = await createTaskCategoryService(
    viewer,
    payload,
  );

  revalidateProjectViews(payload.projectId, {
    overview: true,
    board: true,
    settings: true,
  });

  // The category-select client component reads `id` to update its local list.
  return { id: categoryId, name, color };
}

export async function updateTaskCategoryAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = categoryUpdateSchema.parse(toPayload(formData));

  const { projectId } = await updateTaskCategoryService(viewer, payload);

  revalidateProjectViews(projectId, {
    overview: true,
    board: true,
    settings: true,
  });
}

export async function deleteTaskCategoryAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = categoryDeleteSchema.parse(toPayload(formData));

  const { projectId } = await deleteTaskCategoryService(viewer, payload);

  revalidateProjectViews(projectId, {
    overview: true,
    board: true,
    settings: true,
  });
}

// ---- Task labels ------------------------------------------------------------

const labelNameSchema = z.string().trim().min(1).max(40);
const labelColorSchema = z
  .string()
  .trim()
  .refine(isValidProjectColor, {
    message: "Color must be a swatch from the palette.",
  });

const labelCreateSchema = z.object({
  projectId: z.string().min(1),
  name: labelNameSchema,
  color: labelColorSchema,
});

const labelUpdateSchema = z.object({
  labelId: z.string().min(1),
  name: labelNameSchema,
  color: labelColorSchema,
});

const labelDeleteSchema = z.object({
  labelId: z.string().min(1),
});

export async function createTaskLabelAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = labelCreateSchema.parse(toPayload(formData));

  const { labelId, name, color } = await createTaskLabelService(viewer, payload);

  revalidateProjectViews(payload.projectId, {
    overview: true,
    board: true,
    settings: true,
  });

  // The label-select client component reads `id` to update its local list.
  return { id: labelId, name, color };
}

export async function updateTaskLabelAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = labelUpdateSchema.parse(toPayload(formData));

  const { projectId } = await updateTaskLabelService(viewer, payload);

  revalidateProjectViews(projectId, {
    overview: true,
    board: true,
    settings: true,
  });
}

export async function deleteTaskLabelAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = labelDeleteSchema.parse(toPayload(formData));

  const { projectId } = await deleteTaskLabelService(viewer, payload);

  revalidateProjectViews(projectId, {
    overview: true,
    board: true,
    settings: true,
  });
}

// ---- Notifications ----------------------------------------------------------

const markNotificationSchema = z.object({
  notificationId: z.string().min(1),
});

/**
 * Persist that the viewer has read a derived notification. INSERT OR IGNORE
 * keeps it idempotent — clicking the same row twice is a no-op.
 */
export async function markNotificationReadAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = markNotificationSchema.parse(toPayload(formData));
  const db = getDb();

  // Stored notifications carry their own readAt; computed ones use the
  // notification_reads ledger keyed by their stable derived id.
  if (payload.notificationId.startsWith("stored-")) {
    const rowId = payload.notificationId.slice("stored-".length);
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, rowId),
          eq(notifications.recipientId, viewer.id),
          isNull(notifications.readAt),
        ),
      );
    return;
  }

  await db
    .insert(notificationReads)
    .values({
      id: crypto.randomUUID(),
      userId: viewer.id,
      notificationId: payload.notificationId,
      readAt: new Date(),
    })
    .onConflictDoNothing({
      target: [notificationReads.userId, notificationReads.notificationId],
    });
}

/* ---------------------------------------------------------------------------
 * Daily Ops — per-user, per-day planned work items.
 * ------------------------------------------------------------------------ */

// FormData booleans arrive as "true"/"on" (checkbox) or absent.
const optionalBool = z
  .union([z.literal("true"), z.literal("on"), z.literal("false"), z.literal("")])
  .optional()
  .transform((value) => value === "true" || value === "on");

const dailyTaskCreateSchema = z.object({
  title: z.string().trim().min(1).max(140),
  description: optionalText,
  plannedDate: z.string().trim().min(1),
  kind: z.enum(dailyTaskKindValues).default("adhoc"),
  status: z.enum(taskStatusValues).default("todo"),
  priority: z.enum(priorityValues).default("medium"),
  projectId: optionalText,
  // Pull: reference an existing board task as a live reference.
  linkedTaskId: optionalText,
  // Push: also create a new card on the project's Execution Board.
  bindToBoard: optionalBool,
  returnTo: optionalText,
});

const dailyTaskUpdateSchema = z.object({
  dailyTaskId: z.string().min(1),
  title: z.string().trim().min(1).max(140),
  description: optionalText,
  status: z.enum(taskStatusValues),
  priority: z.enum(priorityValues),
  plannedDate: optionalText,
  returnTo: optionalText,
});

const dailyTaskDeleteSchema = z.object({
  dailyTaskId: z.string().min(1),
  returnTo: optionalText,
});

const dailyTaskToggleSchema = z.object({
  dailyTaskId: z.string().min(1),
  status: z.enum(taskStatusValues).optional(),
});

function dailyDateHref(date: Date, flash?: "created" | "updated" | "removed") {
  return withSearchParams("/daily", {
    date: formatDateKey(date),
    flash: flash ?? null,
  });
}

function revalidateDailyOps() {
  revalidatePath("/daily");
  revalidatePath("/admin/daily");
}

async function getNextDailyTaskSortOrder(ownerId: string, plannedDate: Date) {
  const db = getDb();
  const [latest] = await db
    .select({ sortOrder: dailyTasks.sortOrder })
    .from(dailyTasks)
    .where(
      and(
        eq(dailyTasks.ownerId, ownerId),
        eq(dailyTasks.plannedDate, plannedDate),
      ),
    )
    .orderBy(desc(dailyTasks.sortOrder))
    .limit(1);
  return (latest?.sortOrder ?? -1) + 1;
}

async function assertDailyTaskAccess(
  dailyTaskId: string,
  viewer: Awaited<ReturnType<typeof requireViewer>>,
) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(dailyTasks)
    .where(eq(dailyTasks.id, dailyTaskId))
    .limit(1);
  if (!row || (row.ownerId !== viewer.id && !isAdminTier(viewer.role))) {
    throw new Error("Daily task not found.");
  }
  return row;
}

function cycleDailyStatus(
  status: (typeof taskStatusValues)[number],
): (typeof taskStatusValues)[number] {
  if (status === "todo") return "doing";
  if (status === "doing") return "done";
  return "todo";
}

export async function createDailyTaskAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = dailyTaskCreateSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();
  const plannedDate = parseDateKey(payload.plannedDate);
  const ownerId = viewer.id;

  let projectId: string | null = null;
  let linkedTaskId: string | null = null;

  if (payload.kind === "project") {
    if (!payload.projectId) {
      throw new Error("Pick a project for a project task.");
    }
    projectId = payload.projectId;

    if (payload.linkedTaskId) {
      // Pull: reference an existing board task as a live reference.
      if (!(await canAccessProject(viewer, projectId))) {
        throw new Error("Project not found.");
      }
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, payload.linkedTaskId),
            eq(tasks.projectId, projectId),
          ),
        )
        .limit(1);
      if (!task) {
        throw new Error("Linked task not found in that project.");
      }
      linkedTaskId = task.id;
    } else if (payload.bindToBoard) {
      // Push: create a fresh card on the project's Execution Board.
      const project = await assertProjectOwnership(projectId, viewer.id);
      const sortOrder = await getNextTaskSortOrder(projectId, "todo");
      const newTaskId = crypto.randomUUID();
      const codeNumber = await nextTaskCodeNumber(projectId);
      const code = formatTaskCode(project.slug, codeNumber);

      await db.insert(tasks).values({
        id: newTaskId,
        ownerId: viewer.id,
        projectId,
        assigneeId: ownerId,
        title: payload.title,
        description: payload.description ?? null,
        codeNumber,
        priority: payload.priority,
        status: "todo",
        sortOrder,
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await touchProject(projectId, now);
      await logProjectActivity(db, {
        ownerId: viewer.id,
        projectId,
        entityType: "task",
        entityId: newTaskId,
        action: "created",
        label: "Created task",
        detail: code ? `${code} · ${payload.title}` : payload.title,
        createdAt: now,
      });
      revalidateProjectViews(projectId, {
        projects: true,
        today: true,
        overview: true,
        board: true,
        clientBoard: true,
      });
      linkedTaskId = newTaskId;
    }
    // else: project item left unbound — grouping only, no board card.
  }

  const sortOrder = await getNextDailyTaskSortOrder(ownerId, plannedDate);
  await db.insert(dailyTasks).values({
    id: crypto.randomUUID(),
    ownerId,
    createdById: viewer.id,
    plannedDate,
    title: payload.title,
    description: payload.description ?? null,
    status: payload.status,
    priority: payload.priority,
    kind: payload.kind,
    projectId,
    linkedTaskId,
    sortOrder,
    batchId: null,
    createdAt: now,
    updatedAt: now,
  });

  revalidateDailyOps();
  redirect(safeReturnPath(payload.returnTo, dailyDateHref(plannedDate, "created")));
}

export async function updateDailyTaskAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = dailyTaskUpdateSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();

  const existing = await assertDailyTaskAccess(payload.dailyTaskId, viewer);
  const plannedDate = payload.plannedDate
    ? parseDateKey(payload.plannedDate)
    : existing.plannedDate;

  // Moving to another day appends it to the end of that day's column.
  const sortOrder =
    plannedDate.getTime() === existing.plannedDate.getTime()
      ? existing.sortOrder
      : await getNextDailyTaskSortOrder(existing.ownerId, plannedDate);

  // Decoupled by design: never writes to the linked board task.
  await db
    .update(dailyTasks)
    .set({
      title: payload.title,
      description: payload.description ?? null,
      status: payload.status,
      priority: payload.priority,
      plannedDate,
      sortOrder,
      updatedAt: now,
    })
    .where(eq(dailyTasks.id, payload.dailyTaskId));

  // Notify the admin who assigned this if the owner edited it.
  if (existing.createdById && existing.createdById !== existing.ownerId) {
    await createNotification(db, {
      recipientId: existing.createdById,
      actorId: viewer.id,
      type: "daily_task_user_edited",
      tone: "default",
      title: `"${payload.title}" was edited`,
      body: `${viewer.name} edited a task you assigned for ${formatDateKey(plannedDate)}`,
      href: dailyDateHref(plannedDate),
      entityType: "daily_task",
      entityId: payload.dailyTaskId,
    });
  }

  revalidateDailyOps();
  redirect(safeReturnPath(payload.returnTo, dailyDateHref(plannedDate, "updated")));
}

export async function deleteDailyTaskAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = dailyTaskDeleteSchema.parse(toPayload(formData));
  const db = getDb();

  const existing = await assertDailyTaskAccess(payload.dailyTaskId, viewer);
  // Deletes the planner row only; any linked board card survives (FK SET NULL).
  await db.delete(dailyTasks).where(eq(dailyTasks.id, payload.dailyTaskId));

  // Notify the admin who assigned this if the owner deleted it.
  if (existing.createdById && existing.createdById !== existing.ownerId) {
    await createNotification(db, {
      recipientId: existing.createdById,
      actorId: viewer.id,
      type: "daily_task_user_deleted",
      tone: "warning",
      title: `"${existing.title}" was removed`,
      body: `${viewer.name} deleted a task you assigned for ${formatDateKey(existing.plannedDate)}`,
      href: dailyDateHref(existing.plannedDate),
      entityType: "daily_task",
      entityId: payload.dailyTaskId,
    });
  }

  revalidateDailyOps();
  redirect(
    safeReturnPath(payload.returnTo, dailyDateHref(existing.plannedDate, "removed")),
  );
}

export async function toggleDailyTaskStatusAction(formData: FormData) {
  const viewer = await requireViewer();
  const payload = dailyTaskToggleSchema.parse(toPayload(formData));
  const db = getDb();

  const existing = await assertDailyTaskAccess(payload.dailyTaskId, viewer);
  const nextStatus = payload.status ?? cycleDailyStatus(existing.status);

  await db
    .update(dailyTasks)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(dailyTasks.id, payload.dailyTaskId));

  revalidateDailyOps();
}

/* ---------------------------------------------------------------------------
 * Daily Ops — admin: plan work for other users (single or fan-out).
 * ------------------------------------------------------------------------ */

const adminDailyAssignSchema = z.object({
  title: z.string().trim().min(1).max(140),
  description: optionalText,
  plannedDate: z.string().trim().min(1),
  kind: z.enum(dailyTaskKindValues).default("adhoc"),
  status: z.enum(taskStatusValues).default("todo"),
  priority: z.enum(priorityValues).default("medium"),
  projectId: optionalText,
  linkedTaskId: optionalText,
  bindToBoard: optionalBool,
  target: z.enum(["all", "selective"]).default("selective"),
  // JSON array of user ids, e.g. ["id1","id2"].
  userIds: optionalText,
  returnTo: optionalText,
});

const adminDailyDeleteSchema = z.object({
  dailyTaskId: z.string().min(1),
  cascadeBatch: optionalBool,
  returnTo: optionalText,
});

function parseUserIds(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === "string");
    }
  } catch {
    // Fall back to comma-separated.
    return value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }
  return [];
}

export async function adminCreateDailyTaskForUsersAction(formData: FormData) {
  const viewer = await requireRole(["owner", "admin"]);
  const payload = adminDailyAssignSchema.parse(toPayload(formData));
  const db = getDb();
  const now = new Date();
  const plannedDate = parseDateKey(payload.plannedDate);

  // Resolve recipients.
  let recipientIds: string[];
  if (payload.target === "all") {
    const rows = await db.select({ id: user.id }).from(user);
    recipientIds = rows.map((row) => row.id);
  } else {
    recipientIds = parseUserIds(payload.userIds);
  }
  if (recipientIds.length === 0) {
    throw new Error("Pick at least one person to assign to.");
  }

  // For a project push we need the project's slug to format codes.
  let project: typeof projects.$inferSelect | null = null;
  if (payload.kind === "project" && payload.projectId) {
    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, payload.projectId))
      .limit(1);
    if (!row) throw new Error("Project not found.");
    project = row;
  }

  // Validate a pull reference once (shared by all recipients).
  let sharedLinkedTaskId: string | null = null;
  if (payload.kind === "project" && payload.projectId && payload.linkedTaskId) {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, payload.linkedTaskId),
          eq(tasks.projectId, payload.projectId),
        ),
      )
      .limit(1);
    if (!task) throw new Error("Linked task not found in that project.");
    sharedLinkedTaskId = task.id;
  }

  const batchId = recipientIds.length > 1 ? crypto.randomUUID() : null;
  const touchedProjects = new Set<string>();
  const notificationInputs: NotificationInput[] = [];
  const plannedKey = formatDateKey(plannedDate);

  for (const recipientId of recipientIds) {
    let linkedTaskId: string | null = sharedLinkedTaskId;

    // Push: one fresh board card per recipient (codes are sequential per
    // project, so allocate inside the loop rather than batching).
    if (
      payload.kind === "project" &&
      project &&
      payload.bindToBoard &&
      !sharedLinkedTaskId
    ) {
      const sortOrder = await getNextTaskSortOrder(project.id, "todo");
      const newTaskId = crypto.randomUUID();
      const codeNumber = await nextTaskCodeNumber(project.id);
      const code = formatTaskCode(project.slug, codeNumber);
      await db.insert(tasks).values({
        id: newTaskId,
        ownerId: project.ownerId,
        projectId: project.id,
        assigneeId: recipientId,
        title: payload.title,
        description: payload.description ?? null,
        codeNumber,
        priority: payload.priority,
        status: "todo",
        sortOrder,
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await logProjectActivity(db, {
        ownerId: viewer.id,
        projectId: project.id,
        entityType: "task",
        entityId: newTaskId,
        action: "created",
        label: "Created task",
        detail: code ? `${code} · ${payload.title}` : payload.title,
        createdAt: now,
      });
      touchedProjects.add(project.id);
      linkedTaskId = newTaskId;
    }

    const sortOrder = await getNextDailyTaskSortOrder(recipientId, plannedDate);
    await db.insert(dailyTasks).values({
      id: crypto.randomUUID(),
      ownerId: recipientId,
      createdById: viewer.id,
      plannedDate,
      title: payload.title,
      description: payload.description ?? null,
      status: payload.status,
      priority: payload.priority,
      kind: payload.kind,
      projectId: payload.kind === "project" ? payload.projectId ?? null : null,
      linkedTaskId,
      sortOrder,
      batchId,
      createdAt: now,
      updatedAt: now,
    });

    notificationInputs.push({
      recipientId,
      actorId: viewer.id,
      type: "daily_task_assigned",
      tone: "default",
      title: `New daily task: "${payload.title}"`,
      body: `${viewer.name} added this to your ${plannedKey} plan`,
      href: withSearchParams("/daily", { date: plannedKey }),
      entityType: "daily_task",
      entityId: recipientId,
    });
  }

  // One notification per recipient; self-assignment is skipped in the helper.
  await createNotifications(db, notificationInputs);

  for (const projectId of touchedProjects) {
    await touchProject(projectId, now);
    revalidateProjectViews(projectId, {
      projects: true,
      today: true,
      overview: true,
      board: true,
    });
  }

  revalidateDailyOps();
  redirect(
    safeReturnPath(
      payload.returnTo,
      withSearchParams("/admin/daily", {
        date: formatDateKey(plannedDate),
        flash: "assigned",
      }),
    ),
  );
}

export async function adminDeleteDailyTaskAction(formData: FormData) {
  const viewer = await requireRole(["owner", "admin"]);
  const payload = adminDailyDeleteSchema.parse(toPayload(formData));
  const db = getDb();

  const [existing] = await db
    .select()
    .from(dailyTasks)
    .where(eq(dailyTasks.id, payload.dailyTaskId))
    .limit(1);
  if (!existing) throw new Error("Daily task not found.");

  if (payload.cascadeBatch && existing.batchId) {
    await db.delete(dailyTasks).where(eq(dailyTasks.batchId, existing.batchId));
  } else {
    await db.delete(dailyTasks).where(eq(dailyTasks.id, payload.dailyTaskId));
  }

  // viewer is used implicitly via the role gate above.
  void viewer;
  revalidateDailyOps();
  redirect(
    safeReturnPath(
      payload.returnTo,
      withSearchParams("/admin/daily", {
        date: formatDateKey(existing.plannedDate),
        flash: "removed",
      }),
    ),
  );
}
