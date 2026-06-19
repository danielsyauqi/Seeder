"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { CalendarDots, CheckSquare, Square, X } from "@phosphor-icons/react";

import RichTextRenderer from "@/components/rich-text/rich-text-renderer";
import type { BoardTask } from "@/components/projects/kanban-board";
import { StatusBadge } from "@/components/projects/status-badge";
import { formatDate } from "@/lib/utils";

export type ClientSubtask = {
  id: string;
  content: string;
  isCompleted: boolean;
};

export type ClientTask = BoardTask & {
  subtasks: ClientSubtask[];
};

const PRIORITY_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Read-only detail row in the aside. Mirrors the owner modal's field layout —
 * a 12px medium label above its value.
 */
function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      <div className="text-[13px] text-foreground">{children}</div>
    </div>
  );
}

/**
 * Read-only task detail for the public client board. A 1:1 mirror of the owner's
 * task modal (the `ModalShell` in project-workspace-ui): same `max-w-6xl` panel
 * on `bg-surface-strong`, the same single body scroll container (the whole modal
 * scrolls as one — no nested per-section scrollbars), the same
 * description + 280px details-aside layout. Comments are deliberately omitted —
 * the public client board never exposes internal task discussion. Editing
 * is stripped; every value renders as static text. Portaled to body so a colored
 * board header's scoped CSS variables can't wash the modal out.
 */
export function ClientTaskModal({
  task,
  onClose,
}: {
  task: ClientTask | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!task) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task, onClose]);

  if (!task) return null;
  if (typeof document === "undefined") return null;

  const due = formatDate(task.dueDate);
  const doneCount = task.subtasks.filter((item) => item.isCompleted).length;

  return createPortal(
    <div className="fixed inset-0 z-[60] p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="ui-modal-backdrop absolute inset-0 backdrop-blur-xs"
      />
      <div className="relative flex min-h-full items-end justify-center sm:items-center">
        <div className="ui-modal-panel relative flex max-h-[calc(100dvh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-md border border-border bg-surface-strong p-5 shadow-xl sm:max-h-[calc(100dvh-3rem)] sm:p-6">
          {/* Header */}
          <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                Task
              </p>
              <h3 className="text-[20px] font-medium tracking-[-0.022em] text-foreground">
                {task.title}
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Single scroll container — the whole body scrolls as one, exactly
              like the owner modal. No nested per-section scrollbars. */}
          <div className="min-h-0 overflow-y-auto pr-1">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
              {/* Main column: description + subtasks */}
              <div className="grid content-start gap-5">
                <div className="grid gap-2">
                  <span className="text-sm font-medium text-foreground">
                    Description
                  </span>
                  <div className="rounded-md border border-border bg-background px-3 py-2.5">
                    <RichTextRenderer
                      value={task.description}
                      className="text-[13px] leading-6 text-foreground"
                      fallback={
                        <p className="text-[13px] leading-6 text-muted">
                          No description provided.
                        </p>
                      }
                    />
                  </div>
                </div>

                {task.subtasks.length ? (
                  <div className="grid gap-3 rounded-md border border-border bg-surface px-4 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                        Subtasks
                      </p>
                      <span className="text-sm text-muted">
                        {doneCount}/{task.subtasks.length} done
                      </span>
                    </div>
                    <ul className="grid gap-2">
                      {task.subtasks.map((item) => (
                        <li
                          key={item.id}
                          className="flex items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2.5 text-[13px]"
                        >
                          {item.isCompleted ? (
                            <CheckSquare className="mt-0.5 size-4 shrink-0 text-accent" />
                          ) : (
                            <Square className="mt-0.5 size-4 shrink-0 text-muted" />
                          )}
                          <span
                            className={
                              item.isCompleted
                                ? "text-muted line-through"
                                : "text-foreground"
                            }
                          >
                            {item.content}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              {/* Aside: read-only details */}
              <aside className="grid content-start gap-4 rounded-md border border-border bg-surface p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                  Details
                </p>
                <Detail label="Status">
                  <StatusBadge name={task.statusName} color={task.statusColor} />
                </Detail>
                <Detail label="Priority">
                  <span className="ui-badge">
                    {PRIORITY_LABEL[task.priority] ?? task.priority}
                  </span>
                </Detail>
                <Detail label="Due date">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDots className="size-3.5 text-muted" />
                    {due}
                  </span>
                </Detail>
                <Detail label="Category">
                  {task.categoryName ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="inline-block size-2.5 rounded-full"
                        style={{
                          backgroundColor: task.categoryColor ?? "var(--muted)",
                        }}
                      />
                      {task.categoryName}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Detail>
                <Detail label="Phase">
                  {task.phase || <span className="text-muted">—</span>}
                </Detail>
              </aside>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
