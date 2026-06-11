import { and, asc, count, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import { getDb } from "@/lib/db";
import {
  clientRequests,
  dailyTasks,
  invitations,
  projectActivity,
  projectMembers,
  projects,
  projectStatusUpdates,
  taskChecklistItems,
  tasks,
  user,
  type ProjectStatus,
  type UserRole,
} from "@/lib/db/schema";
import { computeDashboard } from "@/lib/data";

// Workspace-wide reads. Used by /admin/* pages where the viewer has
// admin/owner role and sees all data, not just their own.
//
// Phase 4 sits before Phase 2 — until then there's only one user, so these
// queries return the same content as the user-scoped variants. They're
// structured to scale: once Phase 2 adds member rows + per-row authorship
// for non-owner accounts, these naturally expand.

export async function getWorkspaceDashboard() {
  const db = getDb();
  const cutoff = new Date(Date.now() - 365 * 86_400_000);

  const [
    allProjects,
    requestsForOwner,
    tasksForOwner,
    statusUpdatesForOwner,
    activityRows,
    completedSubtasks,
  ] = await Promise.all([
    db.select().from(projects),
    db.select().from(clientRequests),
    db.select().from(tasks),
    db.select().from(projectStatusUpdates),
    db
      .select({
        id: projectActivity.id,
        projectId: projectActivity.projectId,
        createdAt: projectActivity.createdAt,
      })
      .from(projectActivity)
      .where(gte(projectActivity.createdAt, cutoff)),
    db
      .select({
        id: taskChecklistItems.id,
        completedAt: taskChecklistItems.completedAt,
      })
      .from(taskChecklistItems)
      .where(eq(taskChecklistItems.isCompleted, true)),
  ]);

  return computeDashboard(
    { allProjects, requestsForOwner, tasksForOwner, statusUpdatesForOwner },
    activityRows,
    completedSubtasks,
  );
}

export type WorkspaceUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  image: string | null;
  disabledAt: Date | null;
  createdAt: Date;
  lastActiveAt: Date | null;
  projectsOwned: number;
  projectsMember: number;
};

export async function listWorkspaceUsers(): Promise<WorkspaceUser[]> {
  const db = getDb();

  const [users, ownedCounts, memberCounts, lastActivity] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        image: user.image,
        disabledAt: user.disabledAt,
        createdAt: user.createdAt,
      })
      .from(user)
      .orderBy(desc(user.createdAt)),
    db
      .select({
        ownerId: projects.ownerId,
        c: count(projects.id),
      })
      .from(projects)
      .groupBy(projects.ownerId),
    db
      .select({
        userId: projectMembers.userId,
        c: count(projectMembers.id),
      })
      .from(projectMembers)
      .groupBy(projectMembers.userId),
    db
      .select({
        ownerId: projectActivity.ownerId,
        latest: sql<number>`MAX(${projectActivity.createdAt})`.as("latest"),
      })
      .from(projectActivity)
      .groupBy(projectActivity.ownerId),
  ]);

  const ownedById = new Map(ownedCounts.map((row) => [row.ownerId, row.c]));
  const memberById = new Map(memberCounts.map((row) => [row.userId, row.c]));
  const lastById = new Map(
    lastActivity.map((row) => [
      row.ownerId,
      row.latest != null ? new Date(Number(row.latest)) : null,
    ]),
  );

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    image: u.image,
    disabledAt: u.disabledAt,
    createdAt: u.createdAt,
    lastActiveAt: lastById.get(u.id) ?? null,
    projectsOwned: ownedById.get(u.id) ?? 0,
    projectsMember: memberById.get(u.id) ?? 0,
  }));
}

export type AdminProjectSummary = {
  id: string;
  name: string;
  slug: string | null;
  clientName: string | null;
  summary: string | null;
  status: ProjectStatus;
  color: string | null;
  deadline: Date | null;
  archivedAt: Date | null;
  updatedAt: Date;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  memberCount: number;
  tasksTodo: number;
  tasksDoing: number;
  tasksDone: number;
  totalTasks: number;
};

// Every project in the workspace, across all owners — for the admin Projects
// index (repo-list view). Counts are aggregated in two grouped queries rather
// than per-project to keep it to three round-trips total.
export async function listAllProjects(): Promise<AdminProjectSummary[]> {
  const db = getDb();

  const [rows, taskCounts, memberCounts] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        clientName: projects.clientName,
        summary: projects.summary,
        status: projects.status,
        color: projects.color,
        deadline: projects.deadline,
        archivedAt: projects.archivedAt,
        updatedAt: projects.updatedAt,
        ownerId: projects.ownerId,
        ownerName: user.name,
        ownerEmail: user.email,
      })
      .from(projects)
      .leftJoin(user, eq(user.id, projects.ownerId))
      .orderBy(desc(projects.updatedAt)),
    db
      .select({
        projectId: tasks.projectId,
        status: tasks.status,
        c: count(tasks.id),
      })
      .from(tasks)
      .groupBy(tasks.projectId, tasks.status),
    db
      .select({
        projectId: projectMembers.projectId,
        c: count(projectMembers.id),
      })
      .from(projectMembers)
      .groupBy(projectMembers.projectId),
  ]);

  const memberById = new Map(memberCounts.map((row) => [row.projectId, row.c]));
  const taskById = new Map<string, { todo: number; doing: number; done: number }>();
  for (const row of taskCounts) {
    const bucket = taskById.get(row.projectId) ?? { todo: 0, doing: 0, done: 0 };
    bucket[row.status] = row.c;
    taskById.set(row.projectId, bucket);
  }

  return rows.map((p) => {
    const t = taskById.get(p.id) ?? { todo: 0, doing: 0, done: 0 };
    return {
      ...p,
      memberCount: memberById.get(p.id) ?? 0,
      tasksTodo: t.todo,
      tasksDoing: t.doing,
      tasksDone: t.done,
      totalTasks: t.todo + t.doing + t.done,
    };
  });
}

