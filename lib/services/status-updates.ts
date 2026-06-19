// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Task status-update (client-facing summary) service — shared by the web Server
// Actions (lib/actions.ts) and the MCP server. Viewer + typed input → owner-only
// write + activity logging; no revalidate/redirect/FormData. There is exactly
// one published update per task (unique index on task_id), so publish is an
// INSERT … ON CONFLICT DO UPDATE. Authz mirrors the web exactly: the actor must
// own BOTH the task and the project, and only a task whose status is "done" can
// be published. The summary is plain text, so it is stored verbatim.
import { eq } from "drizzle-orm";
import { z } from "zod";

import { logProjectActivity } from "@/lib/activity";
import type { Viewer } from "@/lib/auth-server";
import { getDb } from "@/lib/db";
import { projectStatusUpdates } from "@/lib/db/schema";
import {
  assertProjectCapability,
  assertTaskInProject,
  touchProject,
  touchTask,
} from "@/lib/services/_shared";

const STATUS_UPDATE_MAX = 5000;

export const publishStatusUpdateInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(STATUS_UPDATE_MAX)
    .describe("Plain-text client-facing summary of what was completed."),
});
export type PublishStatusUpdateInput = z.infer<
  typeof publishStatusUpdateInputSchema
>;

export const deleteStatusUpdateInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});
export type DeleteStatusUpdateInput = z.infer<
  typeof deleteStatusUpdateInputSchema
>;

export async function publishStatusUpdate(
  viewer: Viewer,
  input: PublishStatusUpdateInput,
): Promise<{ taskId: string }> {
  const db = getDb();
  const now = new Date();
  // Publishing a client update is Leader-level over the project — any manager
  // can publish for any task in the project, not just one they created.
  await assertProjectCapability(viewer, input.projectId, "status.publish");
  const task = await assertTaskInProject(input.taskId, input.projectId);

  if (!task.isTerminal) {
    throw new Error(
      "Only tasks in a Done (terminal) status can be published as client updates.",
    );
  }

  await db
    .insert(projectStatusUpdates)
    .values({
      id: crypto.randomUUID(),
      ownerId: viewer.id,
      projectId: input.projectId,
      taskId: input.taskId,
      summary: input.summary,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectStatusUpdates.taskId,
      set: { summary: input.summary, updatedAt: now },
    });

  await Promise.all([
    touchTask(input.taskId, now),
    touchProject(input.projectId, now),
  ]);

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "task",
    entityId: input.taskId,
    action: "updated",
    label: "Published client update",
    detail: task.title,
    createdAt: now,
  });

  return { taskId: input.taskId };
}

export async function deleteStatusUpdate(
  viewer: Viewer,
  input: DeleteStatusUpdateInput,
): Promise<{ taskId: string }> {
  const db = getDb();
  const now = new Date();
  await assertProjectCapability(viewer, input.projectId, "status.publish");
  const task = await assertTaskInProject(input.taskId, input.projectId);

  // Delete the task's single published update regardless of who authored it —
  // any project manager can remove it.
  await db
    .delete(projectStatusUpdates)
    .where(eq(projectStatusUpdates.taskId, input.taskId));

  await Promise.all([
    touchTask(input.taskId, now),
    touchProject(input.projectId, now),
  ]);

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "task",
    entityId: input.taskId,
    action: "updated",
    label: "Removed client update",
    detail: task.title,
    createdAt: now,
  });

  return { taskId: input.taskId };
}
