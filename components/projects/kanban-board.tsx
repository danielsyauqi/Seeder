"use client";

import Link from "next/link";
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
  Clock,
  DotsSixVertical,
  GitCommit,
  ListChecks,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";

import { useOptionalProjectWorkspaceUi } from "@/components/projects/project-workspace-ui";
import { SearchSelect } from "@/components/ui/search-select";
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
  // ISO timestamp of when the task last entered its current status column.
  statusChangedAt?: string | null;
  subtaskTotal?: number;
  subtaskDone?: number;
  commentCount?: number;
};

const statusLabel: Record<TaskStatus, string> = {
  todo: "todo",
  doing: "doing",
  done: "done",
};

// Compact "entered this column on" date for the line above a card's title.
function formatEnteredLabel(iso: string | null | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return {
    short: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    full: date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  };
}

type KanbanBoardProps = {
  projectId: string;
  tasks: BoardTask[];
  taskHrefBase?: string;
  readOnly?: boolean;
  // When provided (read-only public board), cards become clickable and open a
  // read-only detail view instead of the owner's editable task modal.
  onSelectTask?: (task: BoardTask) => void;
  // Render the search box + filter dropdowns above the board.
  showFilters?: boolean;
  // Cap the board to the top N cards (by board order) until "Show more" is used
  // or a filter narrows the set. Drag is disabled while previewing.
  previewLimit?: number;
  // When set, "Show more" navigates here (e.g. overview → board) instead of
  // expanding the preview in place.
  showMoreHref?: string;
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

// ---------------------------------------------------------------------------
// Board search + filters (client-side, real-time). Replaces the old URL-driven
// phase chips: phase is now one searchable dropdown alongside category, due
// date, label, priority, and assignee. Any active search/filter switches the
// board into a static (non-draggable) view, same as the legacy phase filter.
// ---------------------------------------------------------------------------

const NONE_VALUE = "__none__";

type DueBucket = "overdue" | "today" | "week" | "has" | "none";

const DUE_BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due this week",
  has: "Has a due date",
  none: "No due date",
};

export type BoardFilterState = {
  search: string;
  phase?: string;
  category?: string;
  priority?: string;
  label?: string;
  assignee?: string;
  due?: string;
};

const EMPTY_FILTERS: BoardFilterState = { search: "" };

