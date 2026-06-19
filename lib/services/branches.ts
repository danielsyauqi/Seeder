// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Branch services — shared by the web Server Actions (lib/actions.ts) and the
// MCP server. A branch is a git-like workstream within a project: tasks and
// requests are scoped to it, so Main and a feature branch show a different set
// of work. Branches are PUBLIC to all project members (any member can view and
// create), but renaming/deleting a branch is limited to its creator or the
// project owner, and the default "Main" branch can never be deleted. Branch
// lifecycle (create/rename/delete) and task moves ARE written to the activity
// feed (entityType "branch", or "task" + action "moved" for a re-home).
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { toActivityRow } from "@/lib/activity";
import type { Viewer } from "@/lib/auth-server";
import {
  canAccessProject,
  canManageProject,
  canProjectCapability,
} from "@/lib/authz";
import { getDb } from "@/lib/db";
import {
  branches,
  clientRequests,
  projectActivity,
  projects,
  tasks,
  user,
} from "@/lib/db/schema";
import {
  assertProjectCapability,
  assertTaskInProject,
  getNextTaskSortOrder,
} from "@/lib/services/_shared";

const branchNameField = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe("Branch name (1-60 chars, unique within the project).");
const branchDescriptionField = z
  .string()
  .trim()
  .max(500)
  .optional()
  .or(z.literal("").transform(() => undefined))
  .describe("Optional short description of what this branch is for.");

// --- Input schemas -----------------------------------------------------------

export const listBranchesInputSchema = z.object({
  projectId: z.string().min(1),
});
export type ListBranchesInput = z.infer<typeof listBranchesInputSchema>;

export const createBranchInputSchema = z.object({
  projectId: z.string().min(1),
  name: branchNameField,
  description: branchDescriptionField,
});
export type CreateBranchInput = z.infer<typeof createBranchInputSchema>;

export const renameBranchInputSchema = z.object({
  branchId: z.string().min(1),
  name: branchNameField.optional().describe("New name. Omit to keep current."),
  description: branchDescriptionField,
});
export type RenameBranchInput = z.infer<typeof renameBranchInputSchema>;

export const deleteBranchInputSchema = z.object({
  branchId: z.string().min(1),
});
export type DeleteBranchInput = z.infer<typeof deleteBranchInputSchema>;

export const moveTaskToBranchInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  branchId: z
    .string()
    .min(1)
    .describe("Target branch id to move the task onto (from list-branches)."),
});
export type MoveTaskToBranchInput = z.infer<typeof moveTaskToBranchInputSchema>;

export type BranchSummary = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdById: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  taskCount: number;
  requestCount: number;
};

// --- Helpers -----------------------------------------------------------------

function isUniqueNameError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/i.test(error.message);
}

/**
 * Load a branch for a management op (rename/delete). Requires project access to
 * even see it (opaque "not found" otherwise), then limits the mutation to a
 * project manager (owner or leader) OR the branch's own creator.
 */
async function assertBranchManage(viewer: Viewer, branchId: string) {
  const db = getDb();
  const [branch] = await db
    .select()
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  if (!branch) throw new Error("Branch not found.");
  if (!(await canAccessProject(viewer, branch.projectId))) {
    throw new Error("Branch not found.");
  }
  const canManage = await canManageProject(viewer, branch.projectId);
  if (canManage) return branch;
  // A Member can manage a branch they created, but only while they still hold
  // the branch.write capability (so revoking it also locks down their branches).
  const isCreator = branch.createdBy === viewer.id;
  const hasBranchWrite = await canProjectCapability(
    viewer,
    branch.projectId,
    "branch.write",
  );
  if (!(isCreator && hasBranchWrite)) {
    throw new Error(
      "Only the branch creator (with branch access), a project leader, or the owner can change this branch.",
    );
  }
  return branch;
}

// --- Services ----------------------------------------------------------------

export async function listBranches(
  viewer: Viewer,
  input: ListBranchesInput,
): Promise<BranchSummary[]> {
  if (!(await canAccessProject(viewer, input.projectId))) return [];
  const db = getDb();

  const [rows, taskCounts, requestCounts] = await Promise.all([
    db
      .select({
        id: branches.id,
        name: branches.name,
        description: branches.description,
        isDefault: branches.isDefault,
        createdById: branches.createdBy,
        createdByName: user.name,
        createdAt: branches.createdAt,
        updatedAt: branches.updatedAt,
      })
      .from(branches)
      .leftJoin(user, eq(user.id, branches.createdBy))
      .where(eq(branches.projectId, input.projectId))
      // Main first, then alphabetical; the list page re-sorts client-side.
      .orderBy(desc(branches.isDefault), asc(branches.name)),
    db
      .select({ branchId: tasks.branchId, n: count() })
      .from(tasks)
      .where(eq(tasks.projectId, input.projectId))
      .groupBy(tasks.branchId),
    db
      .select({ branchId: clientRequests.branchId, n: count() })
      .from(clientRequests)
      .where(eq(clientRequests.projectId, input.projectId))
      .groupBy(clientRequests.branchId),
  ]);

  const taskByBranch = new Map(taskCounts.map((c) => [c.branchId, c.n]));
  const requestByBranch = new Map(requestCounts.map((c) => [c.branchId, c.n]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.isDefault,
    createdById: row.createdById,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    taskCount: taskByBranch.get(row.id) ?? 0,
    requestCount: requestByBranch.get(row.id) ?? 0,
  }));
}

