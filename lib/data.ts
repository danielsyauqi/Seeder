// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { cache } from "react";

import { getDb } from "@/lib/db";
import {
  activityActionValues,
  clientRequests,
  dailyTasks,
  notificationReads,
  notifications,
  projectActivity,
  projectMembers,
  projectNotes,
  projectStatusUpdates,
  projects,
  requestComments,
  taskCategories,
  taskChecklistItems,
  taskComments,
  taskLabels,
  taskTaskLabels,
  tasks,
  user,
} from "@/lib/db/schema";
import { formatRequestCode, formatTaskCode } from "@/lib/codes";
import { formatProjectStatus } from "@/lib/project-status";
import { rewriteRichTextUploadSrc } from "@/lib/rich-text";
import { withSearchParams } from "@/lib/utils";
import { isAdminTier } from "@/lib/auth-server";
import { canAccessProject, getPersonalProjectIds } from "@/lib/authz";
import type { ActivityChange, UserRole } from "@/lib/db/schema";

type ProjectViewer = { id: string; role: UserRole };

function createRequestCounts() {
  return {
    total: 0,
    inbox: 0,
    reviewed: 0,
    converted: 0,
    closed: 0,
  };
}

function createTaskCounts() {
  return {
    total: 0,
    todo: 0,
    doing: 0,
    done: 0,
    overdue: 0,
  };
}

function getDayDistance(target: Date, today: Date) {
  const targetDay = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
  );

  return Math.ceil((targetDay.getTime() - today.getTime()) / 86_400_000);
}

function getStartOfDay(value = new Date()) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function formatLocalDateKey(date: Date) {
  // YYYY-MM-DD in local TZ. en-CA forces ISO format and is supported in Workers runtime.
  return date.toLocaleDateString("en-CA");
}

function bucketLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0 || max === 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function getTaskHref(projectId: string, taskId: string) {
  return withSearchParams(`/projects/${projectId}/board`, {
    modal: "task",
    task: taskId,
  });
}

function getTaskStatusUpdateHref(projectId: string, taskId: string) {
  return withSearchParams(`/projects/${projectId}/board`, {
    modal: "status-update",
    task: taskId,
  });
}

function getRequestHref(projectId: string, requestId: string) {
  return withSearchParams(`/projects/${projectId}/requests`, {
    modal: "request",
    request: requestId,
  });
}

function getNoteHref(projectId: string) {
  return withSearchParams(`/projects/${projectId}/notes`, {
    modal: "notes",
  });
}

function getProjectHref(projectId: string) {
  return `/projects/${projectId}`;
}

