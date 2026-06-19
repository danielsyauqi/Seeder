"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
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
  CaretLeft,
  CaretRight,
  DotsSixVertical,
  Kanban,
  Plus,
} from "@phosphor-icons/react";

import {
  DailyItemModal,
  type PlannerItem,
  type PlannerProject,
} from "@/components/daily/daily-item-modal";
import {
  addDays,
  formatDateKey,
  formatDayRangeLabel,
  formatWeekdayShort,
  isToday,
  parseDateKey,
} from "@/lib/daily";
import { toast } from "@/lib/toast";
import { cn, withSearchParams } from "@/lib/utils";

type DailyPlannerProps = {
  anchorKey: string;
  dayKeys: string[];
  items: PlannerItem[];
  projects: PlannerProject[];
};

type ModalState =
  | { mode: "create"; dateKey: string }
  | { mode: "edit"; dateKey: string; item: PlannerItem }
  | null;

const statusTone: Record<PlannerItem["status"], string> = {
  todo: "bg-surface text-muted border-border",
  doing: "bg-transparent text-aether-blue border-aether-blue/40",
  done: "bg-emerald/10 text-emerald border-emerald/30",
};

// Priority ramp: low recedes (neutral), medium warns (amber), high alerts
// (red). Green is reserved for "done" status, not priority.
const priorityTone: Record<PlannerItem["priority"], string> = {
  low: "border-border bg-surface text-muted",
  medium: "border-amber/40 bg-amber/10 text-amber",
  high: "border-danger/40 bg-danger/10 text-danger",
};

function bucketByDate(items: PlannerItem[], dayKeys: string[]) {
  const map: Record<string, PlannerItem[]> = {};
  for (const key of dayKeys) map[key] = [];
  for (const item of items) {
    if (!map[item.dateKey]) map[item.dateKey] = [];
    map[item.dateKey].push(item);
  }
  return map;
}

function CardSurface({
  item,
  dragHandle,
  onEdit,
  isDragging = false,
}: {
  item: PlannerItem;
  dragHandle?: React.ReactNode;
  onEdit?: () => void;
  isDragging?: boolean;
}) {
  // Cards sit on surface-strong so they lift off the recessed day column
  // (bg-surface/60) instead of melting into the background.
  const tint = item.projectColor;
  const cardStyle = tint
    ? { backgroundColor: `color-mix(in srgb, ${tint} 14%, var(--surface-strong))` }
    : undefined;

  return (
    <article
      onClick={onEdit}
      className={cn(
        "rounded-md border border-border p-2.5 shadow-sm transition",
        tint ? undefined : "bg-surface-strong",
        onEdit && "cursor-pointer hover:border-border-strong",
        isDragging && "border-border-strong",
      )}
      style={cardStyle}
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
              priorityTone[item.priority],
            )}
          >
            {item.priority}
          </span>
        </div>
        {dragHandle ? <div className="shrink-0">{dragHandle}</div> : null}
      </div>

      <h3 className="mt-2 text-[13px] font-medium leading-snug text-foreground">
        {item.title}
      </h3>

      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5",
            statusTone[item.status],
          )}
        >
          {item.status}
        </span>
        {item.linkedTaskId ? (
          <a
            href={item.boardHref ?? undefined}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-muted transition hover:border-border-strong hover:text-foreground"
            title="Linked to Execution Board"
          >
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
          </a>
        ) : null}
      </div>
    </article>
  );
}