function hasActiveFilters(filters: BoardFilterState): boolean {
  return Boolean(
    filters.search.trim() ||
      filters.phase ||
      filters.category ||
      filters.priority ||
      filters.label ||
      filters.assignee ||
      filters.due,
  );
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Highlight every search token inside a string, returning React nodes. Mirrors
// the command bar's highlighter so matches read the same across the app.
function highlightMatches(text: string, tokens: string[]): React.ReactNode {
  if (!tokens.length || !text) return text;
  const pattern = new RegExp(`(${tokens.map(escapeRegex).join("|")})`, "gi");
  const parts = text.split(pattern);
  return parts.map((part, index) => {
    const isMatch =
      part.length > 0 &&
      tokens.some((token) => part.toLowerCase() === token.toLowerCase());
    if (!isMatch) return part;
    return (
      <mark
        key={index}
        className="rounded-[3px] bg-yellow-300/40 px-0.5 text-inherit"
      >
        {part}
      </mark>
    );
  });
}

const startOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

function dueBucketOf(task: BoardTask): DueBucket {
  if (!task.dueDate) return "none";
  const due = new Date(task.dueDate).getTime();
  const today = startOfToday();
  const tomorrow = today + 86_400_000;
  if (task.status !== "done" && due < today) return "overdue";
  if (due >= today && due < tomorrow) return "today";
  if (due >= today && due < today + 7 * 86_400_000) return "week";
  return "has";
}

function taskSearchHaystack(task: BoardTask): string {
  const entered = task.statusChangedAt ? new Date(task.statusChangedAt) : null;
  const due = task.dueDate ? new Date(task.dueDate) : null;
  return [
    task.title,
    task.code ?? "",
    task.phase ?? "",
    task.categoryName ?? "",
    richTextToPlainText(parseRichText(task.description)),
    due ? due.toLocaleDateString() : "",
    entered ? entered.toLocaleDateString() : "",
    entered
      ? entered.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "",
  ]
    .join("  ")
    .toLowerCase();
}

function taskMatchesFilters(
  task: BoardTask,
  filters: BoardFilterState,
  tokens: string[],
): boolean {
  if (tokens.length) {
    const hay = taskSearchHaystack(task);
    if (!tokens.every((token) => hay.includes(token))) return false;
  }
  if (filters.phase) {
    if (filters.phase === UNTAGGED_PHASE_VALUE) {
      if (task.phase) return false;
    } else if (task.phase !== filters.phase) {
      return false;
    }
  }
  if (filters.category) {
    if (filters.category === NONE_VALUE) {
      if (task.categoryName) return false;
    } else if (task.categoryName !== filters.category) {
      return false;
    }
  }
  if (filters.priority && task.priority !== filters.priority) return false;
  if (filters.label) {
    const labels = task.labels ?? [];
    if (filters.label === NONE_VALUE) {
      if (labels.length) return false;
    } else if (!labels.some((label) => label.id === filters.label)) {
      return false;
    }
  }
  if (filters.assignee) {
    if (filters.assignee === NONE_VALUE) {
      if (task.assigneeId) return false;
    } else if (task.assigneeId !== filters.assignee) {
      return false;
    }
  }
  if (filters.due && dueBucketOf(task) !== filters.due) return false;
  return true;
}

type FilterOption = { value: string; label: string; sublabel?: string };

// A dropdown is only worth showing when it offers a real choice — not just a
// lone "No category"/"Unassigned"/"Untagged" sentinel (which happens on the
// public board, whose data omits assignees and labels entirely).
function hasRealOptions(options: FilterOption[]): boolean {
  return options.some(
    (option) =>
      option.value !== NONE_VALUE && option.value !== UNTAGGED_PHASE_VALUE,
  );
}

// Derive the option lists for each filter dropdown from the current task set,
// each with a count, so a dimension with no values simply renders no options.
function buildFilterOptions(tasks: BoardTask[]) {
  const phase = new Map<string, number>();
  let untaggedPhase = 0;
  const category = new Map<string, number>();
  let noCategory = 0;
  const priority = new Map<string, number>();
  const label = new Map<string, { name: string; count: number }>();
  let noLabel = 0;
  const assignee = new Map<string, { name: string; count: number }>();
  let unassigned = 0;
  const due = new Map<DueBucket, number>();

  for (const task of tasks) {
    if (task.phase) phase.set(task.phase, (phase.get(task.phase) ?? 0) + 1);
    else untaggedPhase += 1;

    if (task.categoryName)
      category.set(task.categoryName, (category.get(task.categoryName) ?? 0) + 1);
    else noCategory += 1;

    priority.set(task.priority, (priority.get(task.priority) ?? 0) + 1);

    const labels = task.labels ?? [];
    if (labels.length) {
      for (const l of labels) {
        const prev = label.get(l.id);
        label.set(l.id, { name: l.name, count: (prev?.count ?? 0) + 1 });
      }
    } else {
      noLabel += 1;
    }

    if (task.assigneeId && task.assigneeName) {
      // Only offer assignees that resolve to a current project member. A task
      // assigned to someone since removed (no resolved name) isn't a useful
      // filter and would otherwise show up as a duplicate "Assigned" row.
      const prev = assignee.get(task.assigneeId);
      assignee.set(task.assigneeId, {
        name: task.assigneeName,
        count: (prev?.count ?? 0) + 1,
      });
    } else if (!task.assigneeId) {
      unassigned += 1;
    }

    const bucket = dueBucketOf(task);
    due.set(bucket, (due.get(bucket) ?? 0) + 1);
  }

  const count = (n: number) => `${n}`;

  const phaseOptions: FilterOption[] = [
    ...Array.from(phase.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, n]) => ({ value, label: value, sublabel: count(n) })),
  ];
  if (untaggedPhase)
    phaseOptions.push({
      value: UNTAGGED_PHASE_VALUE,
      label: "Untagged",
      sublabel: count(untaggedPhase),
    });

  const categoryOptions: FilterOption[] = [
    ...Array.from(category.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, n]) => ({ value, label: value, sublabel: count(n) })),
  ];
  if (noCategory)
    categoryOptions.push({
      value: NONE_VALUE,
      label: "No category",
      sublabel: count(noCategory),
    });

  const priorityOrder: TaskPriority[] = ["high", "medium", "low"];
  const priorityOptions: FilterOption[] = priorityOrder
    .filter((p) => priority.has(p))
    .map((p) => ({
      value: p,
      label: p.charAt(0).toUpperCase() + p.slice(1),
      sublabel: count(priority.get(p) ?? 0),
    }));

  const labelOptions: FilterOption[] = [
    ...Array.from(label.entries())
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([value, info]) => ({
        value,
        label: info.name,
        sublabel: count(info.count),
      })),
  ];
  if (noLabel)
    labelOptions.push({
      value: NONE_VALUE,
      label: "No label",
      sublabel: count(noLabel),
    });

  const assigneeOptions: FilterOption[] = [
    ...Array.from(assignee.entries())
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([value, info]) => ({
        value,
        label: info.name,
        sublabel: count(info.count),
      })),
  ];
  if (unassigned)
    assigneeOptions.push({
      value: NONE_VALUE,
      label: "Unassigned",
      sublabel: count(unassigned),
    });

  const dueOrder: DueBucket[] = ["overdue", "today", "week", "has", "none"];
  const dueOptions: FilterOption[] = dueOrder
    .filter((b) => due.has(b))
    .map((b) => ({
      value: b,
      label: DUE_BUCKET_LABEL[b],
      sublabel: count(due.get(b) ?? 0),
    }));

  return {
    phase: phaseOptions,
    category: categoryOptions,
    priority: priorityOptions,
    label: labelOptions,
    assignee: assigneeOptions,
    due: dueOptions,
  };
}

