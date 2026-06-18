// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Space services — shared by the web routes/actions and the MCP server. A Space
// groups projects and is the lowest-precedence access tier (see lib/authz.ts):
// Personal spaces are private to their owner; Company spaces are shared —
// members get baseline access to all the space's projects, and a Space Lead
// (+ workspace admins) manage them. Authz: creating a company space is
// workspace-admin only; rename/delete/members/lead require canManageSpace
// (admin or lead); moving a project requires owner-on-the-project + post rights
// on the target space. Personal spaces are auto-provisioned (ensurePersonalSpace).
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { logProjectActivity } from "@/lib/activity";
import { isAdminTier, type Viewer } from "@/lib/auth-server";
import {
  canAdministerProject,
  canManageSpace,
  canPostToSpace,
} from "@/lib/authz";
import { getDb } from "@/lib/db";
import { projects, spaceMembers, spaces, user } from "@/lib/db/schema";

// --- Provisioning ------------------------------------------------------------

/**
 * Guarantee the user has their one Personal space and return its id. Called at
 * every user-creation path so a user always has a default home before they can
 * create a project. Idempotent: re-reads on the partial-unique collision from a
 * concurrent create. Safe to call repeatedly.
 */
export async function ensurePersonalSpace(userId: string): Promise<string> {
  const db = getDb();

  const findExisting = async () => {
    const [row] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.ownerId, userId), eq(spaces.kind, "personal")))
      .limit(1);
    return row?.id ?? null;
  };

  const existing = await findExisting();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = new Date();
  try {
    await db.insert(spaces).values({
      id,
      kind: "personal",
      name: "Personal",
      ownerId: userId,
      leadId: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  } catch (error) {
    const raced = await findExisting();
    if (raced) return raced;
    throw error;
  }
}

/**
 * Resolve the space a new project should live in. An explicit spaceId is
 * validated with canPostToSpace (throws on a space the viewer can't post to, so
 * a forged id can't plant a project in someone else's space); omitted → the
 * viewer's Personal space.
 */
export async function resolveSpaceForCreate(
  viewer: Viewer,
  spaceId: string | undefined | null,
): Promise<string> {
  if (!spaceId) return ensurePersonalSpace(viewer.id);
  if (!(await canPostToSpace(viewer, spaceId))) {
    throw new Error("You can't create a project in that space.");
  }
  return spaceId;
}

// --- Read --------------------------------------------------------------------

export type SpaceSummary = {
  id: string;
  kind: "personal" | "company";
  name: string;
  leadId: string | null;
  leadName: string | null;
  isLead: boolean;
  canPost: boolean;
  memberCount: number;
  projectCount: number;
};

/**
 * Spaces the viewer can see: their own Personal space, plus Company spaces they
 * belong to or lead (workspace admins see ALL company spaces). Drives the
 * create-project picker and the Spaces management page.
 */
export async function listSpaces(viewer: Viewer): Promise<SpaceSummary[]> {
  const db = getDb();
  const admin = isAdminTier(viewer.role);

  const companyMemberIds = admin
    ? null
    : new Set(
        (
          await db
            .select({ spaceId: spaceMembers.spaceId })
            .from(spaceMembers)
            .where(eq(spaceMembers.userId, viewer.id))
        ).map((r) => r.spaceId),
      );

  const rows = await db
    .select({
      id: spaces.id,
      kind: spaces.kind,
      name: spaces.name,
      ownerId: spaces.ownerId,
      leadId: spaces.leadId,
      leadName: user.name,
    })
    .from(spaces)
    .leftJoin(user, eq(user.id, spaces.leadId))
    .orderBy(desc(spaces.kind)); // 'personal' < 'company' alpha → company first via desc

  const visible = rows.filter((s) => {
    if (s.kind === "personal") return s.ownerId === viewer.id;
    // company
    return admin || companyMemberIds!.has(s.id) || s.leadId === viewer.id;
  });
  if (!visible.length) return [];

  const visibleIds = visible.map((s) => s.id);
  const [memberCounts, projectCounts] = await Promise.all([
    db
      .select({ spaceId: spaceMembers.spaceId, n: count() })
      .from(spaceMembers)
      .where(inArray(spaceMembers.spaceId, visibleIds))
      .groupBy(spaceMembers.spaceId),
    db
      .select({ spaceId: projects.spaceId, n: count() })
      .from(projects)
      .where(inArray(projects.spaceId, visibleIds))
      .groupBy(projects.spaceId),
  ]);
  const memberBy = new Map(memberCounts.map((c) => [c.spaceId, c.n]));
  const projectBy = new Map(projectCounts.map((c) => [c.spaceId, c.n]));

  return visible.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    leadId: s.leadId,
    leadName: s.leadName,
    isLead: s.leadId === viewer.id,
    canPost:
      s.kind === "personal"
        ? s.ownerId === viewer.id
        : admin || s.leadId === viewer.id,
    memberCount: memberBy.get(s.id) ?? 0,
    projectCount: projectBy.get(s.id) ?? 0,
  }));
}