export async function createBranch(
  viewer: Viewer,
  input: CreateBranchInput,
): Promise<{ branchId: string; name: string }> {
  await assertProjectCapability(viewer, input.projectId, "branch.write");
  const db = getDb();
  const branchId = crypto.randomUUID();
  const now = new Date();

  try {
    await db.batch([
      db.insert(branches).values({
        id: branchId,
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? null,
        createdBy: viewer.id,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(projectActivity).values(
        toActivityRow({
          ownerId: viewer.id,
          projectId: input.projectId,
          entityType: "branch",
          entityId: branchId,
          action: "created",
          label: "Created branch",
          detail: input.name,
          createdAt: now,
        }),
      ),
    ]);
  } catch (error) {
    if (isUniqueNameError(error)) {
      throw new Error(`A branch named "${input.name}" already exists.`);
    }
    throw error;
  }

  return { branchId, name: input.name };
}

export async function renameBranch(
  viewer: Viewer,
  input: RenameBranchInput,
): Promise<{ branchId: string; projectId: string; name: string }> {
  const branch = await assertBranchManage(viewer, input.branchId);
  const db = getDb();
  const now = new Date();

  const name = input.name ?? branch.name;
  const description =
    input.description !== undefined ? input.description : branch.description;
  if (name === branch.name && description === branch.description) {
    return { branchId: branch.id, projectId: branch.projectId, name };
  }

  try {
    await db.batch([
      db
        .update(branches)
        .set({ name, description: description ?? null, updatedAt: now })
        .where(eq(branches.id, branch.id)),
      db.insert(projectActivity).values(
        toActivityRow({
          ownerId: viewer.id,
          projectId: branch.projectId,
          entityType: "branch",
          entityId: branch.id,
          action: "updated",
          label: "Updated branch",
          detail: name,
          createdAt: now,
        }),
      ),
    ]);
  } catch (error) {
    if (isUniqueNameError(error)) {
      throw new Error(`A branch named "${name}" already exists.`);
    }
    throw error;
  }

  return { branchId: branch.id, projectId: branch.projectId, name };
}

export async function deleteBranch(
  viewer: Viewer,
  input: DeleteBranchInput,
): Promise<{ branchId: string; projectId: string }> {
  const branch = await assertBranchManage(viewer, input.branchId);
  if (branch.isDefault) {
    throw new Error("The Main branch can't be deleted.");
  }
  const db = getDb();
  const now = new Date();

  // Deleting the branch cascades to its tasks and requests (FK ON DELETE
  // CASCADE), so this removes all of the branch's work too.
  await db.batch([
    db.delete(branches).where(eq(branches.id, branch.id)),
    db.insert(projectActivity).values(
      toActivityRow({
        ownerId: viewer.id,
        projectId: branch.projectId,
        entityType: "branch",
        entityId: branch.id,
        action: "deleted",
        label: "Deleted branch",
        detail: branch.name,
        createdAt: now,
      }),
    ),
  ]);

  return { branchId: branch.id, projectId: branch.projectId };
}

export async function moveTaskToBranch(
  viewer: Viewer,
  input: MoveTaskToBranchInput,
): Promise<{ taskId: string; branchId: string }> {
  await assertProjectCapability(viewer, input.projectId, "branch.write");
  const task = await assertTaskInProject(input.taskId, input.projectId);
  const db = getDb();
  const now = new Date();

  // Target branch must belong to this project.
  const [target] = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(
      and(
        eq(branches.id, input.branchId),
        eq(branches.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!target) throw new Error("Branch not found in this project.");

  // Already there → idempotent no-op.
  if (task.branchId === target.id) {
    return { taskId: task.id, branchId: target.id };
  }

  // Name the source branch for the activity diff (may be null if its creator
  // was deleted, but the branch row still exists).
  const fromName = task.branchId
    ? (
        await db
          .select({ name: branches.name })
          .from(branches)
          .where(eq(branches.id, task.branchId))
          .limit(1)
      )[0]?.name ?? null
    : null;

  // Re-home the card to the bottom of its column on the target branch.
  const sortOrder = await getNextTaskSortOrder(
    input.projectId,
    task.statusId,
    target.id,
  );

  await db.batch([
    db
      .update(tasks)
      .set({ branchId: target.id, sortOrder, updatedAt: now })
      .where(eq(tasks.id, task.id)),
    db.update(projects).set({ updatedAt: now }).where(eq(projects.id, input.projectId)),
    db.insert(projectActivity).values(
      toActivityRow({
        ownerId: viewer.id,
        projectId: input.projectId,
        entityType: "task",
        entityId: task.id,
        action: "moved",
        label: `Moved task to branch ${target.name}`,
        detail: task.title,
        changes: [
          {
            field: "branch",
            label: "Branch",
            from: fromName,
            to: target.name,
            kind: "text",
          },
        ],
        createdAt: now,
      }),
    ),
  ]);

  return { taskId: task.id, branchId: target.id };
}
