// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { and, eq, inArray } from "drizzle-orm";
import { cache } from "react";

import { getDb } from "@/lib/db";
import {
  projectMembers,
  projects,
  type UserRole,
} from "@/lib/db/schema";
import { isAdminTier } from "@/lib/auth-server";

type ViewerInput = { id: string; role: UserRole };

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
    return [...new Set([...owned.map((r) => r.id), ...memberOf.map((r) => r.id)])];
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
    .select({ ownerId: projects.ownerId })
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

  return Boolean(member);
}

/**
 * Returns the project IDs a viewer can see.
 * - Admin tier (owner/admin): every project.
 * - Member: only projects they're explicitly a member of.
 *
 * Phase 1 ships this helper; Phase 2 wires it into lib/data.ts queries.
 */
export async function visibleProjectIds(
  viewer: ViewerInput,
): Promise<string[]> {
  const db = getDb();

  if (isAdminTier(viewer.role)) {
    const rows = await db.select({ id: projects.id }).from(projects);
    return rows.map((row) => row.id);
  }

  const rows = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, viewer.id));
  return rows.map((row) => row.id);
}

export async function canViewProject(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  if (isAdminTier(viewer.role)) return true;

  const db = getDb();
  const [row] = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, viewer.id),
      ),
    )
    .limit(1);

  return Boolean(row);
}

export async function canEditProject(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  // Phase 1: any project member can edit. Project-level lead role lands later.
  return canViewProject(viewer, projectId);
}

/**
 * Authority to add/remove members on a specific project.
 * - Admin tier (owner/admin user role) → yes, on any project.
 * - The project owner (projects.ownerId) → yes on their project, even if
 *   their user role is just 'member'.
 * - Everyone else → no.
 */
export async function canManageProjectMembers(
  viewer: ViewerInput,
  projectId: string,
): Promise<boolean> {
  if (isAdminTier(viewer.role)) return true;

  const db = getDb();
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  return project?.ownerId === viewer.id;
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
