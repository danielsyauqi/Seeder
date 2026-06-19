"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Archive,
  ArrowSquareOut,
  Buildings,
  ChatCircleText,
  Folders,
  GitBranch,
  MagnifyingGlass,
  User,
} from "@phosphor-icons/react";

import { formatProjectStatus } from "@/lib/project-status";
import type { ProjectsDashboard } from "@/lib/data";
import { cn, formatDate } from "@/lib/utils";

const projectStatusBadgeClassNames = {
  production: "border-emerald/30 bg-emerald/10 text-emerald",
  development: "border-aether-blue/40 bg-transparent text-aether-blue",
  poc: "border-border bg-surface text-muted",
  on_hold: "border-border bg-surface text-muted-strong",
  completed: "border-border bg-surface text-foreground",
} as const;

function formatDateLabel(value: Date | null) {
  return formatDate(value, "Open-ended");
}

type Props = {
  projects: ProjectsDashboard["projects"];
  view: "open" | "archived";
  initialSpace?: string;
};

const SPACE_FILTER_COOKIE = "seeder.projects.space";

function persistSpaceFilter(value: string) {
  if (typeof document === "undefined") return;
  const maxAge = 60 * 60 * 24 * 365; // a year
  document.cookie = `${SPACE_FILTER_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; samesite=lax`;
}