export async function getWorkspaceTotals() {
  const db = getDb();

  const [users, pendingInvites, allProjects, activeProjects] = await Promise.all([
    db.select({ c: count(user.id) }).from(user),
    db
      .select({ c: count(invitations.id) })
      .from(invitations)
      .where(
        and(
          sql`${invitations.acceptedAt} IS NULL`,
          gte(invitations.expiresAt, new Date()),
        ),
      ),
    db.select({ c: count(projects.id) }).from(projects),
    db
      .select({ c: count(projects.id) })
      .from(projects)
      .where(sql`${projects.archivedAt} IS NULL`),
  ]);

  return {
    users: users[0]?.c ?? 0,
    pendingInvites: pendingInvites[0]?.c ?? 0,
    projectsTotal: allProjects[0]?.c ?? 0,
    projectsActive: activeProjects[0]?.c ?? 0,
  };
}

export type WorkspaceActivityItem = {
  id: string;
  projectId: string;
  projectName: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  entityType: string;
  entityId: string;
  action: string;
  label: string;
  detail: string | null;
  createdAt: Date;
};

export type ActivityFilters = {
  from?: Date;
  to?: Date;
  projectId?: string;
  actorId?: string;
};

function buildActivityWhere(filters: ActivityFilters): SQL | undefined {
  const clauses: SQL[] = [];
  if (filters.from) {
    clauses.push(gte(projectActivity.createdAt, filters.from));
  }
  if (filters.to) {
    // Exclusive upper bound: "to" inclusive day means createdAt < (to + 1 day)
    const exclusive = new Date(filters.to.getTime() + 86_400_000);
    clauses.push(lt(projectActivity.createdAt, exclusive));
  }
  if (filters.projectId) {
    clauses.push(eq(projectActivity.projectId, filters.projectId));
  }
  if (filters.actorId) {
    clauses.push(eq(projectActivity.ownerId, filters.actorId));
  }
  return clauses.length ? and(...clauses) : undefined;
}

export async function listWorkspaceActivity(
  filters: ActivityFilters = {},
  limit: number = 100,
): Promise<WorkspaceActivityItem[]> {
  const db = getDb();
  const where = buildActivityWhere(filters);

  const rows = await db
    .select({
      id: projectActivity.id,
      projectId: projectActivity.projectId,
      projectName: projects.name,
      actorId: projectActivity.ownerId,
      actorName: user.name,
      actorEmail: user.email,
      entityType: projectActivity.entityType,
      entityId: projectActivity.entityId,
      action: projectActivity.action,
      label: projectActivity.label,
      detail: projectActivity.detail,
      createdAt: projectActivity.createdAt,
    })
    .from(projectActivity)
    .leftJoin(projects, eq(projects.id, projectActivity.projectId))
    .leftJoin(user, eq(user.id, projectActivity.ownerId))
    .where(where)
    .orderBy(desc(projectActivity.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    projectName: r.projectName ?? "Unknown project",
    actorId: r.actorId,
    actorName: r.actorName ?? "Unknown",
    actorEmail: r.actorEmail ?? "",
    entityType: r.entityType,
    entityId: r.entityId,
    action: r.action,
    label: r.label,
    detail: r.detail,
    createdAt: r.createdAt,
  }));
}

/**
 * Brief project/user lists for filter dropdowns.
 */
export async function listProjectsBrief() {
  const db = getDb();
  return db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .orderBy(asc(projects.name));
}

export async function listUsersBrief() {
  const db = getDb();
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(user)
    .orderBy(asc(user.name));
}

/**
 * Every user's daily-ops items for a single calendar day. Joins the owner and
 * the creator ("assigned by"), the project, and the linked board task's live
 * status. The caller groups rows by ownerId to render per-user columns/rows.
 */
export async function getDailyOpsForDate(date: Date) {
  const db = getDb();
  const dayStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const ownerUser = alias(user, "owner_user");
  const creatorUser = alias(user, "creator_user");

  return db
    .select({
      id: dailyTasks.id,
      ownerId: dailyTasks.ownerId,
      ownerName: ownerUser.name,
      ownerEmail: ownerUser.email,
      createdById: dailyTasks.createdById,
      createdByName: creatorUser.name,
      plannedDate: dailyTasks.plannedDate,
      title: dailyTasks.title,
      description: dailyTasks.description,
      status: dailyTasks.status,
      priority: dailyTasks.priority,
      kind: dailyTasks.kind,
      projectId: dailyTasks.projectId,
      projectName: projects.name,
      projectColor: projects.color,
      linkedTaskId: dailyTasks.linkedTaskId,
      linkedStatus: tasks.status,
      sortOrder: dailyTasks.sortOrder,
      batchId: dailyTasks.batchId,
    })
    .from(dailyTasks)
    .leftJoin(ownerUser, eq(ownerUser.id, dailyTasks.ownerId))
    .leftJoin(creatorUser, eq(creatorUser.id, dailyTasks.createdById))
    .leftJoin(projects, eq(projects.id, dailyTasks.projectId))
    .leftJoin(tasks, eq(tasks.id, dailyTasks.linkedTaskId))
    .where(
      and(
        gte(dailyTasks.plannedDate, dayStart),
        lt(dailyTasks.plannedDate, dayEnd),
      ),
    )
    .orderBy(asc(ownerUser.name), asc(dailyTasks.sortOrder));
}

export type DailyOpsRow = Awaited<ReturnType<typeof getDailyOpsForDate>>[number];