function SortableCard({
  item,
  onEdit,
}: {
  item: PlannerItem;
  onEdit: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, data: { type: "item", item } });

  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("transition", isDragging && "z-10 opacity-35")}
    >
      <CardSurface
        item={item}
        onEdit={onEdit}
        dragHandle={
          <button
            ref={setActivatorNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Drag ${item.title}`}
            className="touch-none rounded-md border border-border bg-background p-1.5 text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground focus-visible:outline-none"
          >
            <DotsSixVertical className="size-4" />
          </button>
        }
      />
    </div>
  );
}

function DayColumn({
  dateKey,
  day,
  items,
  onAdd,
  onEdit,
}: {
  dateKey: string;
  day: Date;
  items: PlannerItem[];
  onAdd: () => void;
  onEdit: (item: PlannerItem) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: dateKey });
  const today = isToday(day);

  return (
    <section
      ref={setNodeRef}
      aria-label={`${formatWeekdayShort(day)} ${day.getDate()}, ${items.length} items`}
      className={cn(
        "flex max-h-[calc(100dvh-15rem)] w-[85vw] max-w-[300px] shrink-0 flex-col rounded-md border border-border bg-surface/60 px-3 py-3 transition sm:w-[280px] sm:max-w-none",
        isOver && "border-border-strong bg-surface-strong",
      )}
    >
      <div className="mb-3 flex shrink-0 items-center justify-between">
        <span
          className={cn(
            "rounded-sm border px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em]",
            today
              ? "border-aether-blue/40 bg-transparent text-aether-blue column-doing-pulse"
              : "border-border bg-surface text-muted",
          )}
        >
          {formatWeekdayShort(day)} {day.getDate()}
        </span>
        <span className="font-mono text-[11px] text-muted">{items.length}</span>
      </div>

      <SortableContext
        items={items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        {/* Scrolls internally when a day has many items; dnd-kit auto-scrolls
            this container while dragging. */}
        <div className="-mr-1 min-h-[80px] flex-1 space-y-2 overflow-y-auto pr-1">
          {items.length ? (
            items.map((item) => (
              <SortableCard key={item.id} item={item} onEdit={() => onEdit(item)} />
            ))
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] leading-5 text-muted">
              Drop or add an item
            </div>
          )}
        </div>
      </SortableContext>

      <button
        type="button"
        onClick={onAdd}
        className="ui-button-ghost mt-2 w-full shrink-0 justify-center text-[12px]"
      >
        <Plus className="size-3.5" />
        Add
      </button>
    </section>
  );
}

export function DailyPlanner({
  anchorKey,
  dayKeys,
  items,
  projects,
}: DailyPlannerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const anchor = useMemo(() => parseDateKey(anchorKey), [anchorKey]);
  const days = useMemo(() => dayKeys.map((key) => parseDateKey(key)), [dayKeys]);
  const dayKeysSignature = dayKeys.join(",");

  // Local DnD state, re-seeded whenever the server data changes.
  const [columns, setColumns] = useState<Record<string, PlannerItem[]>>(() =>
    bucketByDate(items, dayKeys),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const itemsSignature = useMemo(
    () =>
      items
        .map((item) => `${item.id}:${item.dateKey}:${item.status}:${item.title}`)
        .join("|"),
    [items],
  );

  useEffect(() => {
    setColumns(bucketByDate(items, dayKeys));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsSignature, dayKeysSignature]);

  // Toast once after a server action redirect, then strip the flash param.
  useEffect(() => {
    const flash = searchParams.get("flash");
    if (!flash) return;
    const copy: Record<string, string> = {
      created: "Item added",
      updated: "Item updated",
      removed: "Item removed",
    };
    if (copy[flash]) toast(copy[flash], "success");
    router.replace(
      withSearchParams("/daily", { date: anchorKey, flash: null }),
      { scroll: false },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const flattened = useMemo(
    () => dayKeys.flatMap((key) => columns[key] ?? []),
    [columns, dayKeys],
  );
  const activeItem = activeId
    ? flattened.find((item) => item.id === activeId) ?? null
    : null;

  const persist = async (next: Record<string, PlannerItem[]>) => {
    const days: Record<string, string[]> = {};
    for (const key of dayKeys) days[key] = (next[key] ?? []).map((i) => i.id);
    try {
      const response = await fetch("/api/daily/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      if (!response.ok) throw new Error("reorder failed");
    } catch {
      toast("Could not move item", "danger");
      setColumns(bucketByDate(items, dayKeys));
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const activeIdStr = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId || activeIdStr === overId) return;

    const sourceKey = dayKeys.find((key) =>
      (columns[key] ?? []).some((item) => item.id === activeIdStr),
    );
    if (!sourceKey) return;

    // The drop target is either a day column (key) or another card (its id).
    const overIsColumn = dayKeys.includes(overId);
    const destKey = overIsColumn
      ? overId
      : dayKeys.find((key) =>
          (columns[key] ?? []).some((item) => item.id === overId),
        );
    if (!destKey) return;

    const sourceItems = [...(columns[sourceKey] ?? [])];
    const activeIndex = sourceItems.findIndex((item) => item.id === activeIdStr);
    if (activeIndex === -1) return;

    if (sourceKey === destKey) {
      const overIndex = overIsColumn
        ? sourceItems.length - 1
        : sourceItems.findIndex((item) => item.id === overId);
      const nextItems = arrayMove(sourceItems, activeIndex, Math.max(overIndex, 0));
      const next = { ...columns, [sourceKey]: nextItems };
      setColumns(next);
      void persist(next);
      return;
    }

    const [moving] = sourceItems.splice(activeIndex, 1);
    const movedItem = { ...moving, dateKey: destKey };
    const destItems = [...(columns[destKey] ?? [])];
    const insertIndex = overIsColumn
      ? destItems.length
      : destItems.findIndex((item) => item.id === overId);
    destItems.splice(insertIndex < 0 ? destItems.length : insertIndex, 0, movedItem);

    const next = { ...columns, [sourceKey]: sourceItems, [destKey]: destItems };
    setColumns(next);
    void persist(next);
  };

  const prevKey = formatDateKey(addDays(anchor, -7));
  const nextKey = formatDateKey(addDays(anchor, 7));
  const todayKey = formatDateKey(new Date());

  return (
    <div className="grid gap-6">
      <section className="ui-panel ui-header p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl space-y-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
              Daily ops
            </p>
            <h1 className="text-3xl font-medium tracking-tighter text-foreground sm:text-[40px]">
              Plan your days
            </h1>
            <p className="max-w-2xl text-[13px] leading-6 text-muted sm:text-[15px]">
              Drag items between days to plan ahead. Bind a task to a project
              board, or pull one in to show what you&apos;re working on today.
            </p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <Link
                href={withSearchParams("/daily", { date: prevKey })}
                scroll={false}
                className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
                aria-label="Previous week"
              >
                <CaretLeft className="size-4" />
              </Link>
              <Link
                href={withSearchParams("/daily", { date: todayKey })}
                scroll={false}
                className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-foreground transition hover:border-border-strong hover:bg-surface-strong"
              >
                Today
              </Link>
              <Link
                href={withSearchParams("/daily", { date: nextKey })}
                scroll={false}
                className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
                aria-label="Next week"
              >
                <CaretRight className="size-4" />
              </Link>
              <input
                type="date"
                aria-label="Jump to date"
                value={anchorKey}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value) {
                    router.push(
                      withSearchParams("/daily", { date: value }),
                      { scroll: false },
                    );
                  }
                }}
                className="inline-flex min-h-9 cursor-pointer items-center rounded-md border border-border bg-surface px-2.5 text-[13px] text-foreground transition [color-scheme:dark] hover:border-border-strong hover:bg-surface-strong focus:border-border-strong focus:outline-none"
              />
            </div>
            <p className="font-mono text-[12px] text-muted">
              {formatDayRangeLabel(days)}
            </p>
            <button
              type="button"
              onClick={() => setModal({ mode: "create", dateKey: todayKey })}
              className="ui-button-primary"
            >
              <Plus className="size-4" />
              Add item
            </button>
          </div>
        </div>
      </section>

      <DndContext
        id="daily-planner"
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-2">
          {days.map((day, index) => {
            const key = dayKeys[index];
            return (
              <DayColumn
                key={key}
                dateKey={key}
                day={day}
                items={columns[key] ?? []}
                onAdd={() => setModal({ mode: "create", dateKey: key })}
                onEdit={(item) => setModal({ mode: "edit", dateKey: key, item })}
              />
            );
          })}
        </div>

        <DragOverlay
          dropAnimation={{
            duration: 180,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          {activeItem ? <CardSurface item={activeItem} isDragging /> : null}
        </DragOverlay>
      </DndContext>

      {modal ? (
        <DailyItemModal
          mode={modal.mode}
          dateKey={modal.dateKey}
          projects={projects}
          item={modal.mode === "edit" ? modal.item : undefined}
          onClose={() => setModal(null)}
        />
      ) : null}
    </div>
  );
}