export function ProjectIndexList({ projects, view, initialSpace }: Props) {
  const [query, setQuery] = useState("");
  const [spaceFilter, setSpaceFilter] = useState(initialSpace ?? "all");

  // The spaces present in this list (Personal first, then company A→Z), used to
  // build the filter dropdown. Keyed by spaceId, with "personal" for unscoped.
  const spaceOptions = useMemo(() => {
    const map = new Map<
      string,
      { key: string; label: string; kind: "personal" | "company" | null }
    >();
    for (const project of projects) {
      const key = project.spaceId ?? "personal";
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: project.spaceName ?? "Personal",
          kind: project.spaceKind,
        });
      }
    }
    return [...map.values()].sort((a, b) => {
      const ap = a.kind === "personal" ? 0 : 1;
      const bp = b.kind === "personal" ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.label.localeCompare(b.label);
    });
  }, [projects]);

  // Clamp a stale cookie (e.g. a space that no longer has projects) back to All.
  const effectiveSpace =
    spaceFilter !== "all" && !spaceOptions.some((o) => o.key === spaceFilter)
      ? "all"
      : spaceFilter;

  const bySpace = useMemo(
    () =>
      effectiveSpace === "all"
        ? projects
        : projects.filter((p) => (p.spaceId ?? "personal") === effectiveSpace),
    [projects, effectiveSpace],
  );

  const handleSpaceChange = (value: string) => {
    setSpaceFilter(value);
    persistSpaceFilter(value);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bySpace;
    return bySpace.filter((project) => {
      const haystack = [
        project.name,
        project.slug,
        project.clientName,
        project.summary,
        formatProjectStatus(project.status),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [bySpace, query]);

  // Group the (filtered) projects by their space — Personal first, then company
  // spaces alphabetically — so the list reads as space-grouped sections.
  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        kind: "personal" | "company" | null;
        items: typeof filtered;
      }
    >();
    for (const project of filtered) {
      const key = project.spaceId ?? "personal";
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: project.spaceName ?? "Personal",
          kind: project.spaceKind,
          items: [],
        });
      }
      map.get(key)!.items.push(project);
    }
    return [...map.values()].sort((a, b) => {
      const ap = a.kind === "personal" ? 0 : 1;
      const bp = b.kind === "personal" ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.label.localeCompare(b.label);
    });
  }, [filtered]);
  const showGroups = groups.length > 1;

  const renderRow = (project: (typeof projects)[number]) => {
    const colorStyle = project.color
      ? {
          borderLeftWidth: 3,
          borderLeftColor: project.color,
          backgroundColor: `color-mix(in srgb, ${project.color} 8%, transparent)`,
        }
      : undefined;
    return (
      <Link
        key={project.id}
        href={`/projects/${project.id}`}
        className={cn(
          "group rounded-md border border-border px-4 py-3 transition hover:border-border-strong",
          project.color ? null : "bg-surface hover:bg-surface-strong",
        )}
        style={colorStyle}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              <span
                className={cn(
                  "inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
                  projectStatusBadgeClassNames[project.status],
                )}
              >
                {formatProjectStatus(project.status)}
              </span>
              {project.archivedAt ? (
                <span className="ui-badge">archived</span>
              ) : null}
              {project.isOverdue ? (
                <span className="inline-flex rounded-sm border border-danger/30 bg-danger/10 px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-danger">
                  overdue
                </span>
              ) : null}
              {project.branchCount > 1 ? (
                <span
                  title="Counts below span all branches"
                  className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted"
                >
                  <GitBranch className="size-3" />
                  {project.branchCount} branches
                </span>
              ) : null}
            </div>

            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-medium tracking-[-0.011em] text-foreground">
                {project.name}
              </h3>
              {project.clientName && project.clientName !== project.name ? (
                <p className="mt-0.5 text-[13px] leading-6 text-muted">
                  {project.clientName}
                </p>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 lg:max-w-105 lg:flex-1">
            <div className="rounded-sm border border-border bg-background px-3 py-2">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                Inbox
              </p>
              <p className="mt-1 font-mono text-base font-medium text-foreground">
                {project.requestCounts.inbox}
              </p>
            </div>

            <div className="rounded-sm border border-border bg-background px-3 py-2">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                Open
              </p>
              <p className="mt-1 font-mono text-base font-medium text-foreground">
                {project.taskCounts.open}
              </p>
            </div>

            <div className="rounded-sm border border-border bg-background px-3 py-2">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                Deadline
              </p>
              <p className="mt-1 text-[13px] font-medium text-foreground">
                {project.isOverdue ? "Overdue" : formatDateLabel(project.deadline)}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-[13px] text-muted">
          <p className="min-w-0 flex-1 truncate leading-6">
            {project.summary ||
              "No project summary yet. Add the scope and current focus once the workspace is defined."}
          </p>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <ChatCircleText className="size-4" />
            {project.openTasks} open
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-foreground">
            Open
            <ArrowSquareOut className="size-4 text-muted transition group-hover:text-foreground" />
          </span>
        </div>
      </Link>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by project, client, status, or summary…"
            aria-label="Search projects"
            className="w-full rounded-md border border-border bg-background py-2.5 pl-9 pr-3 text-[13px] text-foreground outline-none transition placeholder:text-muted focus:border-accent"
          />
        </div>
        {spaceOptions.length > 1 ? (
          <div className="sm:w-56">
            <select
              value={effectiveSpace}
              onChange={(event) => handleSpaceChange(event.target.value)}
              aria-label="Filter by team"
              className="ui-select"
            >
              <option value="all">All teams</option>
              {spaceOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
          {query.trim() || effectiveSpace !== "all"
            ? `${filtered.length} of ${projects.length} projects`
            : `${projects.length} projects`}
        </span>
      </div>

      {filtered.length ? (
        showGroups ? (
          <div className="space-y-5">
            {groups.map((group) => (
              <div key={group.key} className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  {group.kind === "company" ? (
                    <Buildings className="size-3.5 text-muted" />
                  ) : (
                    <User className="size-3.5 text-muted" />
                  )}
                  <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-foreground">
                    {group.label}
                  </span>
                  <span className="font-mono text-[11px] text-muted">
                    · {group.items.length}
                  </span>
                </div>
                <div className="grid gap-2">{group.items.map(renderRow)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-2">{filtered.map(renderRow)}</div>
        )
      ) : query.trim() ? (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-12 text-center">
          <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
            <Folders className="size-5" />
          </div>
          <p className="mt-3 text-[13px] font-medium text-foreground">
            No projects match “{query.trim()}”
          </p>
          <p className="mt-1 mx-auto max-w-sm text-[13px] leading-6 text-muted">
            Try a different project name, client, or status.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-12 text-center">
          <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
            {view === "archived" ? <Archive className="size-5" /> : <Folders className="size-5" />}
          </div>
          <p className="mt-3 text-[13px] font-medium text-foreground">
            {view === "archived" ? "No archived projects" : "Start a workspace"}
          </p>
          <p className="mt-1 mx-auto max-w-sm text-[13px] leading-6 text-muted">
            {view === "archived"
              ? "Archive a workspace from project settings when it should leave the main list."
              : "Create one to track requests, board work, and notes side by side."}
          </p>
        </div>
      )}
    </div>
  );
}