function normalizeSearchText(parts: Array<string | null | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

function buildProjectStats(
  projectList: Awaited<ReturnType<typeof listProjectsForUser>>,
  requestsForOwner: Awaited<ReturnType<typeof getRequestsForUser>>,
  tasksForOwner: Awaited<ReturnType<typeof getTasksForUser>>,
) {
  const now = new Date();
  const today = getStartOfDay(now);
  const requestCountsByProject = new Map<
    string,
    ReturnType<typeof createRequestCounts>
  >();
  const taskCountsByProject = new Map<string, ReturnType<typeof createTaskCounts>>();

  for (const request of requestsForOwner) {
    const counts =
      requestCountsByProject.get(request.projectId) ?? createRequestCounts();

    counts.total += 1;

    if (request.status === "new") {
      counts.inbox += 1;
    } else if (request.status === "reviewed") {
      counts.reviewed += 1;
      counts.inbox += 1;
    } else if (request.status === "converted") {
      counts.converted += 1;
    } else if (request.status === "closed") {
      counts.closed += 1;
    }

    requestCountsByProject.set(request.projectId, counts);
  }

  for (const task of tasksForOwner) {
    const counts = taskCountsByProject.get(task.projectId) ?? createTaskCounts();

    counts.total += 1;

    if (task.status === "todo") {
      counts.todo += 1;
    } else if (task.status === "doing") {
      counts.doing += 1;
    } else if (task.status === "done") {
      counts.done += 1;
    }

    if (
      task.dueDate &&
      task.dueDate.getTime() < now.getTime() &&
      task.status !== "done"
    ) {
      counts.overdue += 1;
    }

    taskCountsByProject.set(task.projectId, counts);
  }

  return projectList.map((project) => {
    const requestCounts =
      requestCountsByProject.get(project.id) ?? createRequestCounts();
    const taskCounts = taskCountsByProject.get(project.id) ?? createTaskCounts();
    const openTasks = taskCounts.todo + taskCounts.doing;
    const completionRate = taskCounts.total
      ? Math.round((taskCounts.done / taskCounts.total) * 100)
      : 0;
    const daysUntilDeadline = project.deadline
      ? getDayDistance(project.deadline, today)
      : null;
    const isOverdue =
      project.deadline !== null &&
      daysUntilDeadline !== null &&
      daysUntilDeadline < 0 &&
      project.status !== "completed";

    return {
      ...project,
      requestCounts,
      taskCounts,
      openTasks,
      completionRate,
      daysUntilDeadline,
      isOverdue,
      pressureScore: openTasks + requestCounts.inbox * 2 + taskCounts.overdue * 3,
    };
  });
}

function buildSummary(projectList: ReturnType<typeof buildProjectStats>) {
  const totals = {
    totalProjects: projectList.length,
    inboxRequests: projectList.reduce(
      (sum, project) => sum + project.requestCounts.inbox,
      0,
    ),
    tasksTodo: projectList.reduce((sum, project) => sum + project.taskCounts.todo, 0),
    tasksInProgress: projectList.reduce(
      (sum, project) => sum + project.taskCounts.doing,
      0,
    ),
    totalTasks: projectList.reduce(
      (sum, project) => sum + project.taskCounts.total,
      0,
    ),
    completedTasks: projectList.reduce(
      (sum, project) => sum + project.taskCounts.done,
      0,
    ),
    overdueProjects: projectList.filter((project) => project.isOverdue).length,
    completionRate: 0,
  };

  totals.completionRate = totals.totalTasks
    ? Math.round((totals.completedTasks / totals.totalTasks) * 100)
    : 0;

  return totals;
}

const getAllProjectsForUser = cache(async (userId: string) => {
  const db = getDb();
  const ids = await getPersonalProjectIds(userId);
  if (ids.length === 0) return [];

  return db
    .select()
    .from(projects)
    .where(inArray(projects.id, ids))
    .orderBy(desc(projects.updatedAt), asc(projects.name));
});

const getRequestsForUser = cache(async (userId: string) => {
  const db = getDb();
  const ids = await getPersonalProjectIds(userId);
  if (ids.length === 0) return [];

  return db
    .select()
    .from(clientRequests)
    .where(inArray(clientRequests.projectId, ids));
});

const getTasksForUser = cache(async (userId: string) => {
  const db = getDb();
  const ids = await getPersonalProjectIds(userId);
  if (ids.length === 0) return [];

  return db.select().from(tasks).where(inArray(tasks.projectId, ids));
});

const getStatusUpdatesForUser = cache(async (userId: string) => {
  const db = getDb();
  const ids = await getPersonalProjectIds(userId);
  if (ids.length === 0) return [];

  return db
    .select()
    .from(projectStatusUpdates)
    .where(inArray(projectStatusUpdates.projectId, ids));
});

const getCompletedSubtasksForUser = cache(async (userId: string) => {
  const db = getDb();
  const ids = await getPersonalProjectIds(userId);
  if (ids.length === 0) return [];

  return db
    .select({
      id: taskChecklistItems.id,
      completedAt: taskChecklistItems.completedAt,
    })
    .from(taskChecklistItems)
    .where(
      and(
        inArray(taskChecklistItems.projectId, ids),
        eq(taskChecklistItems.isCompleted, true),
      ),
    );
});

const getRecentActivityRowsForUser = cache(async (userId: string) => {
  const db = getDb();
  const ids = await getPersonalProjectIds(userId);
  if (ids.length === 0) return [];

  const cutoff = new Date(Date.now() - 365 * 86_400_000);

  return db
    .select({
      id: projectActivity.id,
      projectId: projectActivity.projectId,
      createdAt: projectActivity.createdAt,
    })
    .from(projectActivity)
    .where(
      and(
        inArray(projectActivity.projectId, ids),
        gte(projectActivity.createdAt, cutoff),
      ),
    );
});

const getOwnerWorkspaceCollections = cache(async (userId: string) => {
  const [allProjects, requestsForOwner, tasksForOwner, statusUpdatesForOwner] =
    await Promise.all([
      getAllProjectsForUser(userId),
      getRequestsForUser(userId),
      getTasksForUser(userId),
      getStatusUpdatesForUser(userId),
    ]);

  return {
    allProjects,
    requestsForOwner,
    tasksForOwner,
    statusUpdatesForOwner,
  };
});

/**
 * Workspace-wide collections (every project, every request, every task).
 * Used by admin-tier viewers on /projects + sidebar so they can browse
 * the whole workspace from regular nav. Cached per request.
 */
const getAllWorkspaceCollections = cache(async () => {
  const db = getDb();
  const [allProjects, requestsForOwner, tasksForOwner, statusUpdatesForOwner] =
    await Promise.all([
      db
        .select()
        .from(projects)
        .orderBy(desc(projects.updatedAt), asc(projects.name)),
      db.select().from(clientRequests),
      db.select().from(tasks),
      db.select().from(projectStatusUpdates),
    ]);

  return {
    allProjects,
    requestsForOwner,
    tasksForOwner,
    statusUpdatesForOwner,
  };
});

async function getCollectionsForViewer(viewer: ProjectViewer) {
  return isAdminTier(viewer.role)
    ? getAllWorkspaceCollections()
    : getOwnerWorkspaceCollections(viewer.id);
}

function buildSearchIndex(
  projectList: Awaited<ReturnType<typeof listProjectsForUser>>,
  requestsForOwner: Awaited<ReturnType<typeof getRequestsForUser>>,
  tasksForOwner: Awaited<ReturnType<typeof getTasksForUser>>,
) {
  const projectMap = new Map(projectList.map((project) => [project.id, project]));

  const projectItems = projectList.map((project) => ({
    id: `project-${project.id}`,
    kind: "project" as const,
    title: project.name,
    subtitle: project.clientName || project.summary || "Project workspace",
    code: project.slug ?? null,
    href: `/projects/${project.id}`,
    projectId: project.id,
    projectName: project.name,
    projectColor: project.color ?? null,
    status: formatProjectStatus(project.status),
    archived: Boolean(project.archivedAt),
    updatedAt: project.updatedAt.getTime(),
    searchText: normalizeSearchText([
      project.name,
      project.slug,
      project.clientName,
      project.summary,
      formatProjectStatus(project.status),
      project.archivedAt ? "archived" : "open",
    ]),
  }));

  const requestItems = requestsForOwner
    .map((request) => {
      const project = projectMap.get(request.projectId);

      if (!project) {
        return null;
      }

      const code = formatRequestCode(project.slug, request.codeNumber);
      return {
        id: `request-${request.id}`,
        kind: "request" as const,
        title: request.title,
        subtitle: `${project.name} • ${request.status}`,
        code,
        href: getRequestHref(request.projectId, request.id),
        projectId: request.projectId,
        projectName: project.name,
        projectColor: project.color ?? null,
        status: request.status,
        archived: Boolean(project.archivedAt),
        updatedAt: request.updatedAt.getTime(),
        searchText: normalizeSearchText([
          request.title,
          request.description,
          request.status,
          request.priority,
          project.name,
          project.clientName,
          code,
        ]),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const taskItems = tasksForOwner
    .map((task) => {
      const project = projectMap.get(task.projectId);

      if (!project) {
        return null;
      }

      const code = formatTaskCode(project.slug, task.codeNumber);
      return {
        id: `task-${task.id}`,
        kind: "task" as const,
        title: task.title,
        subtitle: `${project.name} • ${task.status}`,
        code,
        href: getTaskHref(task.projectId, task.id),
        projectId: task.projectId,
        projectName: project.name,
        projectColor: project.color ?? null,
        status: task.status,
        archived: Boolean(project.archivedAt),
        updatedAt: task.updatedAt.getTime(),
        searchText: normalizeSearchText([
          task.title,
          task.description,
          task.status,
          task.priority,
          task.categoryName,
          task.phase,
          project.name,
          project.clientName,
          code,
        ]),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return [...projectItems, ...requestItems, ...taskItems].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

// Notifications older than this drop off automatically.
const NOTIFICATION_TTL_MS = 30 * 86_400_000;

function buildNotifications(
  projectList: Awaited<ReturnType<typeof listProjectsForUser>>,
  requestsForOwner: Awaited<ReturnType<typeof getRequestsForUser>>,
  tasksForOwner: Awaited<ReturnType<typeof getTasksForUser>>,
  statusUpdates: Awaited<ReturnType<typeof getStatusUpdatesForUser>>,
  assignedTaskActivity: Array<{
    id: string;
    taskId: string;
    actorName: string;
    label: string;
    detail: string | null;
    createdAt: Date;
  }>,
  readMap: Map<string, Date>,
) {
  const projectMap = new Map(projectList.map((project) => [project.id, project]));
  const taskMap = new Map(tasksForOwner.map((task) => [task.id, task]));
  const publishedTaskIds = new Set(statusUpdates.map((update) => update.taskId));
  // A request linked to a task is already in execution — don't double-notify.
  const linkedRequestIds = new Set(
    tasksForOwner
      .map((task) => task.requestId)
      .filter((id): id is string => Boolean(id)),
  );
  const today = getStartOfDay(new Date());
  const endOfToday = new Date(today.getTime() + 86_400_000);
  const ttlCutoff = new Date(Date.now() - NOTIFICATION_TTL_MS);

  const items = [
    ...requestsForOwner
      .filter(
        (request) =>
          projectMap.has(request.projectId) &&
          !linkedRequestIds.has(request.id) &&
          (request.status === "new" || request.status === "reviewed"),
      )
      .map((request) => {
        const project = projectMap.get(request.projectId)!;
        const code = formatRequestCode(project.slug, request.codeNumber);

        return {
          id: `request-${request.id}`,
          tone: "default" as const,
          title: code ? `${code} · ${request.title}` : request.title,
          detail: `Request waiting in ${project.name}`,
          href: getRequestHref(request.projectId, request.id),
          projectName: project.name,
          createdAt: request.updatedAt,
        };
      }),
    ...tasksForOwner
      .filter((task) => projectMap.has(task.projectId))
      .flatMap((task) => {
        const project = projectMap.get(task.projectId)!;
        const code = formatTaskCode(project.slug, task.codeNumber);
        const title = code ? `${code} · ${task.title}` : task.title;
        const notifications: Array<{
          id: string;
          tone: "danger" | "warning" | "default";
          title: string;
          detail: string;
          href: string;
          projectName: string;
          createdAt: Date;
        }> = [];

        if (
          task.status !== "done" &&
          task.dueDate &&
          task.dueDate.getTime() < today.getTime()
        ) {
          notifications.push({
            id: `task-overdue-${task.id}`,
            tone: "danger",
            title,
            detail: `Overdue in ${project.name}`,
            href: getTaskHref(task.projectId, task.id),
            projectName: project.name,
            createdAt: task.updatedAt,
          });
        } else if (
          task.status !== "done" &&
          task.dueDate &&
          task.dueDate.getTime() >= today.getTime() &&
          task.dueDate.getTime() < endOfToday.getTime()
        ) {
          notifications.push({
            id: `task-due-${task.id}`,
            tone: "warning",
            title,
            detail: `Due today in ${project.name}`,
            href: getTaskHref(task.projectId, task.id),
            projectName: project.name,
            createdAt: task.updatedAt,
          });
        }

        if (task.status === "done" && !publishedTaskIds.has(task.id)) {
          notifications.push({
            id: `task-update-${task.id}`,
            tone: "default",
            title,
            detail: `Publish a client update for ${project.name}`,
            href: getTaskStatusUpdateHref(task.projectId, task.id),
            projectName: project.name,
            createdAt: task.updatedAt,
          });
        }

        return notifications;
      }),
    ...assignedTaskActivity
      .map((activity) => {
        const task = taskMap.get(activity.taskId);
        if (!task) return null;
        const project = projectMap.get(task.projectId);
        if (!project) return null;
        const code = formatTaskCode(project.slug, task.codeNumber);
        const title = code ? `${code} · ${task.title}` : task.title;
        return {
          id: `activity-${activity.id}`,
          tone: "default" as const,
          title,
          detail: `${activity.actorName} ${activity.label.toLowerCase()}${activity.detail ? ` — ${activity.detail}` : ""}`,
          href: getTaskHref(task.projectId, task.id),
          projectName: project.name,
          createdAt: activity.createdAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null),
  ].filter((item) => item.createdAt.getTime() >= ttlCutoff.getTime());

  const decorated = items.map((item) => ({
    ...item,
    readAt: readMap.get(item.id) ?? null,
  }));

  return decorated;
}

type SortableNotification = {
  tone: "danger" | "warning" | "default";
  createdAt: Date;
  readAt: Date | null;
};

const NOTIFICATION_TONE_RANK = {
  danger: 0,
  warning: 1,
  default: 2,
} as const;

// Unread first, then by tone severity, then newest. Read items pool at the
// bottom but stay visible until TTL. Shared by computed + stored items.
function sortNotificationItems<T extends SortableNotification>(items: T[]): T[] {
  return items.sort((left, right) => {
    const readDiff = (left.readAt ? 1 : 0) - (right.readAt ? 1 : 0);
    if (readDiff !== 0) return readDiff;

    const toneDifference =
      NOTIFICATION_TONE_RANK[left.tone] - NOTIFICATION_TONE_RANK[right.tone];
    if (toneDifference !== 0) return toneDifference;

    return right.createdAt.getTime() - left.createdAt.getTime();
  });
}

function buildRecentActivity(
  projectList: Awaited<ReturnType<typeof listProjectsForUser>>,
  activityRows: Array<{
    id: string;
    ownerId: string;
    actorName?: string | null;
    projectId: string;
    entityType: string;
    entityId: string;
    action: string;
    label: string;
    detail: string | null;
    changes: ActivityChange[] | null;
    createdAt: Date;
  }>,
  options: {
    includeArchived?: boolean;
    limit: number;
  },
) {
  const projectMap = new Map(projectList.map((project) => [project.id, project]));
  const visibleProjectIds = new Set(
    projectList
      .filter((project) => options.includeArchived || !project.archivedAt)
      .map((project) => project.id),
  );

  return activityRows
    .filter((activity) => visibleProjectIds.has(activity.projectId))
    .slice(0, options.limit)
    .map((activity) => {
      const project = projectMap.get(activity.projectId);
      let href = `/projects/${activity.projectId}`;

      if (activity.entityType === "task") {
        href = getTaskHref(activity.projectId, activity.entityId);
      } else if (activity.entityType === "request") {
        href = getRequestHref(activity.projectId, activity.entityId);
      } else if (activity.entityType === "note") {
        href = getNoteHref(activity.projectId);
      }

      return {
        ...activity,
        actorName: activity.actorName ?? "Unknown user",
        projectName: project?.name ?? "Unknown project",
        projectArchived: Boolean(project?.archivedAt),
        href,
      };
    });
}

export async function listProjectsForUser(
  userId: string,
  options: {
    includeArchived?: boolean;
    onlyArchived?: boolean;
  } = {},
) {
  const allProjects = await getAllProjectsForUser(userId);

  if (options.onlyArchived) {
    return allProjects.filter((project) => project.archivedAt !== null);
  }

  if (options.includeArchived) {
    return allProjects;
  }

  return allProjects.filter((project) => project.archivedAt === null);
}

export async function getProjectForUser(
  projectId: string,
  viewer: ProjectViewer,
) {
  if (!(await canAccessProject(viewer, projectId))) return null;

  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  return project ?? null;
}

export async function getPublicProjectBoard(shareToken: string) {
  if (!shareToken) {
    return null;
  }

  const db = getDb();
  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      clientName: projects.clientName,
      summary: projects.summary,
      status: projects.status,
      color: projects.color,
      deadline: projects.deadline,
      updatedAt: projects.updatedAt,
      archivedAt: projects.archivedAt,
      showBoard: projects.clientShareShowBoard,
      showDescription: projects.clientShareShowDescription,
      showCommits: projects.clientShareShowCommits,
    })
    .from(projects)
    // The board is private until the owner enables it, and is addressed by a
    // rotatable token (never the project id), so a leaked/rotated link or a
    // disabled board stops resolving.
    .where(
      and(
        eq(projects.clientShareToken, shareToken),
        eq(projects.clientShareEnabled, true),
      ),
    )
    .limit(1);

  // Archiving a project is the closest action to "unshare" the public client
  // board, so an archived project must no longer be served publicly.
  if (!project || project.archivedAt) {
    return null;
  }

  const projectId = project.id;

  const [boardTasks, statusUpdates, checklistItems] =
    await Promise.all([
      db
        .select({
          id: tasks.id,
          title: tasks.title,
          description: tasks.description,
          categoryName: tasks.categoryName,
          categoryColor: tasks.categoryColor,
          phase: tasks.phase,
          status: tasks.status,
          priority: tasks.priority,
          dueDate: tasks.dueDate,
          requestId: tasks.requestId,
          sortOrder: tasks.sortOrder,
          statusChangedAt: tasks.statusChangedAt,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .orderBy(asc(tasks.sortOrder), desc(tasks.updatedAt)),
      db
        // Only the columns the public board renders — never spread the raw
        // row, so internal fields (ownerId, projectId) can't leak to a
        // logged-out client even if the render layer later changes.
        .select({
          id: projectStatusUpdates.id,
          taskId: projectStatusUpdates.taskId,
          summary: projectStatusUpdates.summary,
          createdAt: projectStatusUpdates.createdAt,
        })
        .from(projectStatusUpdates)
        .where(eq(projectStatusUpdates.projectId, projectId))
        .orderBy(desc(projectStatusUpdates.createdAt)),
      db
        .select({
          id: taskChecklistItems.id,
          taskId: taskChecklistItems.taskId,
          content: taskChecklistItems.content,
          isCompleted: taskChecklistItems.isCompleted,
        })
        .from(taskChecklistItems)
        .where(eq(taskChecklistItems.projectId, projectId))
        .orderBy(asc(taskChecklistItems.sortOrder)),
    ]);

  const subtasksByTask = new Map<string, typeof checklistItems>();
  for (const item of checklistItems) {
    const list = subtasksByTask.get(item.taskId) ?? [];
    list.push(item);
    subtasksByTask.set(item.taskId, list);
  }

  const taskMap = new Map(boardTasks.map((task) => [task.id, task]));

  // Repoint embedded description images at the token-scoped public route so a
  // logged-out client can load them (the /api/uploads route is auth-gated). The
  // route re-checks that each image is actually referenced by this board.
  const publicTasks = boardTasks.map((task) => ({
    ...task,
    description: rewriteRichTextUploadSrc(task.description, (src) =>
      src.startsWith("/api/uploads/")
        ? src.replace("/api/uploads/", `/api/client/${shareToken}/uploads/`)
        : src,
    ),
    subtasks: (subtasksByTask.get(task.id) ?? []).map((item) => ({
      id: item.id,
      content: item.content,
      isCompleted: item.isCompleted,
    })),
  }));

  // Apply the owner's public-view toggles at the data layer so hidden sections
  // never reach the client payload, not just the render. A hidden board sends no
  // tasks; a hidden description strips the body from every task; hidden commits
  // send no status log.
  const visibleTasks = project.showBoard
    ? project.showDescription
      ? publicTasks
      : publicTasks.map((task) => ({ ...task, description: null }))
    : [];

  return {
    project,
    tasks: visibleTasks,
    statusUpdates: project.showCommits
      ? statusUpdates.map((update) => ({
          ...update,
          taskTitle: taskMap.get(update.taskId)?.title ?? "Completed task",
        }))
      : [],
  };
}

export async function getRecentActivityForUser(
  userId: string,
  options: {
    includeArchived?: boolean;
    limit?: number;
    projectId?: string;
    projectList?: Awaited<ReturnType<typeof listProjectsForUser>>;
  } = {},
) {
  const db = getDb();
  const limit = options.limit ?? 10;
  const projectList =
    options.projectList ??
    (await listProjectsForUser(userId, {
      includeArchived: true,
    }));
  const clauses = [eq(projectActivity.ownerId, userId)];

  if (options.projectId) {
    clauses.push(eq(projectActivity.projectId, options.projectId));
  }

  const activityRows = await db
    .select({
      id: projectActivity.id,
      ownerId: projectActivity.ownerId,
      actorName: user.name,
      projectId: projectActivity.projectId,
      entityType: projectActivity.entityType,
      entityId: projectActivity.entityId,
      action: projectActivity.action,
      label: projectActivity.label,
      detail: projectActivity.detail,
      changes: projectActivity.changes,
      createdAt: projectActivity.createdAt,
    })
    .from(projectActivity)
    .leftJoin(user, eq(user.id, projectActivity.ownerId))
    .where(and(...clauses))
    .orderBy(desc(projectActivity.createdAt))
    .limit(limit * 3);

  return buildRecentActivity(projectList, activityRows, {
    includeArchived: options.includeArchived,
    limit,
  });
}

export async function getProjectWorkspace(
  projectId: string,
  viewer: ProjectViewer,
) {
  if (!(await canAccessProject(viewer, projectId))) return null;

  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return null;
  }

  const [
    requests,
    boardTasks,
    checklistItems,
    statusUpdates,
    notes,
    activityRows,
    memberRows,
    ownerRow,
    taskCommentRows,
    requestCommentRows,
    categoryRows,
    labelRows,
    taskLabelRows,
  ] = await Promise.all([
    db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.projectId, projectId))
      .orderBy(desc(clientRequests.updatedAt), desc(clientRequests.createdAt)),
    db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.sortOrder), desc(tasks.updatedAt)),
    db
      .select()
      .from(taskChecklistItems)
      .where(eq(taskChecklistItems.projectId, projectId))
      .orderBy(
        asc(taskChecklistItems.taskId),
        asc(taskChecklistItems.sortOrder),
        asc(taskChecklistItems.createdAt),
      ),
    db
      .select()
      .from(projectStatusUpdates)
      .where(eq(projectStatusUpdates.projectId, projectId))
      .orderBy(desc(projectStatusUpdates.createdAt)),
    db
      .select()
      .from(projectNotes)
      .where(eq(projectNotes.projectId, projectId))
      .orderBy(desc(projectNotes.createdAt)),
    db
      .select({
        id: projectActivity.id,
        ownerId: projectActivity.ownerId,
        actorName: user.name,
        projectId: projectActivity.projectId,
        entityType: projectActivity.entityType,
        entityId: projectActivity.entityId,
        action: projectActivity.action,
        label: projectActivity.label,
        detail: projectActivity.detail,
        changes: projectActivity.changes,
        createdAt: projectActivity.createdAt,
      })
      .from(projectActivity)
      .leftJoin(user, eq(user.id, projectActivity.ownerId))
      .where(eq(projectActivity.projectId, projectId))
      .orderBy(desc(projectActivity.createdAt))
      .limit(24),
    db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(asc(user.name)),
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      })
      .from(user)
      .where(eq(user.id, project.ownerId))
      .limit(1),
    db
      .select({
        id: taskComments.id,
        taskId: taskComments.taskId,
        content: taskComments.content,
        authorId: taskComments.authorId,
        authorName: user.name,
        authorImage: user.image,
        createdAt: taskComments.createdAt,
        updatedAt: taskComments.updatedAt,
      })
      .from(taskComments)
      .innerJoin(user, eq(user.id, taskComments.authorId))
      .where(eq(taskComments.projectId, projectId))
      .orderBy(asc(taskComments.createdAt)),
    db
      .select({
        id: requestComments.id,
        requestId: requestComments.requestId,
        content: requestComments.content,
        authorId: requestComments.authorId,
        authorName: user.name,
        authorImage: user.image,
        createdAt: requestComments.createdAt,
        updatedAt: requestComments.updatedAt,
      })
      .from(requestComments)
      .innerJoin(user, eq(user.id, requestComments.authorId))
      .where(eq(requestComments.projectId, projectId))
      .orderBy(asc(requestComments.createdAt)),
    db
      .select()
      .from(taskCategories)
      .where(eq(taskCategories.projectId, projectId))
      .orderBy(asc(taskCategories.name)),
    db
      .select()
      .from(taskLabels)
      .where(eq(taskLabels.projectId, projectId))
      .orderBy(asc(taskLabels.name)),
    db
      .select({
        taskId: taskTaskLabels.taskId,
        id: taskLabels.id,
        name: taskLabels.name,
        color: taskLabels.color,
      })
      .from(taskTaskLabels)
      .innerJoin(taskLabels, eq(taskLabels.id, taskTaskLabels.labelId))
      .where(eq(taskLabels.projectId, projectId))
      .orderBy(asc(taskLabels.name)),
  ]);

  // Group label memberships by task so each board task carries its labels.
  const labelsByTask = new Map<
    string,
    Array<{ id: string; name: string; color: string }>
  >();
  for (const row of taskLabelRows) {
    const list = labelsByTask.get(row.taskId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    labelsByTask.set(row.taskId, list);
  }
  const tasksWithLabels = boardTasks.map((task) => ({
    ...task,
    labels: labelsByTask.get(task.id) ?? [],
  }));
  const activity = buildRecentActivity([project], activityRows, {
    includeArchived: true,
    limit: 8,
  });

  // Assignable people = project owner + project members, deduplicated.
  const assignableMap = new Map<string, { userId: string; name: string; email: string; role: string }>();
  const owner = ownerRow[0];
  if (owner) {
    assignableMap.set(owner.id, {
      userId: owner.id,
      name: owner.name,
      email: owner.email,
      role: owner.role,
    });
  }
  for (const m of memberRows) {
    if (!assignableMap.has(m.userId)) {
      assignableMap.set(m.userId, m);
    }
  }
  const members = [...assignableMap.values()];

  return {
    project,
    requests,
    tasks: tasksWithLabels,
    checklistItems,
    statusUpdates,
    notes,
    activity,
    members,
    taskComments: taskCommentRows,
    requestComments: requestCommentRows,
    categories: categoryRows,
    labels: labelRows,
  };
}

export async function getProjectsDashboardForViewer(
  viewer: ProjectViewer,
  view: "open" | "archived" = "open",
) {
  const { allProjects, requestsForOwner, tasksForOwner } =
    await getCollectionsForViewer(viewer);

  const projectsWithStats = buildProjectStats(
    allProjects,
    requestsForOwner,
    tasksForOwner,
  );
  const openProjects = projectsWithStats.filter((project) => !project.archivedAt);
  const archivedProjects = projectsWithStats.filter((project) => project.archivedAt);
  const visibleProjects = view === "archived" ? archivedProjects : openProjects;

  return {
    projects: visibleProjects,
    openProjects,
    archivedProjects,
    summary: buildSummary(openProjects),
    archivedSummary: buildSummary(archivedProjects),
    currentView: view,
  };
}

export async function getSearchIndexForUser(userId: string) {
  const { allProjects, requestsForOwner, tasksForOwner } =
    await getOwnerWorkspaceCollections(userId);

  return buildSearchIndex(allProjects, requestsForOwner, tasksForOwner);
}

/** Activity rows on tasks where the viewer is the assignee, within the TTL
 * window, excluding the viewer's own actions (don't notify yourself about
 * what you just did). Joined with user for the actor name. */
async function getAssignedTaskActivity(userId: string) {
  const db = getDb();
  const cutoff = new Date(Date.now() - 30 * 86_400_000);

  const assignedTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.assigneeId, userId));

  if (assignedTasks.length === 0) return [];

  const rows = await db
    .select({
      id: projectActivity.id,
      taskId: projectActivity.entityId,
      actorId: projectActivity.ownerId,
      actorName: user.name,
      label: projectActivity.label,
      detail: projectActivity.detail,
      createdAt: projectActivity.createdAt,
    })
    .from(projectActivity)
    .leftJoin(user, eq(user.id, projectActivity.ownerId))
    .where(
      and(
        eq(projectActivity.entityType, "task"),
        inArray(
          projectActivity.entityId,
          assignedTasks.map((t) => t.id),
        ),
        gte(projectActivity.createdAt, cutoff),
      ),
    )
    .orderBy(desc(projectActivity.createdAt))
    .limit(200);

  return rows
    .filter((row) => row.actorId !== userId)
    .map((row) => ({
      id: row.id,
      taskId: row.taskId,
      actorName: row.actorName ?? "Someone",
      label: row.label,
      detail: row.detail,
      createdAt: row.createdAt,
    }));
}

async function getNotificationReadMap(userId: string): Promise<Map<string, Date>> {
  const db = getDb();
  const rows = await db
    .select({
      notificationId: notificationReads.notificationId,
      readAt: notificationReads.readAt,
    })
    .from(notificationReads)
    .where(eq(notificationReads.userId, userId));
  return new Map(rows.map((row) => [row.notificationId, row.readAt]));
}

// Persisted, event-driven notifications (e.g. daily-ops assignments). Adapted
// into the same shape the bell renders, with a `stored-` id prefix so
// markNotificationReadAction can route them to their own readAt column.
async function getStoredNotificationItems(userId: string) {
  const db = getDb();
  const ttlCutoff = new Date(Date.now() - NOTIFICATION_TTL_MS);
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientId, userId),
        gte(notifications.createdAt, ttlCutoff),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(200);

  return rows.map((row) => ({
    id: `stored-${row.id}`,
    tone: row.tone,
    title: row.title,
    detail: row.body ?? "",
    href: row.href,
    projectName: "Daily ops",
    createdAt: row.createdAt,
    readAt: row.readAt,
  }));
}

async function getStoredUnreadCount(userId: string): Promise<number> {
  const db = getDb();
  const ttlCutoff = new Date(Date.now() - NOTIFICATION_TTL_MS);
  const [row] = await db
    .select({ value: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientId, userId),
        isNull(notifications.readAt),
        gte(notifications.createdAt, ttlCutoff),
      ),
    );
  return row?.value ?? 0;
}

