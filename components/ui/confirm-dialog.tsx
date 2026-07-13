"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleNotch, X } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

type Variant = "danger" | "primary";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  isPending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: Variant;
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !isPending) onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, isPending, onCancel]);

  if (!open || !mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[55] p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onCancel}
        disabled={isPending}
        className="ui-modal-backdrop absolute inset-0 bg-[rgba(10,10,10,0.44)] backdrop-blur-xs"
      />
      <div className="relative flex min-h-full items-end justify-center sm:items-center">
        <div
          role="alertdialog"
          aria-modal="true"
          className="ui-modal-panel relative w-full max-w-md rounded-md border border-border bg-surface-strong p-5 shadow-xl sm:p-6"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <h3 className="text-[15px] font-medium tracking-[-0.011em] text-foreground">
              {title}
            </h3>
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <X className="size-3.5" />
              <span className="sr-only">Cancel</span>
            </button>
          </div>
          {description ? (
            <div className="mb-4 text-[13px] leading-6 text-muted">
              {description}
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="ui-button-secondary px-4 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {cancelLabel}
            </button>
            {/* Focused on open so Enter confirms and Escape cancels. Focusing
                the button (rather than listening for Enter on the window) keeps
                Tab-to-Cancel honest: Enter always fires whichever button you
                can actually see is focused. */}
            <button
              autoFocus
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className={cn(
                "px-4 disabled:cursor-not-allowed disabled:opacity-60",
                variant === "danger" ? "ui-button-danger" : "ui-button-primary",
              )}
            >
              {isPending ? <CircleNotch className="size-4 animate-spin" /> : null}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
