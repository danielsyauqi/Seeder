import Link from "next/link";
import {
  ArrowSquareOut,
  ChatCircleText,
  ClockCounterClockwise,
  Kanban,
  NotePencil,
  PencilSimple,
  Plus,
  SlidersHorizontal,
} from "@phosphor-icons/react/dist/ssr";

import { CategoryManager } from "@/components/projects/category-manager";
import { LabelManager } from "@/components/projects/label-manager";
import { KanbanBoard } from "@/components/projects/kanban-board";
import { ProjectColorPicker } from "@/components/projects/project-color-picker";
import { ProjectSlugForm } from "@/components/projects/project-slug-form";
import { formatRequestCode, formatTaskCode } from "@/lib/codes";
import { formatProjectStatus } from "@/lib/project-status";
import { parseRichText, richTextToPlainText } from "@/lib/rich-text";
import { ProjectWorkspaceModalTrigger } from "@/components/projects/project-workspace-ui";
import {
  archiveProjectAction,
  disableClientShareAction,
  duplicateProjectAction,
  enableClientShareAction,
  restoreProjectAction,
  rotateClientShareTokenAction,
  setClientShareVisibilityAction,
} from "@/lib/actions";
import type { ProjectWorkspace } from "@/lib/data";
import { serverEnv } from "@/lib/env";
import { cn } from "@/lib/utils";

const badgeClassNames = {
  active: "border-border bg-surface text-foreground",
  planned: "border-border bg-surface text-muted",
  paused: "border-border bg-surface text-muted-strong",
  completed: "border-emerald/30 bg-emerald/10 text-emerald",
  new: "border-accent/40 bg-accent-soft text-accent",
  reviewed: "border-border bg-surface text-foreground",
  converted: "border-aether-blue/30 bg-aether-blue/10 text-aether-blue",
  closed: "border-border bg-surface text-muted",
  todo: "border-border bg-surface text-muted",
  doing: "border-aether-blue/40 bg-transparent text-aether-blue",
  done: "border-emerald/30 bg-emerald/10 text-emerald",
  low: "border-border bg-surface text-muted",
  medium: "border-border bg-surface-strong text-foreground",
  high: "border-danger/30 bg-danger/10 text-danger",
} as const;