export type SpaceMemberRow = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  isLead: boolean;
};

/** Members of a company space (with the lead flagged). Manager-gated. */
export async function listSpaceMembers(
  viewer: Viewer,
  spaceId: string,
): Promise<SpaceMemberRow[]> {
  if (!(await canManageSpace(viewer, spaceId))) return [];
  const db = getDb();
  const [space] = await db
    .select({ leadId: spaces.leadId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space) return [];
  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(spaceMembers)
    .innerJoin(user, eq(user.id, spaceMembers.userId))
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(desc(spaceMembers.createdAt));
  return rows.map((r) => ({ ...r, isLead: r.userId === space.leadId }));
}

// --- Input schemas -----------------------------------------------------------

export const createSpaceInputSchema = z.object({
  name: z.string().trim().min(1).max(80).describe("Company space name."),
});
export type CreateSpaceInput = z.infer<typeof createSpaceInputSchema>;

export const renameSpaceInputSchema = z.object({
  spaceId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
});
export type RenameSpaceInput = z.infer<typeof renameSpaceInputSchema>;

export const deleteSpaceInputSchema = z.object({ spaceId: z.string().min(1) });
export type DeleteSpaceInput = z.infer<typeof deleteSpaceInputSchema>;

export const addSpaceMemberInputSchema = z.object({
  spaceId: z.string().min(1),
  email: z.email().transform((v) => v.toLowerCase()).optional(),
  userId: z.string().min(1).optional(),
});
export type AddSpaceMemberInput = z.infer<typeof addSpaceMemberInputSchema>;

export const removeSpaceMemberInputSchema = z.object({
  spaceId: z.string().min(1),
  userId: z.string().min(1),
});
export type RemoveSpaceMemberInput = z.infer<
  typeof removeSpaceMemberInputSchema
>;

export const setSpaceLeadInputSchema = z.object({
  spaceId: z.string().min(1),
  userId: z.string().min(1),
});
export type SetSpaceLeadInput = z.infer<typeof setSpaceLeadInputSchema>;

export const moveProjectToSpaceInputSchema = z.object({
  projectId: z.string().min(1),
  spaceId: z.string().min(1),
});
export type MoveProjectToSpaceInput = z.infer<
  typeof moveProjectToSpaceInputSchema
>;

// --- Helpers -----------------------------------------------------------------

async function loadCompanySpace(spaceId: string) {
  const db = getDb();
  const [space] = await db
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space || space.kind !== "company") {
    throw new Error("Space not found.");
  }
  return space;
}

async function resolveWorkspaceUser(input: {
  email?: string;
  userId?: string;
}): Promise<string> {
  if (!input.userId && !input.email) {
    throw new Error("Provide an email or a userId of the person to add.");
  }
  const db = getDb();
  const [target] = input.userId
    ? await db.select({ id: user.id }).from(user).where(eq(user.id, input.userId)).limit(1)
    : await db.select({ id: user.id }).from(user).where(eq(user.email, input.email!)).limit(1);
  if (!target) throw new Error("No user with that email or id. Invite them first.");
  return target.id;
}

// --- Services ----------------------------------------------------------------

export async function createSpace(
  viewer: Viewer,
  input: CreateSpaceInput,
): Promise<{ spaceId: string; name: string }> {
  // Creating a (company) space is a workspace-admin action.
  if (!isAdminTier(viewer.role)) {
    throw new Error("Only workspace owners and admins can create a company space.");
  }
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date();
  await db.batch([
    db.insert(spaces).values({
      id,
      kind: "company",
      name: input.name,
      ownerId: null,
      leadId: viewer.id, // creator is the initial lead; reassign via setSpaceLead
      createdBy: viewer.id,
      createdAt: now,
      updatedAt: now,
    }),
    // The lead is also a member, so they're counted/listed and (if later
    // demoted from admin) keep space-tier access.
    db.insert(spaceMembers).values({
      id: crypto.randomUUID(),
      spaceId: id,
      userId: viewer.id,
      addedById: viewer.id,
      createdAt: now,
    }),
  ]);
  return { spaceId: id, name: input.name };
}

export async function renameSpace(
  viewer: Viewer,
  input: RenameSpaceInput,
): Promise<{ spaceId: string; name: string }> {
  if (!(await canManageSpace(viewer, input.spaceId))) {
    throw new Error("You can't manage that space.");
  }
  const space = await loadCompanySpace(input.spaceId);
  const db = getDb();
  await db
    .update(spaces)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(spaces.id, space.id));
  return { spaceId: space.id, name: input.name };
}

