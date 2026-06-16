// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Viewer-scoped read queries for the MCP read tools. Every function is scoped
// to what the viewer can see — list helpers reuse lib/data.ts (which filters by
// getPersonalProjectIds), single-entity reads gate on canAccessProject and
// return null/[] on a miss (never throw, so they can't be used as an existence
// oracle). Output shapes are compact (no internal/sensitive fields).
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";

import type { Viewer } from "@/lib/auth-server";
import { canAccessProject, getPersonalProjectIds } from "@/lib/authz";
import { formatRequestCode, formatTaskCode } from "@/lib/codes";
import { getSearchIndexForUser, listProjectsForUser } from "@/lib/data";
import { getDb } from "@/lib/db";
import {
  clientRequests,
  dailyTasks,
  projectActivity,
  projectNotes,
  projects,
  projectStatusUpdates,
  taskChecklistItems,
  tasks,
  type ActivityAction,
  type ActivityChange,
  type ActivityEntity,
  type DailyTaskKind,
  type Priority,
  type ProjectStatus,
  type RequestStatus,
  type TaskStatus,
} from "@/lib/db/schema";

export type ProjectSummary = {
  id: string;
  slug: string | null;
  name: string;
  status: ProjectStatus;
  archived: boolean;
};

export type ProjectDetail = {
  id: string;
  slug: string | null;
  name: string;
  clientName: string | null;
  summary: string | null;
  status: ProjectStatus;
  deadline: string | null;
  color: string | null;
  archived: boolean;
  clientShareEnabled: boolean;
  clientBoardPath: string | null;
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TaskSummary = {
  id: string;
  code: string | null;
  title: string;
  status: TaskStatus;
  priority: Priority;
  projectId: string;
  assigneeId: string | null;
  dueDate: string | null;
};

export type TaskDetail = TaskSummary & {
  description: string | null;
  category: { id: string; name: string } | null;
  checklist: { id: string; content: string; isCompleted: boolean }[];
};

export type RequestSummary = {
  id: string;
  code: string | null;
  title: string;
  status: RequestStatus;
  priority: Priority;
  projectId: string;
};

export type RequestDetail = RequestSummary & {
  description: string | null;
  createdAt: string;
};

export type SearchHit = {
  type: "project" | "task" | "request";
  id: string;
  code: string | null;
  title: string;
  projectId: string;
};

export type DailyTaskSummary = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  kind: DailyTaskKind;
  plannedDate: string;
  projectId: string | null;
  linkedTaskId: string | null;
};

export type ProjectNote = {
  projectId: string;
  content: string;
  updatedAt: string;
};

export type ActivityEntry = {
  id: string;
  projectId: string;
  entityType: ActivityEntity;
  entityId: string;
  action: ActivityAction;
  label: string;
  detail: string | null;
  changes: ActivityChange[] | null;
  actorId: string;
  createdAt: string;
};

export type StatusUpdate = {
  id: string;
  projectId: string;
  taskId: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

const MAX_ROWS = 100;

/** projectId → slug, for formatting display codes in list results. */
async function slugMap(
  projectIds: string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, ids));
  return new Map(rows.map((row) => [row.id, row.slug]));
}

export async function listProjects(
  viewer: Viewer,
  opts?: { includeArchived?: boolean; onlyArchived?: boolean },
): Promise<ProjectSummary[]> {
  const rows = await listProjectsForUser(viewer.id, opts);
  return rows.slice(0, MAX_ROWS).map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    status: p.status,
    archived: Boolean(p.archivedAt),
  }));
}

export async function readProject(
  viewer: Viewer,
  input: { projectId: string },
): Promise<ProjectDetail | null> {
  // Return the full editable record so an agent can round-trip the full-replace
  // update-project / set-project-color / set-project-key safely. null on a miss
  // (no existence oracle).
  if (!(await canAccessProject(viewer, input.projectId))) return null;
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) return null;

  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    clientName: project.clientName,
    summary: project.summary,
    status: project.status,
    deadline: project.deadline ? project.deadline.toISOString() : null,
    color: project.color,
    archived: Boolean(project.archivedAt),
    clientShareEnabled: project.clientShareEnabled,
    clientBoardPath:
      project.clientShareEnabled && project.clientShareToken
        ? `/client/${project.clientShareToken}`
        : null,
    isOwner: project.ownerId === viewer.id,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export async function listTasks(
  viewer: Viewer,
  filter?: { projectId?: string; status?: TaskStatus; assignedToMe?: boolean },
): Promise<TaskSummary[]> {
  const db = getDb();
  let scopeIds: string[];
  if (filter?.projectId) {
    // A specific project the viewer can access (member or admin).
    if (!(await canAccessProject(viewer, filter.projectId))) return [];
    scopeIds = [filter.projectId];
  } else {
    // Personal scope: projects the viewer owns or is a member of.
    scopeIds = await getPersonalProjectIds(viewer.id);
  }
  if (scopeIds.length === 0) return [];
  let rows = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.projectId, scopeIds));
  if (filter?.status) {
    rows = rows.filter((t) => t.status === filter.status);
  }
  if (filter?.assignedToMe) {
    rows = rows.filter((t) => t.assigneeId === viewer.id);
  }
  const capped = rows.slice(0, MAX_ROWS);
  const slugs = await slugMap(capped.map((t) => t.projectId));
  return capped.map((t) => ({
    id: t.id,
    code: formatTaskCode(slugs.get(t.projectId) ?? null, t.codeNumber),
    title: t.title,
    status: t.status,
    priority: t.priority,
    projectId: t.projectId,
    assigneeId: t.assigneeId,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
  }));
}