function formatDateLabel(value: Date | null) {
  if (!value) {
    return "No deadline";
  }

  return value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatUpdatedLabel(value: Date | null) {
  if (!value) {
    return "No activity yet";
  }

  return `Updated ${value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function countTasksByStatus(workspace: ProjectWorkspace) {
  return {
    todo: workspace.tasks.filter((task) => task.status === "todo").length,
    doing: workspace.tasks.filter((task) => task.status === "doing").length,
    done: workspace.tasks.filter((task) => task.status === "done").length,
  };
}

function countRequestsInInbox(workspace: ProjectWorkspace) {
  return workspace.requests.filter(
    (request) => request.status === "new" || request.status === "reviewed",
  ).length;
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
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
          {eyebrow}
        </p>
        <div>
          <h2 className="text-[17px] font-medium tracking-[-0.022em] text-foreground">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {action}
    </div>
  );
}


export function ProjectMetricsStrip({
  workspace,
}: {
  workspace: ProjectWorkspace;
}) {
  const taskCounts = countTasksByStatus(workspace);
  const metrics = [
    {
      label: "Inbox requests",
      value: countRequestsInInbox(workspace),
      tone: "text-accent-strong",
    },
    {
      label: "Todo",
      value: taskCounts.todo,
      tone: "text-foreground",
    },
    {
      label: "Doing",
      value: taskCounts.doing,
      tone: "text-accent-strong",
    },
    {
      label: "Done",
      value: taskCounts.done,
      tone: "text-foreground",
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <SectionFrame key={metric.label} className="p-4 sm:p-4">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
            {metric.label}
          </p>
          <p className={cn("mt-1 font-mono text-[28px] font-medium tracking-[-0.022em]", metric.tone)}>
            {metric.value}
          </p>
        </SectionFrame>
      ))}
    </div>
  );
}

export function ProjectBoardSurface({
  workspace,
  currentPath,
  // Overview renders a compact preview (top cards + "Show more" → full board);
  // the Board tab renders the full, draggable, filterable board.
  preview = false,
}: {
  workspace: ProjectWorkspace;
  currentPath: string;
  preview?: boolean;
}) {
  const publishedTaskIds = new Set(
    workspace.statusUpdates.map((update) => update.taskId),
  );
  const boardKey = workspace.tasks
    .map(
      (task) =>
        `${task.id}:${task.status}:${task.sortOrder}:${task.updatedAt.getTime()}:${publishedTaskIds.has(task.id)}`,
    )
    .join("|");
  const boardPath = `/projects/${workspace.project.id}/board`;

  return (
    <SectionFrame>
      <SectionHeader
        eyebrow="Board"
        title="Execution board"
        description={
          preview
            ? "The top of the board at a glance. Open the board tab for the full, filterable surface."
            : "Keep the board visible as the operating surface. Open tasks in modals when you need to adjust details."
        }
        action={
          <div className="flex flex-wrap gap-2">
            {preview ? (
              <Link href={boardPath} className="ui-button-secondary">
                Open board
              </Link>
            ) : null}
            <ProjectWorkspaceModalTrigger
              modal="new-task"
              className="ui-button-primary"
            >
              <Plus className="size-4" />
              New task
            </ProjectWorkspaceModalTrigger>
          </div>
        }
      />
      <KanbanBoard
        key={boardKey}
        projectId={workspace.project.id}
        taskHrefBase={currentPath}
        showFilters={!preview}
        previewLimit={preview ? 5 : undefined}
        showMoreHref={preview ? boardPath : undefined}
        tasks={workspace.tasks.map((task) => {
          const assignee = workspace.members.find(
            (m) => m.userId === task.assigneeId,
          );
          const sourceRequest = task.requestId
            ? workspace.requests.find((r) => r.id === task.requestId) ?? null
            : null;
          const subtasks = workspace.checklistItems.filter(
            (item) => item.taskId === task.id,
          );
          const commentCount = workspace.taskComments.filter(
            (comment) => comment.taskId === task.id,
          ).length;
          return {
            ...task,
            dueDate: task.dueDate ? task.dueDate.toISOString() : null,
            statusChangedAt: (task.statusChangedAt ?? task.createdAt)?.toISOString() ?? null,
            hasStatusUpdate: publishedTaskIds.has(task.id),
            assigneeName: assignee?.name ?? null,
            code: formatTaskCode(workspace.project.slug, task.codeNumber),
            requestCode: sourceRequest
              ? formatRequestCode(
                  workspace.project.slug,
                  sourceRequest.codeNumber,
                )
              : null,
            subtaskTotal: subtasks.length,
            subtaskDone: subtasks.filter((s) => s.isCompleted).length,
            commentCount,
          };
        })}
      />
    </SectionFrame>
  );
}

export function ProjectNotesSurface({
  workspace,
  currentPath,
  expanded = false,
}: {
  workspace: ProjectWorkspace;
  currentPath: string;
  expanded?: boolean;
}) {
  const noteContent = workspace.note?.content.trim() ?? "";

  return (
    <SectionFrame className={expanded ? "" : "h-full"}>
      <SectionHeader
        eyebrow="Notes"
        title="Running context"
        description="Keep decisions, client tone, blockers, and next-review notes in one place."
        action={
          <ProjectWorkspaceModalTrigger
            modal="notes"
            className="ui-button-secondary"
          >
            <PencilSimple className="size-4" />
            {noteContent ? "Edit notes" : "Add notes"}
          </ProjectWorkspaceModalTrigger>
        }
      />

      {noteContent ? (
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1 font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
            <ClockCounterClockwise className="size-4" />
            {formatUpdatedLabel(workspace.note?.updatedAt ?? null)}
          </div>
          <div
            className={cn(
              "rounded-md border border-border bg-surface px-5 py-5 text-sm leading-7 text-foreground whitespace-pre-wrap",
              !expanded && "line-clamp-[14]",
            )}
          >
            {noteContent}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center">
          <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
            <NotePencil className="size-5" />
          </div>
          <p className="mt-3 text-[13px] font-medium text-foreground">No project notes yet</p>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            Capture decisions, research, and client context here so it does not crowd the workspace.
          </p>
        </div>
      )}
    </SectionFrame>
  );
}

export function ProjectRequestsSurface({
  workspace,
}: {
  workspace: ProjectWorkspace;
}) {
  return (
    <SectionFrame>
      <SectionHeader
        eyebrow="Requests"
        title="Client request inbox"
        description="Keep incoming work separate from execution. Review the request, then convert it into a task when it is ready."
        action={
          <ProjectWorkspaceModalTrigger
            modal="new-request"
            className="ui-button-primary"
          >
            <Plus className="size-4" />
            New request
          </ProjectWorkspaceModalTrigger>
        }
      />

      {workspace.requests.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {workspace.requests.map((request) => {
            const code = formatRequestCode(
              workspace.project.slug,
              request.codeNumber,
            );
            const linkedTask =
              workspace.tasks.find((task) => task.requestId === request.id) ?? null;
            const linkedTaskCode = linkedTask
              ? formatTaskCode(workspace.project.slug, linkedTask.codeNumber)
              : null;
            return (
            <article
              key={request.id}
              className="rounded-md border border-border bg-surface p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <span
                      className={cn(
                        "inline-flex rounded-md border px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
                        badgeClassNames[request.status],
                      )}
                    >
                      {request.status}
                    </span>
                    <span
                      className={cn(
                        "inline-flex rounded-md border px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
                        badgeClassNames[request.priority],
                      )}
                    >
                      {request.priority}
                    </span>
                  </div>
                  <div>
                    {code ? (
                      <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted">
                        {code}
                      </p>
                    ) : null}
                    <h3 className="text-[15px] font-medium tracking-[-0.011em] text-foreground">
                      {request.title}
                    </h3>
                    <p className="mt-2 line-clamp-4 text-sm leading-6 text-muted">
                      {richTextToPlainText(parseRichText(request.description)) ||
                        "No additional context yet."}
                    </p>
                  </div>
                </div>
                <ProjectWorkspaceModalTrigger
                  modal="request"
                  requestId={request.id}
                  className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-background text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
                >
                  <ArrowSquareOut className="size-4" />
                  <span className="sr-only">Open request</span>
                </ProjectWorkspaceModalTrigger>
              </div>
              {linkedTaskCode ? (
                <div className="mt-3 flex justify-end font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                  → {linkedTaskCode}
                </div>
              ) : null}
            </article>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center">
          <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
            <ChatCircleText className="size-5" />
          </div>
          <p className="mt-3 text-[13px] font-medium text-foreground">Inbox is empty</p>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            Capture incoming asks here, then convert them into tasks once the work is ready to move.
          </p>
        </div>
      )}
    </SectionFrame>
  );
}

export function ProjectSettingsSurface({
  workspace,
  currentPath,
}: {
  workspace: ProjectWorkspace;
  currentPath: string;
}) {
  const isArchived = Boolean(workspace.project.archivedAt);
  const shareEnabled = workspace.project.clientShareEnabled;
  const shareToken = workspace.project.clientShareToken;
  const clientBoardPath = shareToken ? `/client/${shareToken}` : null;
  const clientBoardUrl =
    clientBoardPath && serverEnv.betterAuthUrl
      ? `${serverEnv.betterAuthUrl}${clientBoardPath}`
      : clientBoardPath;
  const stats = [
    {
      label: "Status",
      value: formatProjectStatus(workspace.project.status),
    },
    {
      label: "Client",
      value: workspace.project.clientName || "No client assigned",
    },
    {
      label: "Deadline",
      value: formatDateLabel(workspace.project.deadline),
    },
    {
      label: "Summary",
      value:
        workspace.project.summary ||
        "No project summary yet. Use the project modal to define the scope.",
    },
  ];

  return (
    <div className="grid gap-6">
      <SectionFrame>
        <SectionHeader
          eyebrow="Settings"
          title="Project configuration"
          description="Keep core project metadata separate from the execution surface."
          action={
            <ProjectWorkspaceModalTrigger
              modal="project"
              className="ui-button-secondary"
            >
              <SlidersHorizontal className="size-4" />
              Edit project
            </ProjectWorkspaceModalTrigger>
          }
        />

        <div className="grid gap-4 lg:grid-cols-2">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-md border border-border bg-surface px-4 py-4"
            >
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                {stat.label}
              </p>
              <p className="mt-3 text-sm leading-7 text-foreground">{stat.value}</p>
            </div>
          ))}
        </div>
      </SectionFrame>

      <SectionFrame>
        <SectionHeader
          eyebrow="Identity"
          title="Project key"
          description="Short code that prefixes every task (LFMS-50) and client request (LFMS-CR-3). Auto-derived at creation; rename with care."
        />
        <ProjectSlugForm
          projectId={workspace.project.id}
          currentSlug={workspace.project.slug}
          returnTo={currentPath}
        />
      </SectionFrame>

      <SectionFrame>
        <SectionHeader
          eyebrow="Branding"
          title="Project color"
          description="Picks a soft tint for this project across the sidebar, search, and projects list. Leave empty for neutral."
        />
        <ProjectColorPicker
          projectId={workspace.project.id}
          currentColor={workspace.project.color}
          returnTo={currentPath}
        />
      </SectionFrame>

      <SectionFrame>
        <SectionHeader
          eyebrow="Taxonomy"
          title="Task categories"
          description="Reusable labels and card tints. Rename or recolor anywhere and every linked task picks it up. Deleting requires zero linked tasks."
        />
        <CategoryManager
          categories={workspace.categories.map((category) => ({
            id: category.id,
            name: category.name,
            color: category.color,
            taskCount: workspace.tasks.filter(
              (task) => task.categoryId === category.id,
            ).length,
          }))}
        />
      </SectionFrame>

      <SectionFrame>
        <SectionHeader
          eyebrow="Taxonomy"
          title="Task labels"
          description="Multi-assign tags for tasks — a task can carry several. Independent of categories; assign them from the task modal. Deleting a label untags it everywhere."
        />
        <LabelManager
          projectId={workspace.project.id}
          labels={workspace.labels.map((label) => ({
            id: label.id,
            name: label.name,
            color: label.color,
            taskCount: workspace.tasks.filter((task) =>
              (task.labels ?? []).some((l) => l.id === label.id),
            ).length,
          }))}
        />
      </SectionFrame>

      <SectionFrame>
        <SectionHeader
          eyebrow="Actions"
          title="Workspace actions"
          description="Use these when the project needs to move out of the main list, spin into a copy, or leave the app entirely."
        />

        <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
          <div className="flex h-full flex-col rounded-md border border-border bg-surface px-4 py-4">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
              Client view
            </p>
            <h3 className="mt-3 text-[15px] font-medium tracking-[-0.011em] text-foreground">
              Public board link
            </h3>
            {shareEnabled && clientBoardPath ? (
              <>
                <p className="mt-2 text-sm leading-7 text-muted">
                  Anyone with this link can view the board. Rotate it to revoke
                  the current link.
                </p>
                <p className="mt-2 break-all text-sm leading-7 text-muted">
                  {clientBoardUrl}
                </p>
                <div className="mt-auto grid gap-2 pt-5">
                  <Link
                    href={clientBoardPath}
                    target="_blank"
                    rel="noreferrer"
                    className="ui-button-secondary w-full"
                  >
                    Open client board
                  </Link>
                  <div className="grid grid-cols-2 gap-2">
                    <form action={rotateClientShareTokenAction}>
                      <input
                        type="hidden"
                        name="projectId"
                        value={workspace.project.id}
                      />
                      <input type="hidden" name="returnTo" value={currentPath} />
                      <button
                        type="submit"
                        className="ui-button-secondary w-full"
                      >
                        Rotate link
                      </button>
                    </form>
                    <form action={disableClientShareAction}>
                      <input
                        type="hidden"
                        name="projectId"
                        value={workspace.project.id}
                      />
                      <input type="hidden" name="returnTo" value={currentPath} />
                      <button
                        type="submit"
                        className="ui-button-secondary w-full"
                      >
                        Make private
                      </button>
                    </form>
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm leading-7 text-muted">
                  The board is private. Publish it to share a read-only link with
                  your client.
                </p>
                <form
                  action={enableClientShareAction}
                  className="mt-auto pt-5"
                >
                  <input
                    type="hidden"
                    name="projectId"
                    value={workspace.project.id}
                  />
                  <input type="hidden" name="returnTo" value={currentPath} />
                  <button type="submit" className="ui-button-secondary w-full">
                    Publish client board
                  </button>
                </form>
              </>
            )}
          </div>

          <div className="flex h-full flex-col rounded-md border border-border bg-surface px-4 py-4">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
              Duplicate
            </p>
            <h3 className="mt-3 text-[15px] font-medium tracking-[-0.011em] text-foreground">
              Duplicate workspace
            </h3>
            <p className="mt-2 text-sm leading-7 text-muted">
              Copy this project, its tasks, its requests, and its notes into a new
              workspace.
            </p>
            <form action={duplicateProjectAction} className="mt-auto pt-5">
              <input type="hidden" name="projectId" value={workspace.project.id} />
              <button type="submit" className="ui-button-secondary w-full">
                Duplicate workspace
              </button>
            </form>
          </div>

          <div className="flex h-full flex-col rounded-md border border-border bg-surface px-4 py-4">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
              Visibility
            </p>
            <h3 className="mt-3 text-[15px] font-medium tracking-[-0.011em] text-foreground">
              {isArchived ? "Restore project" : "Archive project"}
            </h3>
            <p className="mt-2 text-sm leading-7 text-muted">
              {isArchived
                ? "Move it back into the main workspace list."
                : "Hide it from the main list without deleting any work."}
            </p>
            <form
              action={isArchived ? restoreProjectAction : archiveProjectAction}
              className="mt-auto pt-5"
            >
              <input type="hidden" name="projectId" value={workspace.project.id} />
              <input
                type="hidden"
                name="returnTo"
                value={isArchived ? currentPath : "/projects?view=archived"}
              />
              <button type="submit" className="ui-button-secondary w-full">
                {isArchived ? "Restore project" : "Archive project"}
              </button>
            </form>
          </div>

          <div className="flex h-full flex-col rounded-md border border-danger/20 bg-danger/10 px-4 py-4">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-danger">
              Danger
            </p>
            <h3 className="mt-3 text-[15px] font-medium tracking-[-0.011em] text-foreground">
              Delete workspace
            </h3>
            <p className="mt-2 text-sm leading-7 text-muted">
              Remove the project and all of its requests, tasks, notes, and activity.
            </p>
            <ProjectWorkspaceModalTrigger
              modal="delete-project"
              className="ui-button-danger mt-auto w-full"
            >
              Delete workspace
            </ProjectWorkspaceModalTrigger>
          </div>
        </div>
      </SectionFrame>

      {shareEnabled ? (
        <SectionFrame>
          <SectionHeader
            eyebrow="Client view"
            title="Public view options"
            description="Choose what clients see on the shared board link. Hidden sections never reach the public page."
          />
          <form action={setClientShareVisibilityAction} className="space-y-3">
            <input type="hidden" name="projectId" value={workspace.project.id} />
            <input type="hidden" name="returnTo" value={currentPath} />
            <ClientVisibilityToggle
              name="showBoard"
              title="Task board"
              description="Show the whole task board. Hiding it leaves only the project summary and updates."
              defaultChecked={workspace.project.clientShareShowBoard}
            />
            <ClientVisibilityToggle
              name="showDescription"
              title="Full task description"
              description="Let clients open a task to read its full description. When hidden, cards are not clickable."
              defaultChecked={workspace.project.clientShareShowDescription}
            />
            <ClientVisibilityToggle
              name="showCommits"
              title="Commit changes"
              description="Show the published status-update log (commit history) on the public page."
              defaultChecked={workspace.project.clientShareShowCommits}
            />
            <div className="pt-1">
              <button type="submit" className="ui-button-secondary">
                Save public view
              </button>
            </div>
          </form>
        </SectionFrame>
      ) : null}
    </div>
  );
}

function ClientVisibilityToggle({
  name,
  title,
  description,
  defaultChecked,
}: {
  name: string;
  title: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface px-4 py-3 transition hover:border-border-strong">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 size-4 accent-accent"
      />
      <span className="space-y-1">
        <span className="block text-[14px] font-medium text-foreground">
          {title}
        </span>
        <span className="block text-[13px] leading-6 text-muted">
          {description}
        </span>
      </span>
    </label>
  );
}

export function ProjectOverviewQuickLinks({
  projectId,
}: {
  projectId: string;
}) {
  const links = [
    {
      label: "Requests",
      description: "Review the inbox before work moves onto the board.",
      href: `/projects/${projectId}/requests`,
      icon: ChatCircleText,
    },
    {
      label: "Board",
      description: "Open the full board view when you want execution to take over the screen.",
      href: `/projects/${projectId}/board`,
      icon: Kanban,
    },
    {
      label: "Notes",
      description: "Use a dedicated note view when you need room to think and write.",
      href: `/projects/${projectId}/notes`,
      icon: NotePencil,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-1">
      {links.map((link) => {
        const Icon = link.icon;

        return (
          <Link
            key={link.label}
            href={link.href}
            className="rounded-md border border-border bg-surface px-4 py-4 transition hover:bg-accent-soft/70"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-3">
                <div className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-background text-muted-strong">
                  <Icon className="size-5" />
                </div>
                <div>
                  <h3 className="text-[15px] font-medium tracking-[-0.011em] text-foreground">
                    {link.label}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    {link.description}
                  </p>
                </div>
              </div>
              <ArrowSquareOut className="mt-1 size-4 text-muted" />
            </div>
          </Link>
        );
      })}
    </div>
  );
}
