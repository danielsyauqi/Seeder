// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Comment services (task + request) — shared by the web Server Actions
// (lib/actions.ts) and the MCP server. Viewer + typed input → authz + DB
// mutation + activity logging; no revalidate/redirect/FormData. Comment content
// is rich text (TipTap JSON), so create/update run it through
// normalizeRichTextInput — an MCP client can post Markdown and it lands as rich
// text, identical to typing in the editor. Authz mirrors the web exactly: any
// project member can read or add a comment; editing is author-only; deleting is
// author-or-admin.
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { logProjectActivity } from "@/lib/activity";
import { diffChanges } from "@/lib/activity-diff";
import { isAdminTier, type Viewer } from "@/lib/auth-server";
import { canAccessProject } from "@/lib/authz";
import { getDb } from "@/lib/db";
import {
  clientRequests,
  requestComments,
  taskComments,
  tasks,
  user,
} from "@/lib/db/schema";
import {
  normalizeRichTextInput,
  parseRichText,
  richTextIsEmpty,
  richTextToPlainText,
} from "@/lib/rich-text";
import { assertProjectCapability, touchProject } from "@/lib/services/_shared";

// --- Input schemas -----------------------------------------------------------

const commentContent = z
  .string()
  .min(1)
  .describe(
    "Comment body. Markdown is accepted (bold, lists, links, `code`, …) and converted to rich text.",
  );

export const listTaskCommentsInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
});
export type ListTaskCommentsInput = z.infer<typeof listTaskCommentsInputSchema>;

export const addTaskCommentInputSchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  content: commentContent,
});
export type AddTaskCommentInput = z.infer<typeof addTaskCommentInputSchema>;

export const updateTaskCommentInputSchema = z.object({
  commentId: z.string().min(1),
  content: commentContent,
});
export type UpdateTaskCommentInput = z.infer<
  typeof updateTaskCommentInputSchema
>;

export const deleteTaskCommentInputSchema = z.object({
  commentId: z.string().min(1),
});
export type DeleteTaskCommentInput = z.infer<
  typeof deleteTaskCommentInputSchema
>;

export const listRequestCommentsInputSchema = z.object({
  projectId: z.string().min(1),
  requestId: z.string().min(1),
});
export type ListRequestCommentsInput = z.infer<
  typeof listRequestCommentsInputSchema
>;

export const addRequestCommentInputSchema = z.object({
  projectId: z.string().min(1),
  requestId: z.string().min(1),
  content: commentContent,
});
export type AddRequestCommentInput = z.infer<
  typeof addRequestCommentInputSchema
>;

export const updateRequestCommentInputSchema = z.object({
  commentId: z.string().min(1),
  content: commentContent,
});
export type UpdateRequestCommentInput = z.infer<
  typeof updateRequestCommentInputSchema
>;

export const deleteRequestCommentInputSchema = z.object({
  commentId: z.string().min(1),
});
export type DeleteRequestCommentInput = z.infer<
  typeof deleteRequestCommentInputSchema
>;

