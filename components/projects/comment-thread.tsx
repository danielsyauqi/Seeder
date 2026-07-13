"use client";

import { useState, useTransition } from "react";
import { CircleNotch, Pencil, Trash, X } from "@phosphor-icons/react";

import { RichTextEditor, RichTextRenderer } from "@/components/rich-text";
import { Avatar } from "@/components/ui/avatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  parseRichText,
  richTextIsEmpty,
  serializeRichText,
  type RichTextDoc,
} from "@/lib/rich-text";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type CommentItem = {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type Actions = {
  create: (formData: FormData) => Promise<void>;
  update: (formData: FormData) => Promise<void>;
  remove: (formData: FormData) => Promise<void>;
};

function timeAgo(date: Date) {
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString();
}

export function CommentThread({
  comments,
  projectId,
  parentId,
  viewerId,
  viewerCanModerate,
  actions,
}: {
  comments: CommentItem[];
  projectId: string;
  parentId: string;
  viewerId: string;
  viewerCanModerate: boolean;
  actions: Actions;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
        Comments · {comments.length}
      </p>

      {comments.length ? (
        <ul className="grid gap-3">
          {comments.map((comment) => {
            const isAuthor = comment.authorId === viewerId;
            const canEdit = isAuthor;
            const canDelete = isAuthor || viewerCanModerate;
            const isEditing = editingId === comment.id;

            if (isEditing) {
              return (
                <li
                  key={comment.id}
                  className="rounded-md border border-border bg-surface p-3"
                >
                  <CommentEditForm
                    comment={comment}
                    onCancel={() => setEditingId(null)}
                    onDone={() => setEditingId(null)}
                    updateAction={actions.update}
                  />
                </li>
              );
            }

            return (
              <li
                key={comment.id}
                className="rounded-md border border-border bg-surface p-3"
              >
                <div className="mb-1 flex items-center justify-between gap-2 text-[12px]">
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar
                      name={comment.authorName}
                      image={comment.authorImage}
                      px={24}
                      className="size-6 text-[10px]"
                    />
                    <span className="truncate font-medium text-foreground">
                      {comment.authorName}
                    </span>
                    <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                      {timeAgo(comment.createdAt)}
                      {comment.updatedAt.getTime() !== comment.createdAt.getTime()
                        ? " · edited"
                        : null}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => setEditingId(comment.id)}
                        className="inline-flex size-7 items-center justify-center rounded-sm text-muted transition hover:bg-background hover:text-foreground"
                        title="Edit comment"
                      >
                        <Pencil className="size-3.5" />
                        <span className="sr-only">Edit comment</span>
                      </button>
                    ) : null}
                    {canDelete ? (
                      <DeleteCommentButton
                        commentId={comment.id}
                        deleteAction={actions.remove}
                      />
                    ) : null}
                  </div>
                </div>
                <RichTextRenderer
                  value={comment.content}
                  className="text-[13px]"
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-border bg-surface px-4 py-6 text-center text-[13px] leading-6 text-muted">
          No comments yet.
        </p>
      )}

      <ComposeForm
        projectId={projectId}
        parentId={parentId}
        createAction={actions.create}
      />
    </div>
  );
}

function ComposeForm({
  projectId,
  parentId,
  createAction,
}: {
  projectId: string;
  parentId: string;
  createAction: (formData: FormData) => Promise<void>;
}) {
  const [doc, setDoc] = useState<RichTextDoc>(parseRichText(null));
  const [resetKey, setResetKey] = useState(0);
  const [isPending, startTransition] = useTransition();

  const post = () => {
    if (isPending || richTextIsEmpty(doc)) return;
    const formData = new FormData();
    formData.set("projectId", projectId);
    formData.set("parentId", parentId);
    formData.set("content", serializeRichText(doc));
    startTransition(async () => {
      try {
        await createAction(formData);
        setDoc(parseRichText(null));
        setResetKey((k) => k + 1);
        toast("Comment posted", "success");
      } catch (error: unknown) {
        toast(
          error instanceof Error ? error.message : "Could not post comment",
          "danger",
        );
      }
    });
  };

  return (
    // Enter inserts a newline in the editor (it's rich text — paragraphs,
    // lists, pasted screenshots), so Cmd/Ctrl+Enter is the post shortcut.
    <div
      className="grid gap-2 rounded-md border border-border bg-surface p-3"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          post();
        }
      }}
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
        Add comment
      </span>
      <RichTextEditor
        key={resetKey}
        value={serializeRichText(parseRichText(null))}
        onChange={setDoc}
        placeholder="Drop notes, paste screenshots, or link references."
        ariaLabel="New comment"
      />
      <button
        type="button"
        onClick={post}
        disabled={isPending || richTextIsEmpty(doc)}
        className={cn(
          "ui-button-primary self-end px-4 disabled:cursor-not-allowed disabled:opacity-60",
        )}
        title="Post comment (⌘/Ctrl + Enter)"
      >
        {isPending ? <CircleNotch className="size-4 animate-spin" /> : null}
        {isPending ? "Posting…" : "Comment"}
      </button>
    </div>
  );
}

