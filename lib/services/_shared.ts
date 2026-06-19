// Shared mutation helpers for the workspace service layer. Plain module (NO
// "use server") — imported by BOTH the web route handler (app/api/workspace)
// and the MCP server. Moved verbatim from app/api/workspace/route.ts so web
// behavior is unchanged; the route and MCP now share one implementation.
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";

import type { Viewer } from "@/lib/auth-server";
import {
  canAdministerProject,
  canManageProject,
  getProjectMemberPermissions,
  getProjectRole,
  type ProjectCapability,
} from "@/lib/authz";
import { getDb } from "@/lib/db";
import {
  branches,
  clientRequests,
  projectMembers,
  projects,
  taskCategories,
  taskChecklistItems,
  taskStatuses,
  tasks,
  user,
} from "@/lib/db/schema";

/**
 * The denormalized status fields written onto every task row. Mirrors the
 * categoryName/categoryColor cache: a task carries its status's id, name, color,
 * and terminal flag so reads never join task_statuses. The status service
 * resyncs these on rename/recolor/terminal-toggle.
 */
export type ResolvedStatus = {
  statusId: string;
  statusName: string;
  statusColor: string;
  isTerminal: boolean;
};

/**
 * D1/SQLite reports a unique-index violation as an Error whose message contains
 * "UNIQUE constraint failed". Code numbers are allocated MAX+1 in a separate
 * statement from the insert, and the web route and MCP server can create rows
 * concurrently, so a colliding insert against UNIQUE(project_id, code_number)
 * is retried (recomputing the number) rather than surfaced to the caller.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /UNIQUE constraint failed/i.test(message);
}

/** Optional trimmed string: "" and missing both collapse to undefined. */
export const optionalText = z
  .string()
  .trim()
  .transform((value) => (value.length ? value : undefined))
  .optional()
  .or(z.literal("").transform(() => undefined));

/** Map user ids → display names, for assignee before→after diffs. */
export async function userNameMap(
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Short single-line preview of a checklist item's content for the log detail. */
export function checklistExcerpt(content: string): string {
  const text = content.trim();
  return text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}…`;
}

export function parseDate(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

/**
 * Like parseDate, but THROWS on a non-empty unparseable value instead of
 * silently coercing it to null. Used by the write services so an MCP/AI client
 * that sends a malformed date gets an actionable tool error rather than having
 * the due date quietly dropped while the call reports success.
 */
export function resolveDueDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid due date "${value}". Use an ISO-8601 date such as 2026-06-04.`,
    );
  }
  return parsed;
}

export async function resolveCategory(
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

/**
 * Owner-only gate for project-scoped management (notes, status updates,
 * categories, labels) — mirrors the web app's assertProjectOwnership. Uses the
 * same opaque "Project not found." so a non-owner can't distinguish a missing
 * project from one they don't own (no existence oracle).
 */
export async function assertProjectOwner(viewer: Viewer, projectId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, viewer.id)))
    .limit(1);

  if (!project) throw new Error("Project not found.");
  return project;
}

/**
 * Leader-level gate (owner or leader, plus workspace admins): project config +
 * content — details, labels, categories, notes, client updates, branch
 * management, request conversion. Opaque "Project not found." for non-managers.
 */
export async function assertProjectManage(viewer: Viewer, projectId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project not found.");
  if (!(await canManageProject(viewer, projectId))) {
    throw new Error("Project not found.");
  }
  return project;
}

/**
 * Owner-level gate: the structural / destructive / role-granting actions
 * (delete, archive, duplicate, project key, share link, member roles). Opaque
 * "Project not found." for everyone below Owner.
 */
export async function assertProjectAdminister(viewer: Viewer, projectId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project not found.");
  if (!(await canAdministerProject(viewer, projectId))) {
    throw new Error("Project not found.");
  }
  return project;
}

/**
 * Capability gate for the per-project "Member Access" RBAC. Owner / leader /
 * admin always pass (never gated by the toggles); a Member passes only if the
 * project's resolved toggle for `capability` is on. Distinguishes the two
 * failure modes: no access at all → opaque "Project not found." (no existence
 * oracle); has access but the toggle is off → a clear permission error.
 */
export async function assertProjectCapability(
  viewer: Viewer,
  projectId: string,
  capability: ProjectCapability,
) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project not found.");

  const role = await getProjectRole(viewer, projectId);
  if (role === null) throw new Error("Project not found.");
  if (role === "owner" || role === "leader") return project;

  const perms = await getProjectMemberPermissions(projectId);
  if (perms[capability] !== true) {
    throw new Error("You don't have permission for this action on this project.");
  }
  return project;
}