export type CommentSummary = {
  id: string;
  authorId: string;
  author: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

// --- Helpers -----------------------------------------------------------------

/** Plain-text preview of a rich comment for the activity log detail. */
function commentExcerpt(content: string): string {
  const text = richTextToPlainText(parseRichText(content));
  return text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}…`;
}

/** Normalize incoming comment content (Markdown/plain → rich JSON); throw if empty. */
function normalizeComment(content: string): string {
  const normalized = normalizeRichTextInput(content);
  if (!normalized || richTextIsEmpty(parseRichText(normalized))) {
    throw new Error("Comment cannot be empty.");
  }
  return normalized;
}

// --- Task comments -----------------------------------------------------------

export async function listTaskComments(
  viewer: Viewer,
  input: ListTaskCommentsInput,
): Promise<CommentSummary[]> {
  if (!(await canAccessProject(viewer, input.projectId))) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: taskComments.id,
      authorId: taskComments.authorId,
      author: user.name,
      content: taskComments.content,
      createdAt: taskComments.createdAt,
      updatedAt: taskComments.updatedAt,
    })
    .from(taskComments)
    .innerJoin(user, eq(user.id, taskComments.authorId))
    .where(
      and(
        eq(taskComments.taskId, input.taskId),
        eq(taskComments.projectId, input.projectId),
      ),
    )
    .orderBy(asc(taskComments.createdAt));

  return rows.map((row) => ({
    id: row.id,
    authorId: row.authorId,
    author: row.author,
    text: richTextToPlainText(parseRichText(row.content)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function createTaskComment(
  viewer: Viewer,
  input: AddTaskCommentInput,
): Promise<{ commentId: string; projectId: string }> {
  await assertProjectCapability(viewer, input.projectId, "comment.write");
  const db = getDb();
  const now = new Date();
  const content = normalizeComment(input.content);

  const [task] = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)))
    .limit(1);
  if (!task) throw new Error("Task not found.");

  const commentId = crypto.randomUUID();
  await db.insert(taskComments).values({
    id: commentId,
    projectId: input.projectId,
    taskId: task.id,
    authorId: viewer.id,
    content,
    createdAt: now,
    updatedAt: now,
  });

  await touchProject(input.projectId, now);
  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "task",
    entityId: task.id,
    action: "created",
    label: "Commented on task",
    detail: commentExcerpt(content) || task.title,
    createdAt: now,
  });

  return { commentId, projectId: input.projectId };
}

export async function updateTaskComment(
  viewer: Viewer,
  input: UpdateTaskCommentInput,
): Promise<{ commentId: string; projectId: string }> {
  const db = getDb();
  const content = normalizeComment(input.content);
  const [comment] = await db
    .select()
    .from(taskComments)
    .where(eq(taskComments.id, input.commentId))
    .limit(1);
  if (!comment) throw new Error("Comment not found.");
  if (comment.authorId !== viewer.id) {
    throw new Error("You can only edit your own comment.");
  }
  await assertProjectCapability(viewer, comment.projectId, "comment.write");

  const now = new Date();
  await db
    .update(taskComments)
    .set({ content, updatedAt: now })
    .where(eq(taskComments.id, comment.id));

  const changes = diffChanges([
    { field: "comment", label: "Comment", from: comment.content, to: content, kind: "rich" },
  ]);
  if (changes) {
    await logProjectActivity(db, {
      ownerId: viewer.id,
      projectId: comment.projectId,
      entityType: "task",
      entityId: comment.taskId,
      action: "updated",
      label: "Edited comment",
      detail: commentExcerpt(content),
      changes,
      createdAt: now,
    });
  }

  return { commentId: comment.id, projectId: comment.projectId };
}

export async function deleteTaskComment(
  viewer: Viewer,
  input: DeleteTaskCommentInput,
): Promise<{ commentId: string; projectId: string | null }> {
  const db = getDb();
  const [comment] = await db
    .select()
    .from(taskComments)
    .where(eq(taskComments.id, input.commentId))
    .limit(1);
  if (!comment) return { commentId: input.commentId, projectId: null };
  if (comment.authorId !== viewer.id && !isAdminTier(viewer.role)) {
    throw new Error("You can only delete your own comment.");
  }
  await assertProjectCapability(viewer, comment.projectId, "comment.write");

  await db.delete(taskComments).where(eq(taskComments.id, comment.id));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: comment.projectId,
    entityType: "task",
    entityId: comment.taskId,
    action: "deleted",
    label: "Removed comment",
    detail: commentExcerpt(comment.content),
    createdAt: new Date(),
  });

  return { commentId: comment.id, projectId: comment.projectId };
}

// --- Request comments --------------------------------------------------------

export async function listRequestComments(
  viewer: Viewer,
  input: ListRequestCommentsInput,
): Promise<CommentSummary[]> {
  if (!(await canAccessProject(viewer, input.projectId))) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: requestComments.id,
      authorId: requestComments.authorId,
      author: user.name,
      content: requestComments.content,
      createdAt: requestComments.createdAt,
      updatedAt: requestComments.updatedAt,
    })
    .from(requestComments)
    .innerJoin(user, eq(user.id, requestComments.authorId))
    .where(
      and(
        eq(requestComments.requestId, input.requestId),
        eq(requestComments.projectId, input.projectId),
      ),
    )
    .orderBy(asc(requestComments.createdAt));

  return rows.map((row) => ({
    id: row.id,
    authorId: row.authorId,
    author: row.author,
    text: richTextToPlainText(parseRichText(row.content)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function createRequestComment(
  viewer: Viewer,
  input: AddRequestCommentInput,
): Promise<{ commentId: string; projectId: string }> {
  await assertProjectCapability(viewer, input.projectId, "comment.write");
  const db = getDb();
  const now = new Date();
  const content = normalizeComment(input.content);

  const [request] = await db
    .select({ id: clientRequests.id, title: clientRequests.title })
    .from(clientRequests)
    .where(
      and(
        eq(clientRequests.id, input.requestId),
        eq(clientRequests.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!request) throw new Error("Request not found.");

  const commentId = crypto.randomUUID();
  await db.insert(requestComments).values({
    id: commentId,
    projectId: input.projectId,
    requestId: request.id,
    authorId: viewer.id,
    content,
    createdAt: now,
    updatedAt: now,
  });

  await touchProject(input.projectId, now);
  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "request",
    entityId: request.id,
    action: "created",
    label: "Commented on request",
    detail: commentExcerpt(content) || request.title,
    createdAt: now,
  });

  return { commentId, projectId: input.projectId };
}

export async function updateRequestComment(
  viewer: Viewer,
  input: UpdateRequestCommentInput,
): Promise<{ commentId: string; projectId: string }> {
  const db = getDb();
  const content = normalizeComment(input.content);
  const [comment] = await db
    .select()
    .from(requestComments)
    .where(eq(requestComments.id, input.commentId))
    .limit(1);
  if (!comment) throw new Error("Comment not found.");
  if (comment.authorId !== viewer.id) {
    throw new Error("You can only edit your own comment.");
  }
  await assertProjectCapability(viewer, comment.projectId, "comment.write");

  const now = new Date();
  await db
    .update(requestComments)
    .set({ content, updatedAt: now })
    .where(eq(requestComments.id, comment.id));

  const changes = diffChanges([
    { field: "comment", label: "Comment", from: comment.content, to: content, kind: "rich" },
  ]);
  if (changes) {
    await logProjectActivity(db, {
      ownerId: viewer.id,
      projectId: comment.projectId,
      entityType: "request",
      entityId: comment.requestId,
      action: "updated",
      label: "Edited comment",
      detail: commentExcerpt(content),
      changes,
      createdAt: now,
    });
  }

  return { commentId: comment.id, projectId: comment.projectId };
}

export async function deleteRequestComment(
  viewer: Viewer,
  input: DeleteRequestCommentInput,
): Promise<{ commentId: string; projectId: string | null }> {
  const db = getDb();
  const [comment] = await db
    .select()
    .from(requestComments)
    .where(eq(requestComments.id, input.commentId))
    .limit(1);
  if (!comment) return { commentId: input.commentId, projectId: null };
  if (comment.authorId !== viewer.id && !isAdminTier(viewer.role)) {
    throw new Error("You can only delete your own comment.");
  }
  await assertProjectCapability(viewer, comment.projectId, "comment.write");

  await db.delete(requestComments).where(eq(requestComments.id, comment.id));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: comment.projectId,
    entityType: "request",
    entityId: comment.requestId,
    action: "deleted",
    label: "Removed comment",
    detail: commentExcerpt(comment.content),
    createdAt: new Date(),
  });

  return { commentId: comment.id, projectId: comment.projectId };
}
