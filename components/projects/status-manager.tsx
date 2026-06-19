"use client";

import { useState, useTransition } from "react";
import {
  ArrowDown,
  ArrowUp,
  CircleNotch,
  Pencil,
  Plus,
  Trash,
} from "@phosphor-icons/react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  createTaskStatusAction,
  deleteTaskStatusAction,
  reorderTaskStatusesAction,
  updateTaskStatusDefAction,
} from "@/lib/actions";
import { PROJECT_SWATCHES } from "@/lib/swatches";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type ManagedStatus = {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  isTerminal: boolean;
  isInitial: boolean;
  taskCount: number;
};

const DEFAULT_COLOR = PROJECT_SWATCHES[0].value;

function SwatchPicker({
  color,
  onChange,
}: {
  color: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PROJECT_SWATCHES.map((swatch) => {
        const isSelected = swatch.value.toLowerCase() === color.toLowerCase();
        return (
          <button
            key={swatch.value}
            type="button"
            onClick={() => onChange(swatch.value)}
            aria-label={swatch.label}
            aria-pressed={isSelected}
            className={cn(
              "size-6 rounded-md border transition",
              isSelected
                ? "border-foreground"
                : "border-border hover:border-border-strong",
            )}
            style={{ backgroundColor: swatch.value }}
          />
        );
      })}
    </div>
  );
}

export function StatusManager({
  projectId,
  statuses,
}: {
  projectId: string;
  statuses: ManagedStatus[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [reordering, startReorder] = useTransition();

  const ordered = [...statuses].sort((a, b) => a.sortOrder - b.sortOrder);
  const target = statuses.find((s) => s.id === confirmDeleteId);

  const move = (index: number, direction: -1 | 1) => {
    const next = [...ordered];
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= next.length) return;
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    const formData = new FormData();
    formData.set("projectId", projectId);
    formData.set("orderedIds", JSON.stringify(next.map((s) => s.id)));
    startReorder(async () => {
      try {
        await reorderTaskStatusesAction(formData);
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "Could not reorder statuses",
          "danger",
        );
      }
    });
  };

  return (
    <div className="grid gap-4">
      <ul className="grid gap-2">
        {ordered.map((status, index) =>
          editingId === status.id ? (
            <li key={status.id}>
              <StatusEditForm
                status={status}
                onDone={() => setEditingId(null)}
                onCancel={() => setEditingId(null)}
              />
            </li>
          ) : (
            <li
              key={status.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block size-3 rounded-full"
                  style={{ backgroundColor: status.color }}
                />
                <span className="truncate text-[13px] font-medium text-foreground">
                  {status.name}
                </span>
                {status.isInitial ? (
                  <span className="ui-badge">Initial</span>
                ) : null}
                {status.isTerminal ? <span className="ui-badge">Done</span> : null}
                <span className="ui-badge">
                  {status.taskCount} task{status.taskCount === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0 || reordering}
                  className="inline-flex size-7 items-center justify-center rounded-sm text-muted transition hover:bg-background hover:text-foreground disabled:opacity-30"
                  title="Move left"
                >
                  <ArrowUp className="size-3.5" />
                  <span className="sr-only">Move earlier</span>
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === ordered.length - 1 || reordering}
                  className="inline-flex size-7 items-center justify-center rounded-sm text-muted transition hover:bg-background hover:text-foreground disabled:opacity-30"
                  title="Move right"
                >
                  <ArrowDown className="size-3.5" />
                  <span className="sr-only">Move later</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(status.id)}
                  className="inline-flex size-7 items-center justify-center rounded-sm text-muted transition hover:bg-background hover:text-foreground"
                  title="Edit status"
                >
                  <Pencil className="size-3.5" />
                  <span className="sr-only">Edit status</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(status.id)}
                  className="inline-flex size-7 items-center justify-center rounded-sm text-muted transition hover:bg-danger/10 hover:text-danger"
                  title="Delete status"
                >
                  <Trash className="size-3.5" />
                  <span className="sr-only">Delete status</span>
                </button>
              </div>
            </li>
          ),
        )}
      </ul>

      <StatusCreateForm projectId={projectId} />

      {target ? (
        <DeleteStatusDialog
          status={target}
          onClose={() => setConfirmDeleteId(null)}
        />
      ) : null}
    </div>
  );
}

