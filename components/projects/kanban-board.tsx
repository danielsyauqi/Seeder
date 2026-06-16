"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  DragEndEvent,
  DragStartEvent,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowSquareOut,
  CalendarDots,
  ChatCircleText,
  DotsSixVertical,
  GitCommit,
  ListChecks,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { useOptionalProjectWorkspaceUi } from "@/components/projects/project-workspace-ui";
import { parseRichText, richTextToPlainText } from "@/lib/rich-text";
import { toast } from "@/lib/toast";
import { cn, withSearchParams } from "@/lib/utils";

const UNTAGGED_PHASE_VALUE = "__untagged__";

type TaskStatus = "todo" | "doing" | "done";
type TaskPriority = "low" | "medium" | "high";

export type BoardTask = {
  id: string;
  title: string;
  description: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  labels?: { id: string; name: string; color: string }[];
  phase: string | null;
  hasStatusUpdate?: boolean;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  requestId: string | null;
  requestCode?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  code?: string | null;
  subtaskTotal?: number;
  subtaskDone?: number;
  commentCount?: number;
};

type KanbanBoardProps = {
  projectId: string;
  tasks: BoardTask[];
  taskHrefBase?: string;
  readOnly?: boolean;
  // When provided (read-only public board), cards become clickable and open a
  // read-only detail view instead of the owner's editable task modal.
  onSelectTask?: (task: BoardTask) => void;
};

type TaskColumns = Record<TaskStatus, BoardTask[]>;

const columnOrder: TaskStatus[] = ["todo", "doing", "done"];

const statusCopy: Record<TaskStatus, { label: string; tone: string }> = {
  todo: {
    label: "Todo",
    tone: "bg-surface text-muted border-border",
  },
  doing: {
    label: "Doing",
    tone: "bg-transparent text-aether-blue border-aether-blue/40 column-doing-pulse",
  },
  done: {
    label: "Done",
    tone: "bg-emerald/10 text-emerald border-emerald/30",
  },
};

// Priority ramp: low recedes (neutral), medium warns (amber), high alerts
// (red). Green is reserved for "done" status, not priority.
const priorityCopy: Record<TaskPriority, string> = {
  low: "border-border bg-surface text-muted",
  medium: "border-amber/40 bg-amber/10 text-amber",
  high: "border-danger/40 bg-danger/10 text-danger",
};

function groupTasks(tasks: BoardTask[]): TaskColumns {
  return {
    todo: tasks.filter((task) => task.status === "todo"),
    doing: tasks.filter((task) => task.status === "doing"),
    done: tasks.filter((task) => task.status === "done"),
  };
}

type PhaseFilter = string | null;

function readPhaseFilter(searchParams: URLSearchParams): PhaseFilter {
  const value = searchParams.get("phase");
  return value && value.length ? value : null;
}

function matchesPhaseFilter(task: BoardTask, filter: PhaseFilter): boolean {
  if (filter === null) return true;
  if (filter === UNTAGGED_PHASE_VALUE) return !task.phase;
  return task.phase === filter;
}

function getPhaseStats(tasks: BoardTask[]) {
  const counts = new Map<string, number>();
  let untagged = 0;
  for (const task of tasks) {
    if (task.phase) {
      counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
    } else {
      untagged += 1;
    }
  }
  const phases = Array.from(counts.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return { phases, untagged, total: tasks.length };
}

function PhaseFilterBar({
  tasks,
  basePath,
  isFiltered,
  filterValue,
  dragDisabled,
}: {
  tasks: BoardTask[];
  basePath: string;
  isFiltered: boolean;
  filterValue: PhaseFilter;
  dragDisabled: boolean;
}) {
  const { phases, untagged } = getPhaseStats(tasks);

  if (phases.length === 0 && untagged === tasks.length) {
    // No phases tagged anywhere — hide the bar entirely
    return null;
  }

  const allHref = withSearchParams(basePath, { phase: null });
  const untaggedHref = withSearchParams(basePath, { phase: UNTAGGED_PHASE_VALUE });

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
        Phase
      </span>
      <FilterChip href={allHref} active={!isFiltered} label="All" count={tasks.length} />
      {phases.map(([phase, count]) => (
        <FilterChip
          key={phase}
          href={withSearchParams(basePath, { phase })}
          active={filterValue === phase}
          label={phase}
          count={count}
        />
      ))}
      {untagged > 0 ? (
        <FilterChip
          href={untaggedHref}
          active={filterValue === UNTAGGED_PHASE_VALUE}
          label="Untagged"
          count={untagged}
          tone="muted"
        />
      ) : null}
      {dragDisabled ? (
        <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
          · drag disabled while filtered
        </span>
      ) : null}
    </div>
  );
}

