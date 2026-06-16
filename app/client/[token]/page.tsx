import Link from "next/link";
import {
  CalendarDots,
  StackSimple,
} from "@phosphor-icons/react/dist/ssr";
import { notFound } from "next/navigation";

import { ClientBoardTasks } from "@/components/projects/client-board-tasks";
import {
  ClientStatusUpdates,
  type ClientStatusUpdate,
} from "@/components/projects/client-status-updates";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { getPublicProjectBoard } from "@/lib/data";
import { formatProjectStatus } from "@/lib/project-status";

// A shared board is a capability URL — keep it out of search indexes even if
// the link ever lands on a crawlable page.
export const metadata = {
  robots: { index: false, follow: false },
};

function formatDateLabel(value: Date | null) {
  if (!value) {
    return "No deadline set";
  }

  return value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDayLabel(value: Date) {
  return value.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getDayKey(value: Date) {
  return [
    value.getFullYear(),
    `${value.getMonth() + 1}`.padStart(2, "0"),
    `${value.getDate()}`.padStart(2, "0"),
  ].join("-");
}

export default async function ClientProjectBoardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const publicBoard = await getPublicProjectBoard(token);

  if (!publicBoard) {
    notFound();
  }

  const { showBoard, showDescription, showCommits } = publicBoard.project;

  const taskCounts = {
    todo: publicBoard.tasks.filter((task) => task.status === "todo").length,
    doing: publicBoard.tasks.filter((task) => task.status === "doing").length,
    done: publicBoard.tasks.filter((task) => task.status === "done").length,
  };
  // Echo the project's set color on the public hero — a left-edge accent plus a
  // soft wash — instead of the neutral grey panel. Matches the projects list.
  const accentStyle = publicBoard.project.color
    ? {
        borderLeftWidth: 3,
        borderLeftColor: publicBoard.project.color,
        backgroundColor: `color-mix(in srgb, ${publicBoard.project.color} 8%, transparent)`,
      }
    : undefined;
  const formattedUpdates: ClientStatusUpdate[] = publicBoard.statusUpdates.map(
    (update) => ({
      id: update.id,
      taskTitle: update.taskTitle,
      summary: update.summary,
      dayKey: getDayKey(update.createdAt),
      dayLabel: formatDayLabel(update.createdAt),
      timeLabel: update.createdAt.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    }),
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-360 flex-col px-4 py-4 sm:px-5 sm:py-5 lg:px-6 lg:py-6">
      <div className="mb-3 flex justify-end">
        <div className="rounded-md border border-border bg-surface p-0.5">
          <ThemeToggle />
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <section className="ui-panel p-5 sm:p-6" style={accentStyle}>
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="max-w-3xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-foreground">
                <StackSimple className="size-4" />
                Client board
              </div>

              <div>
                <h1 className="text-3xl font-medium tracking-tighter text-foreground sm:text-[40px]">
                  {publicBoard.project.name}
                </h1>
                <p className="mt-2 max-w-3xl text-[13px] leading-6 text-muted sm:text-[15px]">
                  {publicBoard.project.summary ||
                    "A simple view of the current kanban board for this project."}
                </p>
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                <span>{formatProjectStatus(publicBoard.project.status)}</span>
                <span>{publicBoard.project.clientName || "Shared"}</span>
                <span>{formatDateLabel(publicBoard.project.deadline)}</span>
              </div>
            </div>

            <div className="ui-panel-soft grid gap-3 px-4 py-3 sm:min-w-60">
              {showBoard ? (
                <>
                  <div>
                    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                      Todo
                    </p>
                    <p className="mt-1 font-mono text-base font-medium text-foreground">
                      {taskCounts.todo}
                    </p>
                  </div>
                  <div>
                    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                      Doing
                    </p>
                    <p className="mt-1 font-mono text-base font-medium text-foreground">
                      {taskCounts.doing}
                    </p>
                  </div>
                </>
              ) : null}
              <div className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                <CalendarDots className="size-3.5" />
                Updated {publicBoard.project.updatedAt.toLocaleDateString()}
              </div>
            </div>
          </div>
        </section>

        {showBoard ? (
          <section className="ui-panel p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                  Board
                </p>
                <h2 className="mt-1 text-[17px] font-medium tracking-[-0.022em] text-foreground">
                  Current project board
                </h2>
                <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
                  Read-only view of the current task flow.
                </p>
              </div>

              <Link href="/sign-in" className="ui-button-secondary">
                Owner sign in
              </Link>
            </div>

            <ClientBoardTasks
              projectId={publicBoard.project.id}
              allowTaskDetail={showDescription}
              tasks={publicBoard.tasks.map((task) => ({
                ...task,
                dueDate: task.dueDate ? task.dueDate.toISOString() : null,
                statusChangedAt:
                  (task.statusChangedAt ?? task.createdAt)?.toISOString() ?? null,
              }))}
            />
          </section>
        ) : null}

        {showCommits ? (
          <section className="ui-panel p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                  Updates
                </p>
                <h2 className="mt-1 text-[17px] font-medium tracking-[-0.022em] text-foreground">
                  Client status log
                </h2>
                <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
                  Published notes from completed tasks, formatted like a clean commit history.
                </p>
              </div>
              <span className="ui-badge">
                {publicBoard.statusUpdates.length} updates
              </span>
            </div>

            <ClientStatusUpdates updates={formattedUpdates} />
          </section>
        ) : null}
      </div>
    </main>
  );
}