export async function deleteSpace(
  viewer: Viewer,
  input: DeleteSpaceInput,
): Promise<{ spaceId: string }> {
  if (!(await canManageSpace(viewer, input.spaceId))) {
    throw new Error("You can't manage that space.");
  }
  const space = await loadCompanySpace(input.spaceId);
  const db = getDb();
  // Refuse if the space still holds projects — deletion must never cascade into
  // destroying projects (and their tasks/branches/requests). Reassign first.
  const [{ n }] = await db
    .select({ n: count() })
    .from(projects)
    .where(eq(projects.spaceId, space.id));
  if (n > 0) {
    throw new Error(
      `This space still has ${n} project${n === 1 ? "" : "s"}. Move or delete them first.`,
    );
  }
  // space_members cascade off the space row.
  await db.delete(spaces).where(eq(spaces.id, space.id));
  return { spaceId: space.id };
}

export async function addSpaceMember(
  viewer: Viewer,
  input: AddSpaceMemberInput,
): Promise<{ spaceId: string; userId: string; added: boolean }> {
  if (!(await canManageSpace(viewer, input.spaceId))) {
    throw new Error("You can't manage that space.");
  }
  await loadCompanySpace(input.spaceId);
  const userId = await resolveWorkspaceUser(input);
  const db = getDb();

  const [existing] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.spaceId, input.spaceId),
        eq(spaceMembers.userId, userId),
      ),
    )
    .limit(1);
  if (existing) return { spaceId: input.spaceId, userId, added: false };

  await db.insert(spaceMembers).values({
    id: crypto.randomUUID(),
    spaceId: input.spaceId,
    userId,
    addedById: viewer.id,
    createdAt: new Date(),
  });
  return { spaceId: input.spaceId, userId, added: true };
}

export async function removeSpaceMember(
  viewer: Viewer,
  input: RemoveSpaceMemberInput,
): Promise<{ spaceId: string; userId: string }> {
  if (!(await canManageSpace(viewer, input.spaceId))) {
    throw new Error("You can't manage that space.");
  }
  const space = await loadCompanySpace(input.spaceId);
  const db = getDb();
  // Removing the current lead would orphan the space; require reassigning first.
  if (space.leadId === input.userId) {
    throw new Error("Reassign the Space Lead before removing them.");
  }
  await db
    .delete(spaceMembers)
    .where(
      and(
        eq(spaceMembers.spaceId, input.spaceId),
        eq(spaceMembers.userId, input.userId),
      ),
    );
  return { spaceId: input.spaceId, userId: input.userId };
}

export async function setSpaceLead(
  viewer: Viewer,
  input: SetSpaceLeadInput,
): Promise<{ spaceId: string; userId: string }> {
  if (!(await canManageSpace(viewer, input.spaceId))) {
    throw new Error("You can't manage that space.");
  }
  const space = await loadCompanySpace(input.spaceId);
  const db = getDb();
  const now = new Date();
  // The new lead must be a real workspace user (a bad id would orphan a row).
  const [targetUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  if (!targetUser) throw new Error("No user with that id.");
  // The lead is also a member — ensure a membership row exists.
  const [existing] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(
      and(
        eq(spaceMembers.spaceId, space.id),
        eq(spaceMembers.userId, input.userId),
      ),
    )
    .limit(1);
  if (!existing) {
    await db.insert(spaceMembers).values({
      id: crypto.randomUUID(),
      spaceId: space.id,
      userId: input.userId,
      addedById: viewer.id,
      createdAt: now,
    });
  }
  await db
    .update(spaces)
    .set({ leadId: input.userId, updatedAt: now })
    .where(eq(spaces.id, space.id));
  return { spaceId: space.id, userId: input.userId };
}

export async function moveProjectToSpace(
  viewer: Viewer,
  input: MoveProjectToSpaceInput,
): Promise<{ projectId: string; spaceId: string }> {
  const db = getDb();
  // Must own the project (owner / admin) AND be able to post to the target.
  if (!(await canAdministerProject(viewer, input.projectId))) {
    throw new Error("Project not found.");
  }
  if (!(await canPostToSpace(viewer, input.spaceId))) {
    throw new Error("You can't move the project into that space.");
  }
  const [target] = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(eq(spaces.id, input.spaceId))
    .limit(1);
  if (!target) throw new Error("Space not found.");

  const now = new Date();
  await db
    .update(projects)
    .set({ spaceId: target.id, updatedAt: now })
    .where(eq(projects.id, input.projectId));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "updated",
    label: "Moved project to space",
    detail: target.name,
    createdAt: now,
  });

  return { projectId: input.projectId, spaceId: target.id };
}
