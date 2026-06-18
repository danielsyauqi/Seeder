"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  GitBranch,
  ListChecks,
  MagnifyingGlass,
  Trash,
  User,
} from "@phosphor-icons/react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { deleteBranchAction } from "@/lib/actions";
import type { BranchSummary } from "@/lib/services/branches";
import { cn, formatDate } from "@/lib/utils";

type SortKey = "updated" | "name" | "tasks";

type Props = {
  projectId: string;
  branches: BranchSummary[];
  viewerId: string;
  // Owner or leader (or workspace admin) — may delete any non-default branch.
  canManage: boolean;
};

function branchHref(projectId: string, branch: BranchSummary) {
  return branch.isDefault
    ? `/projects/${projectId}/board`
    : `/projects/${projectId}/board?branch=${branch.id}`;
}

/** Trash control: confirms, then submits a hidden delete-branch form. */
function DeleteBranchButton({
  projectId,
  branch,
}: {
  projectId: string;
  branch: BranchSummary;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <>
      <form ref={formRef} action={deleteBranchAction} className="contents">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="branchId" value={branch.id} />
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Delete branch"
          aria-label={`Delete branch ${branch.name}`}
          className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
        >
          <Trash className="size-4" />
        </button>
      </form>
      <ConfirmDialog
        open={open}
        title={`Delete "${branch.name}"?`}
        description={
          <>
            This permanently deletes the branch and{" "}
            <strong className="text-foreground">
              all {branch.taskCount} task{branch.taskCount === 1 ? "" : "s"} and{" "}
              {branch.requestCount} requirement
              {branch.requestCount === 1 ? "" : "s"}
            </strong>{" "}
            on it. This cannot be undone.
          </>
        }
        confirmLabel="Delete branch"
        variant="danger"
        isPending={pending}
        onConfirm={() => {
          setPending(true);
          formRef.current?.requestSubmit();
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

export function BranchIndexList({
  projectId,
  branches,
  viewerId,
  canManage,
}: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [mineOnly, setMineOnly] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = branches.filter((branch) => {
      if (mineOnly && branch.createdById !== viewerId) return false;
      if (!q) return true;
      const haystack = [branch.name, branch.description, branch.createdByName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
    // Pin the default (Main) branch first, then apply the chosen sort.
    rows = [...rows].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "tasks") return b.taskCount - a.taskCount;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    return rows;
  }, [branches, query, sort, mineOnly, viewerId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search branches by name, description, or creator…"
            aria-label="Search branches"
            className="w-full rounded-md border border-border bg-background py-2.5 pl-9 pr-3 text-[13px] text-foreground outline-none transition placeholder:text-muted focus:border-accent"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMineOnly((value) => !value)}
            className={cn(
              "inline-flex min-h-9 items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-medium transition",
              mineOnly
                ? "border-border-strong bg-surface-strong text-foreground"
                : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground",
            )}
          >
            <User className="size-4" />
            Yours
          </button>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            aria-label="Sort branches"
            className="ui-select min-h-9 py-2 text-[13px]"
          >
            <option value="updated">Recently updated</option>
            <option value="name">Name (A–Z)</option>
            <option value="tasks">Most tasks</option>
          </select>
        </div>
      </div>

      <div className="px-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
          {query.trim() || mineOnly
            ? `${filtered.length} of ${branches.length} branches`
            : `${branches.length} branch${branches.length === 1 ? "" : "es"}`}
        </span>
      </div>

      {filtered.length ? (
        <div className="grid gap-2">
          {filtered.map((branch) => {
            // A non-default branch can be deleted by a project manager
            // (owner/leader/admin) or the branch's own creator.
            const canDelete =
              !branch.isDefault &&
              (canManage || branch.createdById === viewerId);
            return (
              <div
                key={branch.id}
                className="group flex items-start gap-3 rounded-md border border-border bg-surface px-4 py-3 transition hover:border-border-strong hover:bg-surface-strong"
              >
                <div className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted">
                  <GitBranch className="size-4" />
                </div>
                <Link
                  href={branchHref(projectId, branch)}
                  className="min-w-0 flex-1"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-[15px] font-medium tracking-[-0.011em] text-foreground">
                      {branch.name}
                    </h3>
                    {branch.isDefault ? (
                      <span className="ui-badge">default</span>
                    ) : null}
                  </div>
                  {branch.description ? (
                    <p className="mt-0.5 line-clamp-1 text-[13px] leading-6 text-muted">
                      {branch.description}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <User className="size-3.5" />
                      {branch.createdByName ?? "Unknown"}
                    </span>
                    <span>Updated {formatDate(branch.updatedAt)}</span>
                    <span className="inline-flex items-center gap-1.5">
                      <ListChecks className="size-3.5" />
                      {branch.taskCount} task{branch.taskCount === 1 ? "" : "s"}
                    </span>
                    <span>
                      {branch.requestCount} requirement
                      {branch.requestCount === 1 ? "" : "s"}
                    </span>
                  </div>
                </Link>
                <div className="flex shrink-0 items-center gap-2">
                  {canDelete ? (
                    <DeleteBranchButton projectId={projectId} branch={branch} />
                  ) : null}
                  <Link
                    href={branchHref(projectId, branch)}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-muted transition hover:text-foreground"
                  >
                    Open
                    <ArrowSquareOut className="size-4" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-12 text-center">
          <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
            <GitBranch className="size-5" />
          </div>
          <p className="mt-3 text-[13px] font-medium text-foreground">
            {query.trim() || mineOnly
              ? "No branches match your filters"
              : "No branches yet"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] leading-6 text-muted">
            {query.trim() || mineOnly
              ? "Try a different search or clear the “Yours” filter."
              : "Create a branch to split a feature's tasks and requirements off from Main."}
          </p>
        </div>
      )}
    </div>
  );
}