export async function getNotificationsForUser(userId: string) {
  const [collections, assignedActivity, readMap, stored] = await Promise.all([
    getOwnerWorkspaceCollections(userId),
    getAssignedTaskActivity(userId),
    getNotificationReadMap(userId),
    getStoredNotificationItems(userId),
  ]);
  const { allProjects, requestsForOwner, tasksForOwner, statusUpdatesForOwner } =
    collections;
  const openProjects = allProjects.filter((project) => !project.archivedAt);

  const computed = buildNotifications(
    openProjects,
    requestsForOwner,
    tasksForOwner,
    statusUpdatesForOwner,
    assignedActivity,
    readMap,
  );

  return sortNotificationItems([...computed, ...stored]);
}

/**
 * Sidebar data. For admin tier viewers, this lists every project in the
 * workspace; for members, only projects they own or are members of.
 * Notification count stays personal (notifications are for you, not the
 * workspace).
 */
export async function getAppShellDataForViewer(viewer: ProjectViewer) {
  const { allProjects } = await getCollectionsForViewer(viewer);
  // Notifications are personal regardless of admin powers.
  const [personal, assignedActivity, readMap, storedUnread] = await Promise.all([
    getOwnerWorkspaceCollections(viewer.id),
    getAssignedTaskActivity(viewer.id),
    getNotificationReadMap(viewer.id),
    getStoredUnreadCount(viewer.id),
  ]);
  const openProjects = allProjects.filter((project) => !project.archivedAt);
  const computedUnread = buildNotifications(
    personal.allProjects.filter((p) => !p.archivedAt),
    personal.requestsForOwner,
    personal.tasksForOwner,
    personal.statusUpdatesForOwner,
    assignedActivity,
    readMap,
  ).filter((notification) => !notification.readAt).length;
  const notificationCount = computedUnread + storedUnread;

  return {
    projects: openProjects,
    notificationCount,
  };
}