function FilterChip({
  href,
  active,
  label,
  count,
  tone = "default",
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
  tone?: "default" | "muted";
}) {
  return (
    <Link
      href={href}
      scroll={false}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] transition",
        active
          ? "border-accent/40 bg-accent/10 text-accent"
          : tone === "muted"
            ? "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground"
            : "border-border bg-surface text-foreground hover:border-border-strong hover:bg-surface-strong",
      )}
    >
      {label}
      <span
        className={cn(
          "font-mono text-[11px]",
          active ? "text-accent" : "text-muted",
        )}
      >
        {count}
      </span>
    </Link>
  );
}

function TaskCardSurface({
  task,
  hrefBase,
  onOpen,
  onOpenStatusUpdate,
  dragHandle,
  isDragging = false,
}: {
  task: BoardTask;
  hrefBase?: string;
  onOpen?: (() => void) | null;
  onOpenStatusUpdate?: (() => void) | null;
  dragHandle?: React.ReactNode;
  isDragging?: boolean;
}) {
  // Card body picks up a soft wash of the category color so tasks read like
  // tinted index cards rather than identical rectangles. Done state halves
  // the tint so the column feels muted. Falls back to plain bg-surface when
  // there's no category color.
  const tintBase = task.categoryColor;
  const tintPercent = task.status === "done" ? 5 : 10;
  const cardStyle: React.CSSProperties | undefined = tintBase
    ? {
        backgroundColor: `color-mix(in srgb, ${tintBase} ${tintPercent}%, var(--surface))`,
      }
    : undefined;

  return (
    <article
      className={cn(
        "rounded-md border border-border p-3 shadow-sm transition",
        tintBase ? undefined : "bg-surface",
        isDragging && "border-border-strong",
      )}
      style={cardStyle}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {task.categoryName ? (
              <span className="inline-flex items-center rounded-sm border border-accent/40 bg-accent px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--accent-on)]">
                {task.categoryName}
              </span>
            ) : null}
            {(task.labels ?? []).map((label) => (
              <span
                key={label.id}
                className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-foreground"
                style={{
                  backgroundColor: `${label.color}26`,
                  border: `1px solid ${label.color}66`,
                }}
                title="Label"
              >
                <span
                  aria-hidden
                  className="inline-block size-1.5 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                {label.name}
              </span>
            ))}
            {task.phase ? (
              <span
                className="inline-flex rounded-sm border border-border bg-surface-strong px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted"
                title="Phase"
              >
                {task.phase}
              </span>
            ) : null}
            <span
              className={cn(
                "inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
                priorityCopy[task.priority],
              )}
            >
              {task.priority}
            </span>
          </div>
          {task.code ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted">
              {task.code}
            </p>
          ) : null}
          <h3 className="text-[13px] font-medium leading-snug text-foreground">
            {task.title}
          </h3>
        </div>

        <div className="flex items-center gap-1">
          {dragHandle}
          {onOpenStatusUpdate ? (
            <button
              type="button"
              onClick={() => onOpenStatusUpdate()}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              className={cn(
                "rounded-md border p-1.5 transition",
                task.hasStatusUpdate
                  ? "border-emerald/40 bg-emerald/10 text-emerald"
                  : "border-border bg-background text-muted hover:border-border-strong hover:bg-surface-strong hover:text-foreground",
              )}
            >
              <GitCommit className="size-4" />
              <span className="sr-only">
                {task.hasStatusUpdate ? "Edit client commit" : "Publish client commit"}
              </span>
            </button>
          ) : null}
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen()}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              className="rounded-md border border-border bg-background p-1.5 text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
            >
              <ArrowSquareOut className="size-4" />
              <span className="sr-only">Open task</span>
            </button>
          ) : hrefBase ? (
            <Link
              href={withSearchParams(hrefBase, {
                modal: "task",
                task: task.id,
              })}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              scroll={false}
              className="rounded-md border border-border bg-background p-1.5 text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
            >
              <ArrowSquareOut className="size-4" />
            </Link>
          ) : null}
        </div>
      </div>

      {task.description ? (() => {
        const preview = richTextToPlainText(parseRichText(task.description));
        return preview ? (
          <p className="mt-2.5 line-clamp-3 text-[13px] leading-6 text-muted">
            {preview}
          </p>
        ) : null;
      })() : null}

      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
        <span className="inline-flex flex-wrap items-center gap-2">
          {task.dueDate ? (
            <span className="inline-flex items-center gap-1">
              <CalendarDots className="size-3.5" />
              {new Date(task.dueDate).toLocaleDateString()}
            </span>
          ) : null}
          <span
            className="inline-flex items-center gap-1"
            title="Subtasks done / total"
          >
            <ListChecks className="size-3.5" />
            {task.subtaskDone ?? 0}/{task.subtaskTotal ?? 0}
          </span>
          <span className="inline-flex items-center gap-1" title="Comments">
            <ChatCircleText className="size-3.5" />
            {task.commentCount ?? 0}
          </span>
        </span>
        <span className="text-right">
          {task.requestCode ? `→ ${task.requestCode}` : null}
        </span>
      </div>

      {task.assigneeName ? (
        <div
          className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-muted"
          title={`Assigned to ${task.assigneeName}`}
        >
          <span className="flex size-4 items-center justify-center rounded-full bg-accent-soft text-[9px] text-accent">
            {task.assigneeName
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((p) => p.charAt(0))
              .join("")
              .toUpperCase() || "?"}
          </span>
          {task.assigneeName.split(" ")[0]}
        </div>
      ) : null}
    </article>
  );
}