export async function readTask(
  viewer: Viewer,
  input: { projectId: string; taskId: string },
): Promise<TaskDetail | null> {
  if (!(await canAccessProject(viewer, input.projectId))) return null;
  const db = getDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)))
    .limit(1);
  if (!task) return null;

  const checklist = await db
    .select({
      id: taskChecklistItems.id,
      content: taskChecklistItems.content,
      isCompleted: taskChecklistItems.isCompleted,
    })
    .from(taskChecklistItems)
    .where(eq(taskChecklistItems.taskId, input.taskId))
    .orderBy(asc(taskChecklistItems.sortOrder))
    .limit(MAX_ROWS);

  const slugs = await slugMap([input.projectId]);
  return {
    id: task.id,
    code: formatTaskCode(slugs.get(input.projectId) ?? null, task.codeNumber),
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId,
    assigneeId: task.assigneeId,
    dueDate: task.dueDate ? task.dueDate.toISOString() : null,
    description: task.description,
    category: task.categoryId
      ? { id: task.categoryId, name: task.categoryName ?? "" }
      : null,
    checklist,
  };
}

export async function listRequests(
  viewer: Viewer,
  filter?: { projectId?: string; status?: RequestStatus },
): Promise<RequestSummary[]> {
  const db = getDb();
  let scopeIds: string[];
  if (filter?.projectId) {
    if (!(await canAccessProject(viewer, filter.projectId))) return [];
    scopeIds = [filter.projectId];
  } else {
    scopeIds = await getPersonalProjectIds(viewer.id);
  }
  if (scopeIds.length === 0) return [];
  let rows = await db
    .select()
    .from(clientRequests)
    .where(inArray(clientRequests.projectId, scopeIds));
  if (filter?.status) {
    rows = rows.filter((r) => r.status === filter.status);
  }
  const capped = rows.slice(0, MAX_ROWS);
  const slugs = await slugMap(capped.map((r) => r.projectId));
  return capped.map((r) => ({
    id: r.id,
    code: formatRequestCode(slugs.get(r.projectId) ?? null, r.codeNumber),
    title: r.title,
    status: r.status,
    priority: r.priority,
    projectId: r.projectId,
  }));
}