export async function getTodayViewForUser(userId: string) {
  const { allProjects, tasksForOwner } = await getOwnerWorkspaceCollections(userId);
  const recentActivity = await getRecentActivityForUser(userId, {
    includeArchived: false,
    limit: 8,
    projectList: allProjects,
  });
  const projectList = allProjects.filter((project) => !project.archivedAt);
  const projectMap = new Map(projectList.map((project) => [project.id, project]));
  const now = new Date();
  const today = getStartOfDay(now);
  const nextWeek = new Date(today.getTime() + 7 * 86_400_000);

  const visibleTasks = tasksForOwner
    .filter((task) => task.assigneeId === userId)
    .filter((task) => projectMap.has(task.projectId))
    .map((task) => {
      const project = projectMap.get(task.projectId)!;
      const daysUntilDue = task.dueDate ? getDayDistance(task.dueDate, today) : null;
      const isOverdue =
        task.dueDate !== null &&
        task.status !== "done" &&
        task.dueDate.getTime() < today.getTime();

      return {
        ...task,
        projectName: project.name,
        projectColor: project.color ?? null,
        projectStatus: project.status,
        code: formatTaskCode(project.slug, task.codeNumber),
        href: getTaskHref(task.projectId, task.id),
        daysUntilDue,
        isOverdue,
      };
    });

  const overdue = visibleTasks
    .filter((task) => task.isOverdue)
    .sort(
      (left, right) =>
        (left.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER),
    );

  const dueToday = visibleTasks
    .filter(
      (task) =>
        task.dueDate !== null &&
        task.status !== "done" &&
        task.dueDate.getTime() >= today.getTime() &&
        task.dueDate.getTime() < today.getTime() + 86_400_000,
    )
    .sort(
      (left, right) =>
        (left.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER),
    );

  const upcoming = visibleTasks
    .filter(
      (task) =>
        task.dueDate !== null &&
        task.status !== "done" &&
        task.dueDate.getTime() >= today.getTime() + 86_400_000 &&
        task.dueDate.getTime() < nextWeek.getTime(),
    )
    .sort(
      (left, right) =>
        (left.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER),
    );

  const activeWithoutDate = visibleTasks
    .filter((task) => task.status === "doing" && task.dueDate === null)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());

  return {
    summary: {
      overdue: overdue.length,
      dueToday: dueToday.length,
      upcoming: upcoming.length,
      activeWithoutDate: activeWithoutDate.length,
    },
    overdue,
    dueToday,
    upcoming,
    activeWithoutDate,
    recentActivity,
  };
}

