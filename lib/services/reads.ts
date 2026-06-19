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
import { parseRichText, richTextToPlainText } from "@/lib/rich-text";
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
  statusId: string; // non-strippable: the write path (update-task) needs it
  status: string; // status name (the project's custom column label)
  isTerminal: boolean;
  priority: Priority;
  projectId: string; // non-strippable: the write path needs it
  assigneeId: string | null;
  dueDate: string | null;
  // Verbose-only (presentational color / branch scoping); omitted from the lean
  // default so a full board doesn't carry 100 rows of hex + branch UUIDs.
  statusColor?: string;
  branchId?: string | null;
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
  branchId: string | null;
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
  id: string;
  content: string;
  createdAt: string;
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

type RichFormat = "plain" | "rich";

/**
 * Render a stored rich-text value (TipTap JSON) for an MCP read. Default "plain"
 * strips it to plain text — the big token win, since raw editor JSON is several
 * times larger than the text it carries. "rich" returns the raw stored doc for a
 * client that wants to re-render it. Null in → null out.
 */
function renderRichText(
  value: string | null,
  format: RichFormat = "plain",
): string | null {
  if (value == null) return null;
  if (format === "rich") return value;
  return richTextToPlainText(parseRichText(value));
}

/**
 * Plain-text-reduce the rich diffs inside an activity-changes array: a change of
 * kind "rich" carries raw TipTap JSON in from/to, so collapse those to plain text
 * so an opted-in caller doesn't pay the full editor-JSON token cost.
 */
function reduceChanges(
  changes: ActivityChange[] | null,
): ActivityChange[] | null {
  if (!changes) return null;
  return changes.map((c) =>
    c.kind === "rich"
      ? {
          ...c,
          from:
            c.from == null ? null : richTextToPlainText(parseRichText(c.from)),
          to: c.to == null ? null : richTextToPlainText(parseRichText(c.to)),
        }
      : c,
  );
}

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
  filter?: {
    projectId?: string;
    statusId?: string;
    assignedToMe?: boolean;
    branchId?: string;
    verbose?: boolean;
  },
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
  // Filter AND cap in SQL so the Worker only ever receives MAX_ROWS rows. The
  // previous version loaded every task in scope into memory and filtered/sliced
  // in JS, which scales with total tasks (not the 100 returned) and blew the
  // Worker's CPU/RAM under concurrent MCP load.
  const clauses = [inArray(tasks.projectId, scopeIds)];
  if (filter?.statusId) clauses.push(eq(tasks.statusId, filter.statusId));
  if (filter?.branchId) clauses.push(eq(tasks.branchId, filter.branchId));
  if (filter?.assignedToMe) clauses.push(eq(tasks.assigneeId, viewer.id));
  const capped = await db
    .select()
    .from(tasks)
    .where(and(...clauses))
    .orderBy(asc(tasks.sortOrder))
    .limit(MAX_ROWS);
  const slugs = await slugMap(capped.map((t) => t.projectId));
  return capped.map((t) => {
    const summary: TaskSummary = {
      id: t.id,
      code: formatTaskCode(slugs.get(t.projectId) ?? null, t.codeNumber),
      title: t.title,
      statusId: t.statusId,
      status: t.statusName,
      isTerminal: t.isTerminal,
      priority: t.priority,
      projectId: t.projectId,
      assigneeId: t.assigneeId,
      dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    };
    if (filter?.verbose) {
      summary.statusColor = t.statusColor;
      summary.branchId = t.branchId;
    }
    return summary;
  });
}

export async function readTask(
  viewer: Viewer,
  input: { projectId: string; taskId: string; format?: RichFormat },
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
    statusId: task.statusId,
    status: task.statusName,
    statusColor: task.statusColor,
    isTerminal: task.isTerminal,
    priority: task.priority,
    projectId: task.projectId,
    branchId: task.branchId,
    assigneeId: task.assigneeId,
    dueDate: task.dueDate ? task.dueDate.toISOString() : null,
    description: renderRichText(task.description, input.format),
    category: task.categoryId
      ? { id: task.categoryId, name: task.categoryName ?? "" }
      : null,
    checklist,
  };
}

export async function listRequests(
  viewer: Viewer,
  filter?: { projectId?: string; status?: RequestStatus; branchId?: string },
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
  // Filter + cap in SQL (see listTasks) — newest first, never a full-table load.
  const clauses = [inArray(clientRequests.projectId, scopeIds)];
  if (filter?.status) clauses.push(eq(clientRequests.status, filter.status));
  if (filter?.branchId) clauses.push(eq(clientRequests.branchId, filter.branchId));
  const capped = await db
    .select()
    .from(clientRequests)
    .where(and(...clauses))
    .orderBy(desc(clientRequests.createdAt))
    .limit(MAX_ROWS);
  const slugs = await slugMap(capped.map((r) => r.projectId));
  return capped.map((r) => ({
    id: r.id,
    code: formatRequestCode(slugs.get(r.projectId) ?? null, r.codeNumber),
    title: r.title,
    status: r.status,
    priority: r.priority,
    projectId: r.projectId,
    branchId: r.branchId,
  }));
}

export async function readRequest(
  viewer: Viewer,
  input: { projectId: string; requestId: string; format?: RichFormat },
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
    branchId: row.branchId,
    description: renderRichText(row.description, input.format),
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
 * A project's notes, newest first. Returns [] if the project has no notes or the
 * viewer can't access it (never throws — no oracle).
 */
export async function listProjectNotes(
  viewer: Viewer,
  input: { projectId: string; format?: RichFormat },
): Promise<ProjectNote[]> {
  if (!(await canAccessProject(viewer, input.projectId))) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(projectNotes)
    .where(eq(projectNotes.projectId, input.projectId))
    .orderBy(desc(projectNotes.createdAt));
  return rows.map((row) => ({
    id: row.id,
    content: renderRichText(row.content, input.format) ?? "",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Project history (the audit log), newest first. With `projectId`, scoped to
 * that one accessible project; without it, across every project the viewer can
 * access. `changes` carries the structured before→after diffs when present.
 */
export async function listProjectActivity(
  viewer: Viewer,
  filter?: { projectId?: string; limit?: number; includeChanges?: boolean },
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
    changes: filter?.includeChanges ? reduceChanges(a.changes ?? null) : null,
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
