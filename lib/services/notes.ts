// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Project-notes service — shared by the web Server Actions (lib/actions.ts) and
// the MCP server. Viewer + typed input → owner-only mutation + activity logging;
// no revalidate/redirect/FormData. A project can hold many notes; each note body
// is rich text (the same editor as task descriptions), so content is run through
// the Markdown/plain-text → rich-text normalizer before storage, exactly like a
// task description (so an MCP caller can pass Markdown and the web UI rich JSON).
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { logProjectActivity } from "@/lib/activity";
import type { Viewer } from "@/lib/auth-server";
import { getDb } from "@/lib/db";
import { projectNotes } from "@/lib/db/schema";
import { normalizeRichTextInput, parseRichText, richTextToPlainText } from "@/lib/rich-text";
import { assertProjectOwner, touchProject } from "@/lib/services/_shared";

function notePreview(content: string): string {
  const text = richTextToPlainText(parseRichText(content)).trim();
  if (!text) return "Empty note";
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export const createProjectNoteInputSchema = z.object({
  projectId: z.string().min(1),
  content: z
    .string()
    .max(20000)
    .describe(
      "Note body. Markdown is accepted and converted to rich text. Each call adds a new note.",
    ),
});
export type CreateProjectNoteInput = z.infer<typeof createProjectNoteInputSchema>;

export async function createProjectNote(
  viewer: Viewer,
  input: CreateProjectNoteInput,
): Promise<{ projectId: string; noteId: string }> {
  const db = getDb();
  const now = new Date();
  await assertProjectOwner(viewer, input.projectId);

  const noteId = crypto.randomUUID();
  const content = normalizeRichTextInput(input.content) ?? "";

  await db.insert(projectNotes).values({
    id: noteId,
    ownerId: viewer.id,
    projectId: input.projectId,
    content,
    createdAt: now,
    updatedAt: now,
  });

  await touchProject(input.projectId, now);
  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "note",
    entityId: noteId,
    action: "created",
    label: "Added note",
    detail: notePreview(content),
    createdAt: now,
  });

  return { projectId: input.projectId, noteId };
}

export const updateProjectNoteInputSchema = z.object({
  projectId: z.string().min(1),
  noteId: z.string().min(1),
  content: z.string().max(20000),
});
export type UpdateProjectNoteInput = z.infer<typeof updateProjectNoteInputSchema>;

export async function updateProjectNote(
  viewer: Viewer,
  input: UpdateProjectNoteInput,
): Promise<{ projectId: string; noteId: string }> {
  const db = getDb();
  const now = new Date();
  await assertProjectOwner(viewer, input.projectId);

  const [existing] = await db
    .select({ id: projectNotes.id })
    .from(projectNotes)
    .where(
      and(
        eq(projectNotes.id, input.noteId),
        eq(projectNotes.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Note not found.");

  const content = normalizeRichTextInput(input.content) ?? "";

  await db
    .update(projectNotes)
    .set({ content, updatedAt: now })
    .where(eq(projectNotes.id, input.noteId));

  await touchProject(input.projectId, now);
  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "note",
    entityId: input.noteId,
    action: "updated",
    label: "Updated note",
    detail: notePreview(content),
    createdAt: now,
  });

  return { projectId: input.projectId, noteId: input.noteId };
}

export const deleteProjectNoteInputSchema = z.object({
  projectId: z.string().min(1),
  noteId: z.string().min(1),
});
export type DeleteProjectNoteInput = z.infer<typeof deleteProjectNoteInputSchema>;

export async function deleteProjectNote(
  viewer: Viewer,
  input: DeleteProjectNoteInput,
): Promise<{ projectId: string; noteId: string }> {
  const db = getDb();
  const now = new Date();
  await assertProjectOwner(viewer, input.projectId);

  const [existing] = await db
    .select({ content: projectNotes.content })
    .from(projectNotes)
    .where(
      and(
        eq(projectNotes.id, input.noteId),
        eq(projectNotes.projectId, input.projectId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Note not found.");

  await db.delete(projectNotes).where(eq(projectNotes.id, input.noteId));

  await touchProject(input.projectId, now);
  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "note",
    entityId: input.noteId,
    action: "deleted",
    label: "Deleted note",
    detail: notePreview(existing.content),
    createdAt: now,
  });

  return { projectId: input.projectId, noteId: input.noteId };
}