/**
 * Daily Ops planner — a user's planned items across a date range.
 * Left-joins the project (for name/slug/color) and the linked board task
 * (for its live status, so a linked card always shows accurate state).
 */
export async function getDailyTasksForUser(
  userId: string,
  fromDate: Date,
  toDateExclusive: Date,
) {
  const db = getDb();
  const rows = await db
    .select({
      id: dailyTasks.id,
      ownerId: dailyTasks.ownerId,
      createdById: dailyTasks.createdById,
      plannedDate: dailyTasks.plannedDate,
      title: dailyTasks.title,
      description: dailyTasks.description,
      status: dailyTasks.status,
      priority: dailyTasks.priority,
      kind: dailyTasks.kind,
      projectId: dailyTasks.projectId,
      linkedTaskId: dailyTasks.linkedTaskId,
      sortOrder: dailyTasks.sortOrder,
      batchId: dailyTasks.batchId,
      createdAt: dailyTasks.createdAt,
      updatedAt: dailyTasks.updatedAt,
      projectName: projects.name,
      projectSlug: projects.slug,
      projectColor: projects.color,
      linkedStatus: tasks.status,
      linkedCodeNumber: tasks.codeNumber,
      linkedProjectId: tasks.projectId,
    })
    .from(dailyTasks)
    .leftJoin(projects, eq(projects.id, dailyTasks.projectId))
    .leftJoin(tasks, eq(tasks.id, dailyTasks.linkedTaskId))
    .where(
      and(
        eq(dailyTasks.ownerId, userId),
        gte(dailyTasks.plannedDate, fromDate),
        lt(dailyTasks.plannedDate, toDateExclusive),
      ),
    )
    .orderBy(
      asc(dailyTasks.plannedDate),
      asc(dailyTasks.sortOrder),
      asc(dailyTasks.createdAt),
    );

  return rows.map((row) => {
    const linkedProjectId = row.linkedProjectId ?? row.projectId;
    return {
      ...row,
      dateKey: formatLocalDateKey(row.plannedDate),
      projectCode: formatTaskCode(row.projectSlug, row.linkedCodeNumber),
      boardHref:
        row.linkedTaskId && linkedProjectId
          ? getTaskHref(linkedProjectId, row.linkedTaskId)
          : null,
    };
  });
}