function StatusCreateForm({ projectId }: { projectId: string }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [isTerminal, setIsTerminal] = useState(false);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="grid gap-3 rounded-md border border-dashed border-border bg-surface p-3">
      <p className="text-[12px] font-medium text-foreground">Add a status</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-48 flex-1 gap-1.5">
          <span className="text-[12px] font-medium text-muted">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="ui-input"
            maxLength={40}
            placeholder="e.g. In Review"
          />
        </label>
        <label className="flex items-center gap-2 pb-2 text-[12px] text-foreground">
          <input
            type="checkbox"
            checked={isTerminal}
            onChange={(event) => setIsTerminal(event.target.checked)}
          />
          Done column
        </label>
      </div>
      <SwatchPicker color={color} onChange={setColor} />
      <div className="flex justify-end">
        <button
          type="button"
          disabled={isPending || !name.trim()}
          onClick={() => {
            const trimmed = name.trim();
            if (!trimmed) return;
            const formData = new FormData();
            formData.set("projectId", projectId);
            formData.set("name", trimmed);
            formData.set("color", color);
            formData.set("isTerminal", isTerminal ? "true" : "false");
            startTransition(async () => {
              try {
                await createTaskStatusAction(formData);
                toast("Status added", "success");
                setName("");
                setColor(DEFAULT_COLOR);
                setIsTerminal(false);
              } catch (error) {
                toast(
                  error instanceof Error ? error.message : "Could not add status",
                  "danger",
                );
              }
            });
          }}
          className="ui-button-primary px-4 disabled:opacity-60"
        >
          {isPending ? (
            <CircleNotch className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Add status
        </button>
      </div>
    </div>
  );
}

function StatusEditForm({
  status,
  onDone,
  onCancel,
}: {
  status: ManagedStatus;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(status.name);
  const [color, setColor] = useState(status.color);
  const [isTerminal, setIsTerminal] = useState(status.isTerminal);
  const [isInitial, setIsInitial] = useState(status.isInitial);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="grid gap-3 rounded-md border border-border bg-surface p-3">
      <label className="grid gap-1.5">
        <span className="text-[12px] font-medium text-foreground">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="ui-input"
          maxLength={40}
        />
      </label>
      <div className="grid gap-1.5">
        <span className="text-[12px] font-medium text-foreground">Color</span>
        <SwatchPicker color={color} onChange={setColor} />
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-[12px] text-foreground">
          <input
            type="checkbox"
            checked={isInitial}
            onChange={(event) => setIsInitial(event.target.checked)}
          />
          New tasks start here
        </label>
        <label className="flex items-center gap-2 text-[12px] text-foreground">
          <input
            type="checkbox"
            checked={isTerminal}
            onChange={(event) => setIsTerminal(event.target.checked)}
          />
          Done column
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="ui-button-ghost px-3"
          disabled={isPending}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            const trimmed = name.trim();
            if (!trimmed) return;
            const formData = new FormData();
            formData.set("statusId", status.id);
            formData.set("name", trimmed);
            formData.set("color", color);
            formData.set("isTerminal", isTerminal ? "true" : "false");
            formData.set("isInitial", isInitial ? "true" : "false");
            startTransition(async () => {
              try {
                await updateTaskStatusDefAction(formData);
                toast("Status updated", "success");
                onDone();
              } catch (error) {
                toast(
                  error instanceof Error
                    ? error.message
                    : "Could not update status",
                  "danger",
                );
              }
            });
          }}
          className="ui-button-primary px-4"
          disabled={isPending}
        >
          {isPending ? <CircleNotch className="size-4 animate-spin" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

function DeleteStatusDialog({
  status,
  onClose,
}: {
  status: ManagedStatus;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();

  if (status.taskCount > 0) {
    return (
      <ConfirmDialog
        open
        title="Status still in use"
        description={
          <>
            <span className="font-medium text-foreground">{status.name}</span>{" "}
            still has{" "}
            <span className="font-medium text-foreground">
              {status.taskCount}
            </span>{" "}
            task{status.taskCount === 1 ? "" : "s"} in it. Move them to another
            status first, then delete this column.
          </>
        }
        confirmLabel="Got it"
        cancelLabel="Close"
        variant="primary"
        onCancel={onClose}
        onConfirm={onClose}
      />
    );
  }

  return (
    <ConfirmDialog
      open
      title="Delete status?"
      description={
        <>
          Permanently remove the{" "}
          <span className="font-medium text-foreground">{status.name}</span>{" "}
          column from this project. This cannot be undone.
        </>
      }
      confirmLabel="Delete"
      variant="danger"
      isPending={isPending}
      onCancel={onClose}
      onConfirm={() => {
        const formData = new FormData();
        formData.set("statusId", status.id);
        startTransition(async () => {
          try {
            await deleteTaskStatusAction(formData);
            toast("Status deleted", "success");
            onClose();
          } catch (error) {
            toast(
              error instanceof Error ? error.message : "Could not delete status",
              "danger",
            );
          }
        });
      }}
    />
  );
}
