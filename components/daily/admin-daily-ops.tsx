"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  CaretLeft,
  CaretRight,
  Kanban,
  MagnifyingGlass,
  Plus,
  Trash,
} from "@phosphor-icons/react";

import {
  AssignItemModal,
  type AssignUser,
} from "@/components/daily/assign-item-modal";
import type { PlannerProject } from "@/components/daily/daily-item-modal";
import { Avatar } from "@/components/ui/avatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { adminDeleteDailyTaskAction } from "@/lib/actions";
import { addDays, formatDateKey, formatFriendlyDate, parseDateKey } from "@/lib/daily";
import { toast } from "@/lib/toast";
import { cn, withSearchParams } from "@/lib/utils";

type DailyOpsItem = {
  id: string;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  createdById: string | null;
  createdByName: string | null;
  title: string;
  status: "todo" | "doing" | "done";
  priority: "low" | "medium" | "high";
  kind: "adhoc" | "project";
  projectName: string | null;
  projectColor: string | null;
  linkedTaskId: string | null;
  // The linked board task's custom status name + color (null when unlinked).
  linkedStatus: string | null;
  linkedStatusColor: string | null;
  batchId: string | null;
};

type AdminDailyOpsProps = {
  dateKey: string;
  view: "board" | "table";
  users: AssignUser[];
  items: DailyOpsItem[];
  projects: PlannerProject[];
};

type AssignState = { open: boolean; userId?: string };

const statusTone: Record<DailyOpsItem["status"], string> = {
  todo: "border-border bg-surface text-muted",
  doing: "border-aether-blue/40 bg-transparent text-aether-blue",
  done: "border-emerald/30 bg-emerald/10 text-emerald",
};

function ItemCard({
  item,
  onDelete,
}: {
  item: DailyOpsItem;
  onDelete: (item: DailyOpsItem) => void;
}) {
  const assignedByAdmin = item.createdById && item.createdById !== item.ownerId;
  return (
    <article
      className="rounded-md border border-border bg-surface p-2.5 shadow-sm"
      style={
        item.projectColor
          ? {
              backgroundColor: `color-mix(in srgb, ${item.projectColor} 10%, var(--surface))`,
            }
          : undefined
      }
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {item.kind === "project" && item.projectName ? (
            <span className="inline-flex max-w-full items-center truncate rounded-sm border border-accent/30 bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-accent">
              {item.projectName}
            </span>
          ) : (
            <span className="ui-badge">Adhoc</span>
          )}
          <span
            className={cn(
              "inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
              statusTone[item.status],
            )}
          >
            {item.status}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onDelete(item)}
          className="shrink-0 rounded-md border border-border bg-background p-1.5 text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
          aria-label={`Delete ${item.title}`}
        >
          <Trash className="size-3.5" />
        </button>
      </div>
      <h3 className="mt-2 text-[13px] font-medium leading-snug text-foreground">
        {item.title}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
        {item.linkedTaskId ? (
          <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5">
            <Kanban className="size-3.5" />
            board:{" "}
            {item.linkedStatus ? (
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: item.linkedStatusColor ?? "#8a8f98" }}
                />
                {item.linkedStatus}
              </span>
            ) : (
              "?"
            )}
          </span>
        ) : null}
        {assignedByAdmin && item.createdByName ? (
          <span className="normal-case">by {item.createdByName}</span>
        ) : null}
      </div>
    </article>
  );
}