export type DailyTaskItem = Awaited<
  ReturnType<typeof getDailyTasksForUser>
>[number];

/**
 * Projects a user can plan against, each with their open (non-done) board
 * tasks for the "link existing board task" picker. Reuses the cached
 * per-request workspace collections so this adds no extra round-trips.
 */
export async function getDailyPlannerProjects(userId: string) {
  const { allProjects, tasksForOwner } =
    await getOwnerWorkspaceCollections(userId);
  const openProjects = allProjects.filter((project) => !project.archivedAt);

  const tasksByProject = new Map<string, typeof tasksForOwner>();
  for (const task of tasksForOwner) {
    if (task.status === "done") continue;
    const list = tasksByProject.get(task.projectId) ?? [];
    list.push(task);
    tasksByProject.set(task.projectId, list);
  }

  return openProjects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    tasks: (tasksByProject.get(project.id) ?? [])
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 50)
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        code: formatTaskCode(project.slug, task.codeNumber),
      })),
  }));
}

export type DailyPlannerProject = Awaited<
  ReturnType<typeof getDailyPlannerProjects>
>[number];

export async function getDashboardForUser(userId: string) {
  const [collections, activityRows, completedSubtasks] = await Promise.all([
    getOwnerWorkspaceCollections(userId),
    getRecentActivityRowsForUser(userId),
    getCompletedSubtasksForUser(userId),
  ]);

  return computeDashboard(collections, activityRows, completedSubtasks);
}

