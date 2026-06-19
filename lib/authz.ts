// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { and, eq, inArray } from "drizzle-orm";
import { cache } from "react";

import { getDb } from "@/lib/db";
import {
  projectMembers,
  projects,
  spaces,
  type ProjectMemberRole,
  type UserRole,
} from "@/lib/db/schema";
import { isAdminTier } from "@/lib/auth-server";
import {
  PROJECT_CAPABILITIES,
  resolveMemberPermissions,
  type ProjectCapability,
  type ProjectCapabilityDef,
} from "@/lib/project-capabilities";

type ViewerInput = { id: string; role: UserRole };

// A viewer's effective role on one project. The Owner is the project creator
// (projects.ownerId); Leader/Member come from project_members.role. Workspace
// owners/admins are super-users and resolve to "owner" for capability checks.
export type ProjectRole = "owner" | "leader" | "member";

// Space membership does NOT grant project access. A project is reachable only by
// its owner, an explicit project_members row, or a workspace admin — being a
// member of the project's space is irrelevant. Spaces are an organizational
// grouping + team roster (the lead manages it and can create projects in it);
// access is always invited per-project, and a person need not be in the space to
// be invited to a project that lives in it.

/**
 * Projects the user has a direct relationship with — they own it OR they're
 * in project_members. Used by personal pages (/dashboard, /today, /projects
 * list, sidebar) regardless of viewer role.
 */
export const getPersonalProjectIds = cache(
  async (userId: string): Promise<string[]> => {
    const db = getDb();
    const [owned, memberOf] = await Promise.all([
      db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.ownerId, userId)),
      db
        .select({ id: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, userId)),
    ]);
    return [
      ...new Set([
        ...owned.map((r) => r.id),
        ...memberOf.map((r) => r.id),
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

  // Space membership grants no access — only owner/member/admin above do.
  return false;
}

/**
 * The viewer's effective role on a project, or null if they have no access.
 * Workspace owner/admin → "owner" (super-user); the project creator → "owner";
 * a project_members row → its stored role ("leader" | "member"); else null.
 */
// Request-cached: a gated mutation (and bulk ops like setTaskCategory looping
// over many tasks) checks the role repeatedly for the same (viewer, project);
// cache() collapses those to one query per request, matching its siblings
// getProjectMemberPermissions.
export const getProjectRole = cache(async (
  viewer: ViewerInput,
  projectId: string,
): Promise<ProjectRole | null> => {
  if (isAdminTier(viewer.role)) return "owner";

  const db = getDb();
  const [project] = await db
    .select({ ownerId: projects.ownerId })
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

  // Space membership grants no role — only ownership / an explicit
  // project_members row / workspace admin does.
  return null;
});

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
 * Project IDs a viewer can see. Admin tier → every project; otherwise the
 * personal set (owned + explicit project membership). Space membership does not
 * widen this. Delegates to getPersonalProjectIds so visibility can't diverge
 * from access.
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

// Delegates to canAccessProject (same rule: admin / owner / explicit project
// membership) so visibility can't diverge from access.
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

/* ---------------------------------------------------------------------------
 * Per-project "Member Access" capabilities.
 *
 * A configurable RBAC layer over the "member" project role only. Owners,
 * Leaders, and workspace admins are NEVER gated by these toggles — they keep
 * the full Leader/Owner authority defined above. For a plain Member, each
 * capability is allowed or denied by the project's stored override (a JSON map
 * in projects.member_permissions), falling back to the code default below when
 * a key is unset. Defaults reproduce today's rules: the work a Member could
 * already do is ON; Leader-level management is OFF (an owner/leader can opt a
 * project's Members into it). Only owner/leader/admin may edit the toggles
 * (canManageProject), so a Member can never widen their own access.
 * ------------------------------------------------------------------------ */

// The pure catalog + resolver live in a dependency-free module (imported above)
// so client components and unit tests can use them without pulling in DB/Next
// code. Re-exported here so existing `@/lib/authz` import sites keep working.
export {
  PROJECT_CAPABILITIES,
  resolveMemberPermissions,
  type ProjectCapability,
  type ProjectCapabilityDef,
};

// A project's resolved Member-permission map (overrides merged over defaults).
// Cached per request so multiple capability checks on one project hit the DB once.
export const getProjectMemberPermissions = cache(
  async (projectId: string): Promise<Record<ProjectCapability, boolean>> => {
    const db = getDb();
    const [row] = await db
      .select({ memberPermissions: projects.memberPermissions })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return resolveMemberPermissions(row?.memberPermissions);
  },
);

/**
 * Can the viewer perform `capability` on the project? Workspace admin / project
 * owner / project leader are never gated (always true if they have the project).
 * A Member is allowed iff the project's resolved toggle for that capability is
 * on. No access at all → false.
 */
export async function canProjectCapability(
  viewer: ViewerInput,
  projectId: string,
  capability: ProjectCapability,
): Promise<boolean> {
  const role = await getProjectRole(viewer, projectId);
  if (role === null) return false;
  if (role === "owner" || role === "leader") return true;
  const perms = await getProjectMemberPermissions(projectId);
  return perms[capability] === true;
}
