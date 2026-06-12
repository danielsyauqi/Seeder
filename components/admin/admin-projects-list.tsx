"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowSquareOut,
  Folders,
  MagnifyingGlass,
  User as UserIcon,
} from "@phosphor-icons/react";

import { formatProjectStatus } from "@/lib/project-status";
import type { AdminProjectSummary } from "@/lib/data-admin";
import { cn } from "@/lib/utils";

const projectStatusBadgeClassNames = {
  production: "border-emerald/30 bg-emerald/10 text-emerald",
  development: "border-aether-blue/40 bg-transparent text-aether-blue",
  poc: "border-border bg-surface text-muted",
  on_hold: "border-border bg-surface text-muted-strong",
  completed: "border-border bg-surface text-foreground",
} as const;

function formatDeadline(value: Date | null) {
  if (!value) return "Open-ended";
  return value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type Props = {
  projects: AdminProjectSummary[];
};

export function AdminProjectsList({ projects }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((project) => {
      const haystack = [
        project.name,
        project.slug,
        project.clientName,
        project.summary,
        project.ownerName,
        project.ownerEmail,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [projects, query]);

  return (
    <div className="space-y-4">
      <div className="relative">
        <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by project, client, owner, or summary…"
          aria-label="Search projects"
          className="w-full rounded-md border border-border bg-background py-2.5 pl-9 pr-3 text-[13px] text-foreground outline-none transition placeholder:text-muted focus:border-accent"
        />
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
          {query.trim()
            ? `${filtered.length} of ${projects.length} projects`
            : `${projects.length} projects`}
        </span>
      </div>

      {filtered.length ? (
        <div className="grid gap-2">
          {filtered.map((project) => {
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
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          "inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
                          projectStatusBadgeClassNames[project.status],
                        )}
                      >
                        {formatProjectStatus(project.status)}
                      </span>
                      {project.slug ? (
                        <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                          {project.slug}
                        </span>
                      ) : null}
                      {project.archivedAt ? (
                        <span className="ui-badge">archived</span>
                      ) : null}
                    </div>

                    <div className="min-w-0">
                      <h3 className="truncate text-[15px] font-medium tracking-[-0.011em] text-foreground">
                        {project.name}
                      </h3>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] leading-6 text-muted">
                        <span className="inline-flex items-center gap-1">
                          <UserIcon className="size-3.5" />
                          {project.ownerName ?? "Unknown owner"}
                        </span>
                        {project.ownerEmail ? (
                          <span className="font-mono text-[11px]">
                            {project.ownerEmail}
                          </span>
                        ) : null}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 lg:max-w-130 lg:flex-1">
                    <Stat label="Todo" value={project.tasksTodo} />
                    <Stat label="Doing" value={project.tasksDoing} />
                    <Stat label="Done" value={project.tasksDone} />
                    <Stat label="Members" value={project.memberCount} />
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-[13px] text-muted">
                  <p className="min-w-0 flex-1 truncate leading-6">
                    {project.summary || "No project summary yet."}
                  </p>
                  <span className="whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.04em]">
                    {formatDeadline(project.deadline)}
                  </span>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-foreground">
                    Open
                    <ArrowSquareOut className="size-4 text-muted transition group-hover:text-foreground" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-12 text-center">
          <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
            <Folders className="size-5" />
          </div>
          <p className="mt-3 text-[13px] font-medium text-foreground">
            {query.trim() ? (
              <>No projects match “{query.trim()}”</>
            ) : (
              "No projects yet"
            )}
          </p>
          <p className="mt-1 mx-auto max-w-sm text-[13px] leading-6 text-muted">
            {query.trim()
              ? "Try a different project name, client, or owner."
              : "Projects created by any member will show up here."}
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-sm border border-border bg-background px-3 py-2">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
        {label}
      </p>
      <p className="mt-1 font-mono text-base font-medium text-foreground">
        {value}
      </p>
    </div>
  );
}