type DashboardCollections = {
  allProjects: Awaited<ReturnType<typeof getAllProjectsForUser>>;
  requestsForOwner: Awaited<ReturnType<typeof getRequestsForUser>>;
  tasksForOwner: Awaited<ReturnType<typeof getTasksForUser>>;
  statusUpdatesForOwner: Awaited<ReturnType<typeof getStatusUpdatesForUser>>;
};

type DashboardActivityRow = { id: string; projectId: string; createdAt: Date };
type DashboardCompletedSubtask = { id: string; completedAt: Date | null };

export function computeDashboard(
  collections: DashboardCollections,
  activityRows: DashboardActivityRow[],
  completedSubtasks: DashboardCompletedSubtask[],
) {
  const { allProjects, requestsForOwner, tasksForOwner, statusUpdatesForOwner } = collections;

  const projectsWithStats = buildProjectStats(allProjects, requestsForOwner, tasksForOwner);
  const openProjects = projectsWithStats.filter((project) => !project.archivedAt);
  const projectNameById = new Map(allProjects.map((project) => [project.id, project.name]));
  const projectColorById = new Map(
    allProjects.map((project) => [project.id, project.color ?? null]),
  );

  const now = new Date();
  const today = getStartOfDay(now);
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86_400_000);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86_400_000);
  const oneYearAgo = new Date(today.getTime() - 365 * 86_400_000);

  // ---- Totals ----
  const shipped7d = statusUpdatesForOwner.filter(
    (update) => update.createdAt.getTime() >= sevenDaysAgo.getTime(),
  ).length;
  const shipped30d = statusUpdatesForOwner.filter(
    (update) => update.createdAt.getTime() >= thirtyDaysAgo.getTime(),
  ).length;
  const shippedAllTime = statusUpdatesForOwner.length;
  const activeDays30d = new Set(
    activityRows
      .filter((row) => row.createdAt.getTime() >= thirtyDaysAgo.getTime())
      .map((row) => formatLocalDateKey(row.createdAt)),
  ).size;

  // ---- Throughput (84 days, oldest first, today is the last bucket) ----
  const throughputDayCount = 84;
  const throughput: Array<{
    dayStart: Date;
    dayLabel: string;
    shippedCount: number;
    subtasksCompleted: number;
  }> = [];
  for (let i = throughputDayCount - 1; i >= 0; i -= 1) {
    const dayStart = new Date(today.getTime() - i * 86_400_000);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const shippedCount = statusUpdatesForOwner.filter(
      (update) =>
        update.createdAt.getTime() >= dayStart.getTime() &&
        update.createdAt.getTime() < dayEnd.getTime(),
    ).length;
    const subtasksCompleted = completedSubtasks.filter(
      (item) =>
        item.completedAt !== null &&
        item.completedAt.getTime() >= dayStart.getTime() &&
        item.completedAt.getTime() < dayEnd.getTime(),
    ).length;
    const dayLabel = dayStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    throughput.push({ dayStart, dayLabel, shippedCount, subtasksCompleted });
  }

  // ---- Heatmap (365 days, zero-filled, with level) ----
  const heatmapActivityByDate = new Map<string, number>();
  for (const row of activityRows) {
    if (row.createdAt.getTime() < oneYearAgo.getTime()) continue;
    const key = formatLocalDateKey(row.createdAt);
    heatmapActivityByDate.set(key, (heatmapActivityByDate.get(key) ?? 0) + 1);
  }
  const heatmapSubtasksByDate = new Map<string, number>();
  for (const item of completedSubtasks) {
    if (item.completedAt === null) continue;
    if (item.completedAt.getTime() < oneYearAgo.getTime()) continue;
    const key = formatLocalDateKey(item.completedAt);
    heatmapSubtasksByDate.set(key, (heatmapSubtasksByDate.get(key) ?? 0) + 1);
  }
  const heatmapShippedByDate = new Map<string, number>();
  for (const update of statusUpdatesForOwner) {
    if (update.createdAt.getTime() < oneYearAgo.getTime()) continue;
    const key = formatLocalDateKey(update.createdAt);
    heatmapShippedByDate.set(key, (heatmapShippedByDate.get(key) ?? 0) + 1);
  }
  let heatmapMax = 0;
  const heatmapKeys = new Set<string>([
    ...heatmapActivityByDate.keys(),
    ...heatmapSubtasksByDate.keys(),
  ]);
  for (const key of heatmapKeys) {
    const combined =
      (heatmapActivityByDate.get(key) ?? 0) + (heatmapSubtasksByDate.get(key) ?? 0);
    if (combined > heatmapMax) heatmapMax = combined;
  }
  const heatmap: Array<{
    date: string;
    count: number;
    level: 0 | 1 | 2 | 3 | 4;
    shipped: number;
    subtasks: number;
  }> = [];
  for (let i = 364; i >= 0; i -= 1) {
    const day = new Date(today.getTime() - i * 86_400_000);
    const key = formatLocalDateKey(day);
    const activityCount = heatmapActivityByDate.get(key) ?? 0;
    const subtasks = heatmapSubtasksByDate.get(key) ?? 0;
    const shipped = heatmapShippedByDate.get(key) ?? 0;
    const count = activityCount + subtasks;
    heatmap.push({
      date: key,
      count,
      level: bucketLevel(count, heatmapMax),
      shipped,
      subtasks,
    });
  }

  // ---- Velocity by project (30d, top 10) ----
  const velocityCountByProject = new Map<string, number>();
  for (const update of statusUpdatesForOwner) {
    if (update.createdAt.getTime() < thirtyDaysAgo.getTime()) continue;
    velocityCountByProject.set(
      update.projectId,
      (velocityCountByProject.get(update.projectId) ?? 0) + 1,
    );
  }
  const velocityByProject = [...velocityCountByProject.entries()]
    .map(([projectId, shippedCount]) => ({
      projectId,
      projectName: projectNameById.get(projectId) ?? "Unknown project",
      shippedCount,
    }))
    .sort((left, right) => right.shippedCount - left.shippedCount)
    .slice(0, 10);

  // ---- Pressure leaderboard (open projects, top 8 by pressureScore, score > 0) ----
  const pressureLeaderboard = openProjects
    .filter((project) => project.pressureScore > 0)
    .sort((left, right) => right.pressureScore - left.pressureScore)
    .slice(0, 8);

  // ---- Shipped feed (last 30 status updates, joined to task title + project name) ----
  const taskTitleById = new Map(tasksForOwner.map((task) => [task.id, task.title]));
  const shippedFeed = statusUpdatesForOwner
    .slice()
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, 30)
    .map((update) => ({
      id: update.id,
      taskId: update.taskId,
      taskTitle: taskTitleById.get(update.taskId) ?? "Completed task",
      summary: update.summary,
      projectId: update.projectId,
      projectName: projectNameById.get(update.projectId) ?? "Unknown project",
      projectColor: projectColorById.get(update.projectId) ?? null,
      createdAt: update.createdAt,
      href: getTaskStatusUpdateHref(update.projectId, update.taskId),
    }));

  return {
    totals: { shipped7d, shipped30d, shippedAllTime, activeDays30d },
    throughput,
    heatmap,
    velocityByProject,
    pressureLeaderboard,
    shippedFeed,
  };
}

