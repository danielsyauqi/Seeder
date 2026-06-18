// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { and, eq, inArray } from "drizzle-orm";
import { cache } from "react";

import { getDb } from "@/lib/db";
import {
  projectMembers,
  projects,
  spaceMembers,
  spaces,
  type ProjectMemberRole,
  type UserRole,
} from "@/lib/db/schema";
import { isAdminTier } from "@/lib/auth-server";

type ViewerInput = { id: string; role: UserRole };

// A viewer's effective role on one project. The Owner is the project creator
// (projects.ownerId); Leader/Member come from project_members.role. Workspace
// owners/admins are super-users and resolve to "owner" for capability checks.
export type ProjectRole = "owner" | "leader" | "member";

/**
 * The COMPANY space ids the user is a member of. This is the one shared
 * predicate behind the Spaces access tier: being a member of a company space
 * grants baseline access to every project in it. Encoded ONCE here and applied
 * at both access chokepoints (getPersonalProjectIds for lists,
 * canAccessProject/getProjectRole for single projects) so a project can never
 * appear in a list it would 403 on, or be openable yet invisible. Personal
 * spaces are never returned here, so they stay owner-only.
 */
export const getCompanySpaceIds = cache(
  async (userId: string): Promise<string[]> => {
    const db = getDb();
    const rows = await db
      .select({ id: spaceMembers.spaceId })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(
        and(eq(spaceMembers.userId, userId), eq(spaces.kind, "company")),
      );
    return rows.map((row) => row.id);
  },
);

/**
 * Projects the user has a direct relationship with — they own it OR they're
 * in project_members. Used by personal pages (/dashboard, /today, /projects
 * list, sidebar) regardless of viewer role.
 */
export const getPersonalProjectIds = cache(
  async (userId: string): Promise<string[]> => {
    const db = getDb();
    const companySpaceIds = await getCompanySpaceIds(userId);
    const [owned, memberOf, spaceProjects] = await Promise.all([
      db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.ownerId, userId)),
      db
        .select({ id: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, userId)),
      // Every project in a company space the user belongs to.
      companySpaceIds.length
        ? db
            .select({ id: projects.id })
            .from(projects)
            .where(inArray(projects.spaceId, companySpaceIds))
        : Promise.resolve([] as { id: string }[]),
    ]);
    return [
      ...new Set([
        ...owned.map((r) => r.id),
        ...memberOf.map((r) => r.id),
        ...spaceProjects.map((r) => r.id),
      ]),
    ];
  },
);

/**
 * Resource-fetch authorization. Used by single-project detail pages and
 * mutation routes. Admin tier sees everything; members see only projects
 * they're in (owned or membership). Throws/returns false if not accessible.
 */
export async function canAccessProject(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  if (isAdminTier(viewer.role)) return true;

  const db = getDb();
  const [project] = await db
    .select({ ownerId: projects.ownerId, spaceId: projects.spaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return false;
  if (project.ownerId === viewer.id) return true;

  const [member] = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, viewer.id),
      ),
    )
    .limit(1);
  if (member) return true;

  // Baseline access via the project's company space (Personal spaces never
  // appear in getCompanySpaceIds, so they stay owner-only).
  if (project.spaceId) {
    const companySpaceIds = await getCompanySpaceIds(viewer.id);
    if (companySpaceIds.includes(project.spaceId)) return true;
  }

  return false;
}

/**
 * The viewer's effective role on a project, or null if they have no access.
 * Workspace owner/admin → "owner" (super-user); the project creator → "owner";
 * a project_members row → its stored role ("leader" | "member"); else null.
 */
export async function getProjectRole(
  viewer: ViewerInput,
  projectId: string,
): Promise<ProjectRole | null> {
  if (isAdminTier(viewer.role)) return "owner";

  const db = getDb();
  const [project] = await db
    .select({ ownerId: projects.ownerId, spaceId: projects.spaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  if (project.ownerId === viewer.id) return "owner";

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, viewer.id),
      ),
    )
    .limit(1);
  if (member?.role) return member.role as ProjectMemberRole;

  // No explicit role, but a member of the project's company space → baseline
  // "member". Personal-space projects never match (owner-only).
  if (project.spaceId) {
    const companySpaceIds = await getCompanySpaceIds(viewer.id);
    if (companySpaceIds.includes(project.spaceId)) return "member";
  }

  return null;
}