export function AdminDailyOps({
  dateKey,
  view,
  users,
  items,
  projects,
}: AdminDailyOpsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const anchor = parseDateKey(dateKey);
  const [assign, setAssign] = useState<AssignState>({ open: false });
  const [deleting, setDeleting] = useState<DailyOpsItem | null>(null);
  const [query, setQuery] = useState("");

  // Live, case-insensitive substring match on name or email. The board/table
  // below render this filtered list so results update on each keystroke.
  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q),
    );
  }, [users, query]);

  // Toast after an assign/delete redirect, then strip the flash param.
  useEffect(() => {
    const flash = searchParams.get("flash");
    if (!flash) return;
    const copy: Record<string, string> = {
      assigned: "Item assigned",
      removed: "Item removed",
    };
    if (copy[flash]) toast(copy[flash], "success");
    router.replace(withSearchParams("/admin/daily", { date: dateKey, view, flash: null }), {
      scroll: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const itemsByOwner = new Map<string, DailyOpsItem[]>();
  for (const item of items) {
    const list = itemsByOwner.get(item.ownerId) ?? [];
    list.push(item);
    itemsByOwner.set(item.ownerId, list);
  }

  const prevKey = formatDateKey(addDays(anchor, -1));
  const nextKey = formatDateKey(addDays(anchor, 1));
  const todayKey = formatDateKey(new Date());
  const navHref = (date: string, nextView = view) =>
    withSearchParams("/admin/daily", { date, view: nextView });

  return (
    <div className="grid gap-6">
      <section className="ui-panel ui-header p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl space-y-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
              Admin · daily ops
            </p>
            <h1 className="text-3xl font-medium tracking-tighter text-foreground sm:text-[40px]">
              Team standup
            </h1>
            <p className="max-w-2xl text-[13px] leading-6 text-muted sm:text-[15px]">
              See everyone&apos;s plan for the day and assign work to one or many
              people.
            </p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-1.5">
              <Link
                href={navHref(prevKey)}
                scroll={false}
                className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
                aria-label="Previous day"
              >
                <CaretLeft className="size-4" />
              </Link>
              <Link
                href={navHref(todayKey)}
                scroll={false}
                className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-foreground transition hover:border-border-strong hover:bg-surface-strong"
              >
                Today
              </Link>
              <Link
                href={navHref(nextKey)}
                scroll={false}
                className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
                aria-label="Next day"
              >
                <CaretRight className="size-4" />
              </Link>
            </div>
            <p className="font-mono text-[12px] text-muted">
              {formatFriendlyDate(anchor)}
            </p>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
                <Link
                  href={navHref(dateKey, "board")}
                  scroll={false}
                  className={cn(
                    "min-h-8 rounded-sm px-3 text-[13px] font-medium leading-8 transition",
                    view === "board"
                      ? "bg-surface-strong text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                >
                  Board
                </Link>
                <Link
                  href={navHref(dateKey, "table")}
                  scroll={false}
                  className={cn(
                    "min-h-8 rounded-sm px-3 text-[13px] font-medium leading-8 transition",
                    view === "table"
                      ? "bg-surface-strong text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                >
                  Table
                </Link>
              </div>
              <button
                type="button"
                onClick={() => setAssign({ open: true })}
                className="ui-button-primary"
              >
                <Plus className="size-4" />
                Assign item
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Spotlight-style people search — centered pill. */}
      <div className="relative mx-auto w-full max-w-xl">
        <MagnifyingGlass className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people…"
          aria-label="Search people"
          className="h-12 w-full rounded-full border border-border bg-surface pl-11 pr-4 text-[14px] text-foreground shadow-sm outline-none transition placeholder:text-muted hover:border-border-strong focus:border-border-strong focus:shadow-md focus:ring-2 focus:ring-accent/30"
        />
      </div>

      {filteredUsers.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center text-[13px] text-muted">
          No people match &ldquo;{query.trim()}&rdquo;.
        </div>
      ) : view === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {filteredUsers.map((u) => {
            const userItems = itemsByOwner.get(u.id) ?? [];
            return (
              <section
                key={u.id}
                className="flex min-h-[160px] w-[85vw] max-w-[300px] shrink-0 flex-col rounded-md border border-border bg-surface/60 px-3 py-3 sm:w-[260px] sm:max-w-none"
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <Avatar
                    name={u.name}
                    email={u.email}
                    image={u.image}
                    px={32}
                    className="size-8 text-[11px]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {u.name}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted">
                      {userItems.length} item{userItems.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="flex-1 space-y-2">
                  {userItems.length ? (
                    userItems.map((item) => (
                      <ItemCard key={item.id} item={item} onDelete={setDeleting} />
                    ))
                  ) : (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] leading-5 text-muted">
                      Nothing planned
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setAssign({ open: true, userId: u.id })}
                  className="ui-button-ghost mt-2 w-full justify-center text-[12px]"
                >
                  <Plus className="size-3.5" />
                  Add for {u.name.split(" ")[0]}
                </button>
              </section>
            );
          })}
        </div>
      ) : (
        <section className="ui-panel overflow-hidden p-0">
          <div className="divide-y divide-border">
            {filteredUsers.map((u) => {
              const userItems = itemsByOwner.get(u.id) ?? [];
              return (
                <div
                  key={u.id}
                  className="flex flex-wrap items-start gap-3 px-4 py-3"
                >
                  <div className="flex w-48 shrink-0 items-center gap-2.5">
                    <Avatar
                      name={u.name}
                      email={u.email}
                      image={u.image}
                      px={32}
                      className="size-8 text-[11px]"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {u.name}
                      </p>
                      <p className="truncate font-mono text-[11px] text-muted">
                        {userItems.length} item{userItems.length === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                    {userItems.length ? (
                      userItems.map((item) => (
                        <div key={item.id} className="w-full sm:w-[260px]">
                          <ItemCard item={item} onDelete={setDeleting} />
                        </div>
                      ))
                    ) : (
                      <span className="self-center text-[12px] text-muted">
                        Nothing planned
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setAssign({ open: true, userId: u.id })}
                      className="ui-button-ghost h-fit self-center text-[12px]"
                    >
                      <Plus className="size-3.5" />
                      Add
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {assign.open ? (
        <AssignItemModal
          dateKey={dateKey}
          users={users}
          projects={projects}
          preselectUserId={assign.userId}
          onClose={() => setAssign({ open: false })}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this item?"
        description={
          deleting?.batchId
            ? "This was assigned to several people. This removes only this person's copy."
            : "This removes the item from this person's plan."
        }
        confirmLabel="Delete"
        cancelLabel="Keep"
        variant="danger"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const form = document.getElementById(
            "admin-daily-delete-form",
          ) as HTMLFormElement | null;
          const input = document.getElementById(
            "admin-daily-delete-id",
          ) as HTMLInputElement | null;
          if (form && input && deleting) {
            input.value = deleting.id;
            form.requestSubmit();
          }
        }}
      />
      <form
        id="admin-daily-delete-form"
        action={adminDeleteDailyTaskAction}
        className="hidden"
      >
        <input id="admin-daily-delete-id" type="hidden" name="dailyTaskId" value="" />
      </form>
    </div>
  );
}