export async function readRequest(
  viewer: Viewer,
  input: { projectId: string; requestId: string },
): Promise<RequestDetail | null> {
  if (!(await canAccessProject(viewer, input.projectId))) return null;
  const db = getDb();
  const [row] = await db
    .select()
    .from(clientRequests)
    .where(
      and(
        eq(clientRequests.id, input.requestId),
        eq(clientRequests.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!row) return null;

  const slugs = await slugMap([input.projectId]);
  return {
    id: row.id,
    code: formatRequestCode(slugs.get(input.projectId) ?? null, row.codeNumber),
    title: row.title,
    status: row.status,
    priority: row.priority,
    projectId: row.projectId,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function search(
  viewer: Viewer,
  input: { query: string; limit?: number },
): Promise<SearchHit[]> {
  const q = input.query.trim().toLowerCase();
  if (!q) return [];
  const limit = Math.min(input.limit ?? 50, 100);
  // The index is built only from the viewer's owned-or-member projects.
  const index = await getSearchIndexForUser(viewer.id);
  const hits: SearchHit[] = [];
  for (const item of index) {
    if (hits.length >= limit) break;
    if (!item.searchText.toLowerCase().includes(q)) continue;
    hits.push({
      type: item.kind,
      // Index ids are prefixed "kind-<rawId>"; strip back to the entity id.
      id: item.id.slice(item.kind.length + 1),
      code: item.code,
      title: item.title,
      projectId: item.projectId,
    });
  }
  return hits;
}

const DAY_MS = 86_400_000;

/** Parse a YYYY-MM-DD calendar key into UTC-midnight ms; null if malformed. */
function dayStartMs(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Resolve a daily-plan filter into a [start, end) Date window, or null for "no
 * window" (all items). `date` matches a single day; `from`/`to` give a range
 * (either bound optional). Day keys are interpreted at UTC midnight, so a value
 * stored at the owner's local start-of-day can sit up to one TZ offset from the
 * boundary — fine for plan listing, where day granularity is what matters.
 */
function dailyDateRange(filter?: {
  date?: string;
  from?: string;
  to?: string;
}): { start: Date; end: Date } | null {
  if (!filter) return null;
  if (filter.date) {
    const s = dayStartMs(filter.date);
    return s == null ? null : { start: new Date(s), end: new Date(s + DAY_MS) };
  }
  if (filter.from || filter.to) {
    const s = filter.from ? dayStartMs(filter.from) : null;
    const e = filter.to ? dayStartMs(filter.to) : null;
    return {
      start: new Date(s ?? 0),
      end: new Date((e ?? dayStartMs(new Date().toISOString().slice(0, 10))!) + DAY_MS),
    };
  }
  return null;
}

/**
 * The viewer's own daily-plan items, earliest day first. Daily plans are
 * personal, so this is always scoped to the viewer (never another user's day).
 * Optional `date` (YYYY-MM-DD) or `from`/`to` range narrows the window.
 */
export async function listDailyTasks(
  viewer: Viewer,
  filter?: { date?: string; from?: string; to?: string },
): Promise<DailyTaskSummary[]> {
  const db = getDb();
  const clauses = [eq(dailyTasks.ownerId, viewer.id)];
  const range = dailyDateRange(filter);
  if (range) {
    clauses.push(gte(dailyTasks.plannedDate, range.start));
    clauses.push(lt(dailyTasks.plannedDate, range.end));
  }
  const rows = await db
    .select()
    .from(dailyTasks)
    .where(and(...clauses))
    .orderBy(asc(dailyTasks.plannedDate), asc(dailyTasks.sortOrder))
    .limit(MAX_ROWS);
  return rows.map((d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    status: d.status,
    priority: d.priority,
    kind: d.kind,
    plannedDate: d.plannedDate.toISOString(),
    projectId: d.projectId,
    linkedTaskId: d.linkedTaskId,
  }));
}

/**
 * A project's notes scratchpad (one per project). Returns null if the project
 * has no note yet or the viewer can't access it (never throws — no oracle).
 */
export async function readProjectNotes(
  viewer: Viewer,
  input: { projectId: string },
): Promise<ProjectNote | null> {
  if (!(await canAccessProject(viewer, input.projectId))) return null;
  const db = getDb();
  const [row] = await db
    .select()
    .from(projectNotes)
    .where(eq(projectNotes.projectId, input.projectId))
    .limit(1);
  if (!row) return null;
  return {
    projectId: row.projectId,
    content: row.content,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Project history (the audit log), newest first. With `projectId`, scoped to
 * that one accessible project; without it, across every project the viewer can
 * access. `changes` carries the structured before→after diffs when present.
 */
export async function listProjectActivity(
  viewer: Viewer,
  filter?: { projectId?: string; limit?: number },
): Promise<ActivityEntry[]> {
  const db = getDb();
  let scopeIds: string[];
  if (filter?.projectId) {
    if (!(await canAccessProject(viewer, filter.projectId))) return [];
    scopeIds = [filter.projectId];
  } else {
    scopeIds = await getPersonalProjectIds(viewer.id);
  }
  if (scopeIds.length === 0) return [];
  const limit = Math.min(filter?.limit ?? 50, MAX_ROWS);
  const rows = await db
    .select()
    .from(projectActivity)
    .where(inArray(projectActivity.projectId, scopeIds))
    .orderBy(desc(projectActivity.createdAt))
    .limit(limit);
  return rows.map((a) => ({
    id: a.id,
    projectId: a.projectId,
    entityType: a.entityType,
    entityId: a.entityId,
    action: a.action,
    label: a.label,
    detail: a.detail,
    changes: a.changes ?? null,
    actorId: a.ownerId,
    createdAt: a.createdAt.toISOString(),
  }));
}

/**
 * Published project status updates (the client-facing summaries), newest first.
 * With `projectId`, scoped to that one accessible project; without it, across
 * every project the viewer can access.
 */
export async function listStatusUpdates(
  viewer: Viewer,
  filter?: { projectId?: string },
): Promise<StatusUpdate[]> {
  const db = getDb();
  let scopeIds: string[];
  if (filter?.projectId) {
    if (!(await canAccessProject(viewer, filter.projectId))) return [];
    scopeIds = [filter.projectId];
  } else {
    scopeIds = await getPersonalProjectIds(viewer.id);
  }
  if (scopeIds.length === 0) return [];
  const rows = await db
    .select()
    .from(projectStatusUpdates)
    .where(inArray(projectStatusUpdates.projectId, scopeIds))
    .orderBy(desc(projectStatusUpdates.createdAt))
    .limit(MAX_ROWS);
  return rows.map((s) => ({
    id: s.id,
    projectId: s.projectId,
    taskId: s.taskId,
    summary: s.summary,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));
}