function BoardFilters({
  filters,
  onChange,
  options,
  resultCount,
  totalCount,
}: {
  filters: BoardFilterState;
  onChange: (next: BoardFilterState) => void;
  options: ReturnType<typeof buildFilterOptions>;
  resultCount: number;
  totalCount: number;
}) {
  const set = (patch: Partial<BoardFilterState>) =>
    onChange({ ...filters, ...patch });
  const active = hasActiveFilters(filters);

  return (
    <div className="mb-4 space-y-2">
      <div className="relative">
        <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={filters.search}
          onChange={(event) => set({ search: event.target.value })}
          placeholder="Search tasks by title, date, or description…"
          aria-label="Search tasks"
          className="w-full rounded-md border border-border bg-background py-2.5 pl-9 pr-3 text-[13px] text-foreground outline-none transition placeholder:text-muted focus:border-accent"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {hasRealOptions(options.phase) ? (
          <SearchSelect
            className="w-40"
            options={options.phase}
            value={filters.phase}
            onChange={(value) => set({ phase: value })}
            placeholder="Phase"
            searchPlaceholder="Search phases…"
            clearLabel="All phases"
          />
        ) : null}
        {hasRealOptions(options.category) ? (
          <SearchSelect
            className="w-40"
            options={options.category}
            value={filters.category}
            onChange={(value) => set({ category: value })}
            placeholder="Category"
            searchPlaceholder="Search categories…"
            clearLabel="All categories"
          />
        ) : null}
        {hasRealOptions(options.due) ? (
          <SearchSelect
            className="w-40"
            options={options.due}
            value={filters.due}
            onChange={(value) => set({ due: value })}
            placeholder="Due date"
            searchPlaceholder="Search due…"
            clearLabel="Any due date"
          />
        ) : null}
        {hasRealOptions(options.label) ? (
          <SearchSelect
            className="w-40"
            options={options.label}
            value={filters.label}
            onChange={(value) => set({ label: value })}
            placeholder="Label"
            searchPlaceholder="Search labels…"
            clearLabel="All labels"
          />
        ) : null}
        {hasRealOptions(options.priority) ? (
          <SearchSelect
            className="w-44"
            options={options.priority}
            value={filters.priority}
            onChange={(value) => set({ priority: value })}
            placeholder="Priority"
            searchPlaceholder="Search priority…"
            clearLabel="All priorities"
          />
        ) : null}
        {hasRealOptions(options.assignee) ? (
          <SearchSelect
            className="w-44"
            options={options.assignee}
            value={filters.assignee}
            onChange={(value) => set({ assignee: value })}
            placeholder="Assignee"
            searchPlaceholder="Search assignees…"
            clearLabel="Anyone"
          />
        ) : null}
        {active ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] font-medium text-muted transition hover:border-border-strong hover:text-foreground"
          >
            <X className="size-3.5" />
            Clear
          </button>
        ) : null}
        {active ? (
          <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
            {resultCount} of {totalCount}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TaskCardSurface({
  task,
  hrefBase,
  onOpen,
  onOpenStatusUpdate,
  dragHandle,
  isDragging = false,
  highlightTokens,
}: {
  task: BoardTask;
  hrefBase?: string;
  onOpen?: (() => void) | null;
  onOpenStatusUpdate?: (() => void) | null;
  dragHandle?: React.ReactNode;
  isDragging?: boolean;
  highlightTokens?: string[];
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
          {(() => {
            const entered = formatEnteredLabel(task.statusChangedAt);
            if (!entered) return null;
            return (
              <p
                className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted"
                title={`In ${statusLabel[task.status]} since ${entered.full}`}
              >
                <Clock className="size-3" />
                Since {entered.short}
              </p>
            );
          })()}
          <h3 className="text-[13px] font-medium leading-snug text-foreground">
            {highlightTokens?.length
              ? highlightMatches(task.title, highlightTokens)
              : task.title}
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
  showFilters = false,
  previewLimit,
  showMoreHref,
}: KanbanBoardProps) {
  const workspaceUi = useOptionalProjectWorkspaceUi();
  const [columns, setColumns] = useState<TaskColumns>(() => groupTasks(tasks));
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [filters, setFilters] = useState<BoardFilterState>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
  );
  const hrefBase = taskHrefBase ?? `/projects/${projectId}`;
  const filterOptions = useMemo(() => buildFilterOptions(tasks), [tasks]);
  const tokens = useMemo(() => searchTokens(filters.search), [filters.search]);
  const isFiltered = hasActiveFilters(filters);

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

  // Live source columns: the owner board reflects the optimistic drag state;
  // the read-only public board groups straight from the prop.
  const sourceColumns = readOnly ? groupTasks(tasks) : columns;

  const matchedColumns: TaskColumns = {
    todo: sourceColumns.todo.filter((task) =>
      taskMatchesFilters(task, filters, tokens),
    ),
    doing: sourceColumns.doing.filter((task) =>
      taskMatchesFilters(task, filters, tokens),
    ),
    done: sourceColumns.done.filter((task) =>
      taskMatchesFilters(task, filters, tokens),
    ),
  };
  const resultCount =
    matchedColumns.todo.length +
    matchedColumns.doing.length +
    matchedColumns.done.length;

  // Preview cap: only when a previewLimit is set, nothing is filtered, and the
  // user hasn't expanded. Keep the first N cards in board order (todo → doing →
  // done, each already sorted) but leave them grouped in their columns.
  const previewing = previewLimit != null && !isFiltered && !expanded;
  let displayColumns = matchedColumns;
  let hiddenCount = 0;
  if (previewing && previewLimit != null) {
    const flat = columnOrder.flatMap((status) => matchedColumns[status]);
    hiddenCount = Math.max(0, flat.length - previewLimit);
    const keep = new Set(flat.slice(0, previewLimit).map((task) => task.id));
    displayColumns = {
      todo: matchedColumns.todo.filter((task) => keep.has(task.id)),
      doing: matchedColumns.doing.filter((task) => keep.has(task.id)),
      done: matchedColumns.done.filter((task) => keep.has(task.id)),
    };
  }

  // Drag is only live on the full, owner-owned, unfiltered, non-preview board.
  const canDrag = !readOnly && !isFiltered && previewLimit == null;

  const filterBar = showFilters ? (
    <BoardFilters
      filters={filters}
      onChange={(next) => {
        setFilters(next);
        setExpanded(false);
      }}
      options={filterOptions}
      resultCount={resultCount}
      totalCount={tasks.length}
    />
  ) : null;

  const showMore =
    previewing && hiddenCount > 0 ? (
      <div className="mt-4 flex justify-center">
        {showMoreHref ? (
          <Link href={showMoreHref} className="ui-button-secondary">
            Show more ({hiddenCount} more)
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="ui-button-secondary"
          >
            Show more ({hiddenCount} more)
          </button>
        )}
      </div>
    ) : null;

  if (!canDrag) {
    return (
      <div>
        {filterBar}
        <div className="grid gap-4 lg:grid-cols-3">
          {columnOrder.map((status) => {
            const items = displayColumns[status];

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
                        <TaskCardSurface task={task} highlightTokens={tokens} />
                      </button>
                    ) : (
                      <TaskCardSurface
                        key={task.id}
                        task={task}
                        highlightTokens={tokens}
                      />
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
        {showMore}
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