/**
 * Leader-level authority: edit project details, manage labels/categories/notes,
 * publish client updates, manage branches, convert requests, and add/remove
 * Members. Owner OR Leader (OR workspace admin). NOT enough to delete/archive
 * the project, manage the share link, change the project key, or set roles —
 * those require canAdministerProject.
 */
export async function canManageProject(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  const role = await getProjectRole(viewer, projectId);
  return role === "owner" || role === "leader";
}

/**
 * Owner-level authority: the structural / destructive / role-granting actions
 * a Leader can never do. Owner only (workspace admins included).
 */
export async function canAdministerProject(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  return (await getProjectRole(viewer, projectId)) === "owner";
}

/**
 * Project IDs a viewer can see. Admin tier → every project; otherwise the full
 * personal set (owned + explicit membership + company-space projects). Delegates
 * to getPersonalProjectIds so it can never diverge into a narrower rule that
 * would bypass the space tier.
 */
export async function visibleProjectIds(
  viewer: ViewerInput,
): Promise<string[]> {
  if (isAdminTier(viewer.role)) {
    const db = getDb();
    const rows = await db.select({ id: projects.id }).from(projects);
    return rows.map((row) => row.id);
  }
  return getPersonalProjectIds(viewer.id);
}

// Delegates to canAccessProject (same rule: admin / owner / explicit role /
// company-space member) so visibility can't diverge from access.
export async function canViewProject(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  return canAccessProject(viewer, projectId);
}

/**
 * Manage a COMPANY space (rename, delete, members, set lead): workspace admin OR
 * the space's lead. Personal spaces aren't "managed" — they're the owner's.
 */
export async function canManageSpace(
  viewer: ViewerInput,
  spaceId: string,
): Promise<boolean> {
  if (isAdminTier(viewer.role)) return true;
  const db = getDb();
  const [space] = await db
    .select({ kind: spaces.kind, leadId: spaces.leadId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space) return false;
  return space.kind === "company" && space.leadId === viewer.id;
}

/**
 * Create a project IN a space: the owner of a Personal space, or (for a Company
 * space) the lead / a workspace admin. Drives the create-modal picker + guards
 * a forged spaceId on create/move.
 */
export async function canPostToSpace(
  viewer: ViewerInput,
  spaceId: string,
): Promise<boolean> {
  const db = getDb();
  const [space] = await db
    .select({ kind: spaces.kind, ownerId: spaces.ownerId, leadId: spaces.leadId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space) return false;
  // Personal spaces are owner-only — even an admin must not park a project in
  // someone else's Personal space (its owner could never see it). Company
  // spaces: lead or any workspace admin.
  if (space.kind === "personal") return space.ownerId === viewer.id;
  if (isAdminTier(viewer.role)) return true;
  return space.leadId === viewer.id;
}

export async function canEditProject(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  // Project config edits are Leader-level (owner or leader).
  return canManageProject(viewer, projectId);
}

/**
 * Authority to add/remove members on a project — now Leader-level (owner or
 * leader, plus workspace admins). The finer rules (only the Owner may grant or
 * remove the Leader role; a Leader can only manage Members) live in the member
 * service, which knows each target's role.
 */
export async function canManageProjectMembers(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  return canManageProject(viewer, projectId);
}

/**
 * Filter helper for queries that need to scope by visible project IDs.
 * Returns a Drizzle clause: `projects.id IN (...visibleIds)`.
 * Returns null if the viewer can see nothing (caller should short-circuit).
 */
export async function visibleProjectClause(viewer: ViewerInput) {
  if (isAdminTier(viewer.role)) return null; // null = no filter needed
  const ids = await visibleProjectIds(viewer);
  if (ids.length === 0) return inArray(projects.id, ["__none__"]); // matches nothing
  return inArray(projects.id, ids);
}