export type ProjectActivityFilters = {
  q?: string;
  from?: Date;
  to?: Date;
  actorId?: string;
  action?: string;
  /** Match rows whose structured `changes` touched this field (e.g. "status"). */
  field?: string;
};

export type ProjectActivityActor = {
  id: string;
  name: string;
  email: string;
};

export async function listProjectActivity(
  projectId: string,
  viewer: ProjectViewer,
  filters: ProjectActivityFilters = {},
  limit: number = 200,
) {
  // Self-protecting: never return one project's activity (actor names, before→
  // after diffs) to a caller who can't access the project.
  if (!(await canAccessProject(viewer, projectId))) return [];

  const db = getDb();
  const clauses: SQL[] = [eq(projectActivity.projectId, projectId)];

  if (filters.from) {
    clauses.push(gte(projectActivity.createdAt, filters.from));
  }
  if (filters.to) {
    const exclusive = new Date(filters.to.getTime() + 86_400_000);
    clauses.push(lt(projectActivity.createdAt, exclusive));
  }
  if (filters.actorId) {
    clauses.push(eq(projectActivity.ownerId, filters.actorId));
  }
  if (
    filters.action &&
    (activityActionValues as readonly string[]).includes(filters.action)
  ) {
    clauses.push(
      eq(
        projectActivity.action,
        filters.action as (typeof activityActionValues)[number],
      ),
    );
  }
  if (filters.q) {
    const term = `%${filters.q.toLowerCase()}%`;
    clauses.push(
      or(
        like(projectActivity.label, term),
        like(projectActivity.detail, term),
      )!,
    );
  }
  // Field keys are simple alphabetic identifiers; the regex guard keeps LIKE
  // wildcards / quotes out of the JSON match below.
  if (filters.field && /^[a-zA-Z]+$/.test(filters.field)) {
    clauses.push(like(projectActivity.changes, `%"field":"${filters.field}"%`));
  }

  const rows = await db
    .select({
      id: projectActivity.id,
      actorId: projectActivity.ownerId,
      actorName: user.name,
      entityType: projectActivity.entityType,
      entityId: projectActivity.entityId,
      action: projectActivity.action,
      label: projectActivity.label,
      detail: projectActivity.detail,
      changes: projectActivity.changes,
      createdAt: projectActivity.createdAt,
    })
    .from(projectActivity)
    .leftJoin(user, eq(user.id, projectActivity.ownerId))
    .where(and(...clauses))
    .orderBy(desc(projectActivity.createdAt))
    .limit(limit);

  return rows.map((row) => {
    let href = `/projects/${projectId}`;
    if (row.entityType === "task") {
      href = getTaskHref(projectId, row.entityId);
    } else if (row.entityType === "request") {
      href = getRequestHref(projectId, row.entityId);
    } else if (row.entityType === "note") {
      href = getNoteHref(projectId);
    }
    return {
      id: row.id,
      actorId: row.actorId,
      actorName: row.actorName ?? "Unknown user",
      entityType: row.entityType,
      entityId: row.entityId,
      action: row.action,
      label: row.label,
      detail: row.detail,
      changes: row.changes ?? null,
      createdAt: row.createdAt,
      href,
    };
  });
}

/**
 * Distinct users who have at least one activity row in this project.
 * Powers the "actor" filter dropdown on the project history page.
 */
export async function listProjectActivityActors(
  projectId: string,
  viewer: ProjectViewer,
): Promise<ProjectActivityActor[]> {
  if (!(await canAccessProject(viewer, projectId))) return [];

  const db = getDb();
  const rows = await db
    .selectDistinct({
      id: user.id,
      name: user.name,
      email: user.email,
    })
    .from(projectActivity)
    .innerJoin(user, eq(user.id, projectActivity.ownerId))
    .where(eq(projectActivity.projectId, projectId))
    .orderBy(asc(user.name));

  return rows;
}

export type ProjectActivityItem = Awaited<
  ReturnType<typeof listProjectActivity>
>[number];

export type ProjectListItem = Awaited<ReturnType<typeof listProjectsForUser>>[number];
export type ProjectWorkspace = NonNullable<
  Awaited<ReturnType<typeof getProjectWorkspace>>
>;
export type PublicProjectBoard = NonNullable<
  Awaited<ReturnType<typeof getPublicProjectBoard>>
>;
export type ProjectsDashboard = Awaited<
  ReturnType<typeof getProjectsDashboardForViewer>
>;
export type InAppNotificationItem = Awaited<
  ReturnType<typeof getNotificationsForUser>
>[number];
export type SearchIndexItem = Awaited<
  ReturnType<typeof getSearchIndexForUser>
>[number];
export type TodayView = Awaited<ReturnType<typeof getTodayViewForUser>>;
export type RecentActivityItem = Awaited<
  ReturnType<typeof getRecentActivityForUser>
>[number];
export type DashboardData = Awaited<ReturnType<typeof getDashboardForUser>>;