function DeleteCommentButton({
  commentId,
  deleteAction,
}: {
  commentId: string;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <>
      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        disabled={isPending}
        className="inline-flex size-7 items-center justify-center rounded-sm text-muted transition hover:bg-danger/10 hover:text-danger"
        title="Delete comment"
      >
        {isPending ? (
          <CircleNotch className="size-3.5 animate-spin" />
        ) : (
          <Trash className="size-3.5" />
        )}
        <span className="sr-only">Delete comment</span>
      </button>
      <ConfirmDialog
        open={showConfirm}
        title="Delete comment?"
        description="This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        isPending={isPending}
        onCancel={() => setShowConfirm(false)}
        onConfirm={() => {
          const formData = new FormData();
          formData.set("commentId", commentId);
          startTransition(async () => {
            try {
              await deleteAction(formData);
              setShowConfirm(false);
              toast("Comment deleted", "success");
            } catch (error: unknown) {
              toast(
                error instanceof Error ? error.message : "Could not delete comment",
                "danger",
              );
            }
          });
        }}
      />
    </>
  );
}

function CommentEditForm({
  comment,
  onCancel,
  onDone,
  updateAction,
}: {
  comment: CommentItem;
  onCancel: () => void;
  onDone: () => void;
  updateAction: (formData: FormData) => Promise<void>;
}) {
  const [doc, setDoc] = useState<RichTextDoc>(parseRichText(comment.content));
  const [isPending, startTransition] = useTransition();

  const save = () => {
    if (isPending || richTextIsEmpty(doc)) return;
    const formData = new FormData();
    formData.set("commentId", comment.id);
    formData.set("content", serializeRichText(doc));
    startTransition(async () => {
      try {
        await updateAction(formData);
        toast("Comment updated", "success");
        onDone();
      } catch (error: unknown) {
        toast(
          error instanceof Error ? error.message : "Could not update comment",
          "danger",
        );
      }
    });
  };

  return (
    // Enter is a newline in the editor, so Cmd/Ctrl+Enter saves and Escape
    // backs out — the same pair the composer above uses.
    <div
      className="grid gap-2"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          save();
          return;
        }
        if (event.key === "Escape" && !isPending) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <RichTextEditor
        value={comment.content}
        onChange={setDoc}
        ariaLabel="Edit comment"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="ui-button-ghost px-3"
        >
          <X className="size-4" />
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={isPending || richTextIsEmpty(doc)}
          className="ui-button-primary px-4 disabled:cursor-not-allowed disabled:opacity-60"
          title="Save (⌘/Ctrl + Enter)"
        >
          {isPending ? <CircleNotch className="size-4 animate-spin" /> : null}
          {isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
