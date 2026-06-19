import Link from "next/link";
import { cookies } from "next/headers";

import { CreateProjectModal } from "@/components/projects/create-project-modal";
import { ProjectIndexList } from "@/components/projects/project-index-list";
import { requireViewer } from "@/lib/auth-server";
import { getProjectsDashboardForViewer } from "@/lib/data";
import { listSpaces } from "@/lib/services/spaces";
import { cn, withSearchParams } from "@/lib/utils";

export const dynamic = "force-dynamic";
const PROJECTS_PAGE_VERSION = "2026-05-11.1";

type ProjectsPageSearchParams = {
  modal?: string | string[];
  view?: string | string[];
};

function toSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function buildViewHref(path: string, view: "open" | "archived") {
  return withSearchParams(path, {
    view: view === "archived" ? "archived" : undefined,
  });
}

function SectionFrame({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "ui-panel p-5 sm:p-6",
        className,
      )}
    >
      {children}
    </section>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h2 className="text-[17px] font-medium tracking-[-0.022em] text-foreground">
          {title}
        </h2>
        {description ? (
          <p className="max-w-2xl text-[13px] leading-6 text-muted">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <SectionFrame className="p-4 sm:p-4">
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
        {label}
      </p>
      <p className="mt-1 font-mono text-[28px] font-medium tracking-[-0.022em] text-foreground">
        {value}
      </p>
      <p className="mt-1 text-[13px] leading-6 text-muted">{detail}</p>
    </SectionFrame>
  );
}

type ProjectsPageProps = {
  searchParams: Promise<ProjectsPageSearchParams>;
};

export default async function ProjectsPage({
  searchParams,
}: ProjectsPageProps) {
  const viewer = await requireViewer();
  const resolvedSearchParams = await searchParams;
  const modal = toSingleParam(resolvedSearchParams.modal);
  const view = toSingleParam(resolvedSearchParams.view) === "archived"
    ? "archived"
    : "open";
  const dashboard = await getProjectsDashboardForViewer(viewer, view);
  // Persisted space filter for the project index (set client-side by the list).
  const initialSpace = (await cookies()).get("seeder.projects.space")?.value;
  // Spaces the viewer may create a project in (their Personal + company spaces
  // they lead / admin), for the create-project picker.
  const postableSpaces = (await listSpaces(viewer))
    .filter((s) => s.canPost)
    .map((s) => ({ id: s.id, name: s.name, kind: s.kind }));
  const currentPath = "/projects";
  const viewPath = buildViewHref(currentPath, view);
  const summary = view === "archived" ? dashboard.archivedSummary : dashboard.summary;
  const projectsNeedingAttention = dashboard.projects.filter(
    (project) =>
      project.isOverdue ||
      project.requestCounts.inbox > 0 ||
      project.taskCounts.open > 0,
  ).length;

  return (
    <>
      <div
        data-projects-page-version={PROJECTS_PAGE_VERSION}
        className="grid gap-6"
      >
        <SectionFrame className="ui-header">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-3xl space-y-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">Projects</p>
              <h1 className="text-3xl font-medium tracking-tighter text-foreground sm:text-[40px]">
                {view === "archived" ? "Archived workspaces" : "Project index"}
              </h1>
              <p className="max-w-2xl text-[13px] leading-6 text-muted sm:text-[15px]">
                {view === "archived"
                  ? "Keep archived work out of the main list, but close enough to restore when needed."
                  : "Open active work fast, keep archived work separate, and avoid turning this page into a metrics wall."}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                <span>{dashboard.summary.totalProjects} open</span>
                <span>{dashboard.archivedProjects.length} archived</span>
                <span>{projectsNeedingAttention} need attention</span>
                <span>{viewer.email}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Link
                  href={buildViewHref(currentPath, "open")}
                  className={cn(
                    "inline-flex min-h-9 items-center rounded-md border px-3 py-1.5 text-[13px] font-medium transition",
                    view === "open"
                      ? "border-border-strong bg-surface-strong text-foreground"
                      : "border-border bg-surface text-muted hover:border-border-strong hover:bg-surface-strong hover:text-foreground",
                  )}
                >
                  Open
                </Link>
                <Link
                  href={buildViewHref(currentPath, "archived")}
                  className={cn(
                    "inline-flex min-h-9 items-center rounded-md border px-3 py-1.5 text-[13px] font-medium transition",
                    view === "archived"
                      ? "border-border-strong bg-surface-strong text-foreground"
                      : "border-border bg-surface text-muted hover:border-border-strong hover:bg-surface-strong hover:text-foreground",
                  )}
                >
                  Archived
                </Link>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <CreateProjectModal
                closeHref={viewPath}
                clearUrlOnClose={modal === "new-project"}
                defaultOpen={modal === "new-project"}
                spaces={postableSpaces}
              />
            </div>
          </div>
        </SectionFrame>

        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard
            label="Open"
            value={summary.tasksOpen.toString()}
            detail={
              view === "archived"
                ? "Open tasks left in archived work."
                : "Tasks still in an open status."
            }
          />
          <StatCard
            label="Finished"
            value={summary.completedTasks.toString()}
            detail={
              view === "archived"
                ? "Tasks completed inside archived workspaces."
                : "Tasks completed across all open projects."
            }
          />
        </div>

        <SectionFrame>
          <SectionHeader
            title={view === "archived" ? "Archived workspaces" : "Your workspaces"}
            description={
              view === "archived"
                ? "Restore a workspace when it needs to return to the main list."
                : "Open a project when you want to work. Keep the rest visible, but quiet."
            }
          />

          <ProjectIndexList
            projects={dashboard.projects}
            view={view}
            initialSpace={initialSpace}
          />
        </SectionFrame>
      </div>
    </>
  );
}