function SortableTaskCard({
  hrefBase,
  onOpenTask,
  onOpenStatusUpdate,
  task,
}: {
  hrefBase: string;
  onOpenTask?: ((taskId: string) => void) | null;
  onOpenStatusUpdate?: ((taskId: string, taskStatus: TaskStatus) => void) | null;
  task: BoardTask;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: {
      type: "task",
      task,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "transition",
        isDragging && "z-10 opacity-35",
      )}
    >
      <TaskCardSurface
        task={task}
        hrefBase={hrefBase}
        onOpen={onOpenTask ? () => onOpenTask(task.id) : null}
        onOpenStatusUpdate={
          onOpenStatusUpdate && task.status === "done"
            ? () => onOpenStatusUpdate(task.id, task.status)
            : null
        }
        dragHandle={
          <button
            ref={setActivatorNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag ${task.title}`}
            className="touch-none rounded-md border border-border bg-background p-1.5 text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground focus-visible:outline-none"
          >
            <DotsSixVertical className="size-4" />
          </button>
        }
      />
    </div>
  );
}

function SortableTaskColumn({
  status,
  items,
  children,
}: {
  status: TaskStatus;
  items: BoardTask[];
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: status,
  });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "rounded-md border border-border bg-surface/60 px-3 py-3 transition",
        isOver && "border-border-strong bg-surface-strong",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
            statusCopy[status].tone,
          )}
        >
          {statusCopy[status].label}
        </span>
        <span className="font-mono text-[11px] text-muted">{items.length}</span>
      </div>
      <SortableContext
        items={items.map((task) => task.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-3">{children}</div>
      </SortableContext>
    </section>
  );
}

function StaticTaskColumn({
  status,
  items,
  children,
}: {
  status: TaskStatus;
  items: BoardTask[];
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-surface/60 px-3 py-3">
      <div className="mb-3 flex items-center justify-between">
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
            statusCopy[status].tone,
          )}
        >
          {statusCopy[status].label}
        </span>
        <span className="font-mono text-[11px] text-muted">{items.length}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function KanbanBoard({
  projectId,
  tasks,
  taskHrefBase,
  readOnly = false,
  onSelectTask,
}: KanbanBoardProps) {
  const workspaceUi = useOptionalProjectWorkspaceUi();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [columns, setColumns] = useState<TaskColumns>(() => groupTasks(tasks));
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );
  const hrefBase = taskHrefBase ?? `/projects/${projectId}`;
  const searchParamsString = searchParams.toString();
  const filterBasePath = searchParamsString
    ? `${pathname ?? hrefBase}?${searchParamsString}`
    : (pathname ?? hrefBase);
  const phaseFilter = readPhaseFilter(new URLSearchParams(searchParamsString));
  const isFiltered = phaseFilter !== null;

  const flattenedTasks = useMemo(
    () => columnOrder.flatMap((status) => columns[status]),
    [columns],
  );
  const activeTask = activeTaskId ? findTaskById(flattenedTasks, activeTaskId) : null;

  const persistColumns = async (
    nextColumns: TaskColumns,
    previousColumns: TaskColumns,
  ) => {
    try {
      const response = await fetch("/api/tasks/reorder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId,
          columns: {
            todo: nextColumns.todo.map((task) => task.id),
            doing: nextColumns.doing.map((task) => task.id),
            done: nextColumns.done.map((task) => task.id),
          },
        }),
      });
      if (!response.ok) throw new Error("reorder failed");
    } catch {
      // Revert the optimistic move and surface the failure (mirrors the daily
      // planner). The card visibly snapping back IS the success feedback, so a
      // success toast on every drag would just be noise.
      toast("Couldn't save board changes", "danger");
      setColumns(previousColumns);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTaskId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTaskId(null);
    const previousColumns = columns;
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;

    if (!overId || activeId === overId) {
      return;
    }

    const activeTask = findTaskById(flattenedTasks, activeId);
    const overTask = findTaskById(flattenedTasks, overId);

    if (!activeTask) {
      return;
    }

    const sourceStatus = activeTask.status;
    const destinationStatus = overTask?.status ?? (overId as TaskStatus);

    const sourceItems = [...columns[sourceStatus]];
    const activeIndex = sourceItems.findIndex((task) => task.id === activeId);

    if (activeIndex === -1) {
      return;
    }

    const movingTask = sourceItems[activeIndex];

    if (sourceStatus === destinationStatus) {
      const overIndex = overTask
        ? sourceItems.findIndex((task) => task.id === overTask.id)
        : sourceItems.length - 1;

      const nextItems = arrayMove(sourceItems, activeIndex, Math.max(overIndex, 0));
      const nextColumns: TaskColumns = {
        ...columns,
        [sourceStatus]: nextItems,
      };

      setColumns(nextColumns);
      void persistColumns(nextColumns, previousColumns);
      return;
    }

    sourceItems.splice(activeIndex, 1);

    const destinationItems = [...columns[destinationStatus]];
    const nextTask = { ...movingTask, status: destinationStatus };
    const insertIndex = overTask
      ? destinationItems.findIndex((task) => task.id === overTask.id)
      : destinationItems.length;

    destinationItems.splice(Math.max(insertIndex, 0), 0, nextTask);

    const nextColumns: TaskColumns = {
      ...columns,
      [sourceStatus]: sourceItems,
      [destinationStatus]: destinationItems,
    };

    setColumns(nextColumns);
    void persistColumns(nextColumns, previousColumns);
  };

  const handleDragCancel = () => {
    setActiveTaskId(null);
  };

  const filterBar = (
    <PhaseFilterBar
      tasks={tasks}
      basePath={filterBasePath}
      isFiltered={isFiltered}
      filterValue={phaseFilter}
      dragDisabled={!readOnly && isFiltered}
    />
  );

  if (readOnly || isFiltered) {
    const sourceColumns = readOnly ? groupTasks(tasks) : columns;
    const filteredColumns: TaskColumns = {
      todo: sourceColumns.todo.filter((task) => matchesPhaseFilter(task, phaseFilter)),
      doing: sourceColumns.doing.filter((task) => matchesPhaseFilter(task, phaseFilter)),
      done: sourceColumns.done.filter((task) => matchesPhaseFilter(task, phaseFilter)),
    };

    return (
      <div>
        {filterBar}
        <div className="grid gap-4 lg:grid-cols-3">
          {columnOrder.map((status) => {
            const items = filteredColumns[status];

            return (
              <StaticTaskColumn key={status} status={status} items={items}>
                {items.length ? (
                  items.map((task) =>
                    onSelectTask ? (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => onSelectTask(task)}
                        className="block w-full cursor-pointer rounded-md text-left transition hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <TaskCardSurface task={task} />
                      </button>
                    ) : (
                      <TaskCardSurface key={task.id} task={task} />
                    ),
                  )
                ) : (
                  <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] leading-5 text-muted">
                    No tasks here yet
                  </div>
                )}
              </StaticTaskColumn>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      {filterBar}
      <DndContext
        id="kanban-board"
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="grid gap-4 lg:grid-cols-3">
          {columnOrder.map((status) => {
            const items = columns[status];

            return (
              <SortableTaskColumn key={status} status={status} items={items}>
                {items.length ? (
                  items.map((task) => (
                    <SortableTaskCard
                      key={task.id}
                      hrefBase={hrefBase}
                      onOpenTask={workspaceUi?.openTask}
                      onOpenStatusUpdate={workspaceUi?.openStatusUpdate}
                      task={task}
                    />
                  ))
                ) : (
                  <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] leading-5 text-muted">
                    Drop a task here
                  </div>
                )}
              </SortableTaskColumn>
            );
          })}
        </div>
        <DragOverlay
          dropAnimation={{
            duration: 180,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          {activeTask ? <TaskCardSurface task={activeTask} isDragging /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function findTaskById(tasks: BoardTask[], taskId: string | null) {
  if (!taskId) {
    return null;
  }

  return tasks.find((task) => task.id === taskId) ?? null;
}