export async function resolveAssignee(
  candidate: string | undefined,
  projectId: string,
): Promise<string | null> {
  if (!candidate) return null;

  const db = getDb();
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project not found.");
  if (project.ownerId === candidate) return candidate;

  const [member] = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, candidate),
      ),
    )
    .limit(1);
  if (!member) throw new Error("Assignee is not a member of this project.");
  return candidate;
}

export async function assertTaskInProject(taskId: string, projectId: string) {
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

export async function getNextTaskSortOrder(
  projectId: string,
  statusId: string,
  branchId: string,
) {
  const db = getDb();
  const [latest] = await db
    .select({
      sortOrder: tasks.sortOrder,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.branchId, branchId),
        eq(tasks.statusId, statusId),
      ),
    )
    .orderBy(desc(tasks.sortOrder))
    .limit(1);

  return (latest?.sortOrder ?? -1) + 1;
}

/**
 * The column a newly-created task lands in: the project's flagged initial status,
 * falling back to the lowest-sorted column. Replaces the old hardcoded "todo".
 * Throws if the project somehow has no statuses (corrupt data — every project is
 * seeded by migration 0034 and createProject).
 */
export async function getProjectInitialStatus(
  projectId: string,
): Promise<ResolvedStatus> {
  const db = getDb();
  const [row] = await db
    .select({
      id: taskStatuses.id,
      name: taskStatuses.name,
      color: taskStatuses.color,
      isTerminal: taskStatuses.isTerminal,
    })
    .from(taskStatuses)
    .where(eq(taskStatuses.projectId, projectId))
    .orderBy(desc(taskStatuses.isInitial), asc(taskStatuses.sortOrder))
    .limit(1);
  if (!row) throw new Error("Project has no statuses.");
  return {
    statusId: row.id,
    statusName: row.name,
    statusColor: row.color,
    isTerminal: row.isTerminal,
  };
}

/**
 * Resolve the status fields to write on a task. An explicit statusId is validated
 * against the project (a foreign/unknown id throws, so a bad call fails loudly
 * rather than silently moving the task to another column); omitted → the
 * project's initial status. Returns the denormalized cache written onto tasks.
 */
export async function resolveStatusForWrite(
  statusId: string | undefined | null,
  projectId: string,
): Promise<ResolvedStatus> {
  if (!statusId) return getProjectInitialStatus(projectId);
  const db = getDb();
  const [row] = await db
    .select({
      id: taskStatuses.id,
      name: taskStatuses.name,
      color: taskStatuses.color,
      isTerminal: taskStatuses.isTerminal,
      projectId: taskStatuses.projectId,
    })
    .from(taskStatuses)
    .where(eq(taskStatuses.id, statusId))
    .limit(1);
  if (!row || row.projectId !== projectId) {
    throw new Error("Status not found in this project.");
  }
  return {
    statusId: row.id,
    statusName: row.name,
    statusColor: row.color,
    isTerminal: row.isTerminal,
  };
}

/**
 * The project's default ("Main") branch id. Every project has exactly one —
 * createProject inserts it atomically, and migration 0030 backfilled all
 * pre-existing projects — so a missing one means corrupt data, surfaced loudly.
 */
export async function resolveDefaultBranchId(projectId: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.projectId, projectId), eq(branches.isDefault, true)))
    .limit(1);
  if (!row) throw new Error("Project has no default branch.");
  return row.id;
}

/**
 * Resolve which branch a task/request belongs on. An explicit id is validated
 * against the project (a foreign/unknown id throws, so a bad MCP call fails
 * loudly instead of silently writing to Main); omitted → the Main branch.
 */
export async function resolveBranchId(
  branchId: string | undefined | null,
  projectId: string,
): Promise<string> {
  if (!branchId) return resolveDefaultBranchId(projectId);
  const db = getDb();
  const [row] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error("Branch not found in this project.");
  return row.id;
}

export async function nextTaskCodeNumber(projectId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: max(tasks.codeNumber) })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));
  return (row?.value ?? 0) + 1;
}

export async function nextRequestCodeNumber(
  projectId: string,
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ value: max(clientRequests.codeNumber) })
    .from(clientRequests)
    .where(eq(clientRequests.projectId, projectId));
  return (row?.value ?? 0) + 1;
}

export async function getProjectSlug(projectId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.slug ?? null;
}

export async function getNextChecklistSortOrder(taskId: string) {
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

export async function touchProject(projectId: string, updatedAt = new Date()) {
  const db = getDb();

  await db
    .update(projects)
    .set({
      updatedAt,
    })
    .where(eq(projects.id, projectId));
}

export async function touchTask(taskId: string, updatedAt = new Date()) {
  const db = getDb();

  await db
    .update(tasks)
    .set({
      updatedAt,
    })
    .where(eq(tasks.id, taskId));
}
