"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import {
  CaretDown,
  Check,
  CircleNotch,
  MagnifyingGlass,
  Plus,
  X,
} from "@phosphor-icons/react";

import { createTaskCategoryAction } from "@/lib/actions";
import { PROJECT_SWATCHES } from "@/lib/swatches";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export type CategoryOption = {
  id: string;
  name: string;
  color: string;
};

type Props = {
  name: string;
  projectId: string;
  categories: CategoryOption[];
  defaultValue?: string | null;
};

export function CategorySelect({
  name,
  projectId,
  categories,
  defaultValue,
}: Props) {
  const [value, setValue] = useState<string | undefined>(
    defaultValue ?? undefined,
  );
  const [localCategories, setLocalCategories] = useState(categories);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [newColor, setNewColor] = useState(PROJECT_SWATCHES[0].value);
  const [isPending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return localCategories;
    return localCategories.filter((cat) => cat.name.toLowerCase().includes(q));
  }, [localCategories, query]);

  const selected = localCategories.find((cat) => cat.id === value);

  const trimmedQuery = query.trim();
  const exactMatch = localCategories.some(
    (cat) => cat.name.toLowerCase() === trimmedQuery.toLowerCase(),
  );
  const canCreate = trimmedQuery.length > 0 && !exactMatch;

  function close() {
    setOpen(false);
    setQuery("");
    setIsCreating(false);
  }

  function selectCategory(id: string | undefined) {
    setValue(id);
    close();
  }

  function startCreate() {
    setIsCreating(true);
  }

  function submitCreate() {
    if (!trimmedQuery) return;
    const formData = new FormData();
    formData.set("projectId", projectId);
    formData.set("name", trimmedQuery);
    formData.set("color", newColor);
    startTransition(async () => {
      try {
        const result = await createTaskCategoryAction(formData);
        const next: CategoryOption = {
          id: result.id,
          name: result.name,
          color: result.color,
        };
        setLocalCategories((current) =>
          [...current, next].sort((a, b) => a.name.localeCompare(b.name)),
        );
        setValue(next.id);
        toast(`Created category "${next.name}"`, "success");
        close();
      } catch (error: unknown) {
        toast(
          error instanceof Error ? error.message : "Could not create category",
          "danger",
        );
      }
    });
  }

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={value ?? ""} />

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ui-input flex w-full items-center justify-between gap-2"
      >
        {selected ? (
          <span className="inline-flex items-center gap-1.5 truncate">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full"
              style={{ backgroundColor: selected.color }}
            />
            <span className="truncate">{selected.name}</span>
          </span>
        ) : (
          <span className="text-muted">No category</span>
        )}
        <CaretDown className="size-4 text-muted" />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 grid gap-2 rounded-md border border-border bg-surface-strong p-2 shadow-md">
          {!isCreating ? (
            <>
              <div className="relative">
                <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <input
                  autoFocus
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  // This box lives inside the task form, so Enter would
                  // otherwise implicitly submit the task instead of acting on
                  // the dropdown. Always swallow it: pick the top match, or
                  // fall through to creating what was typed.
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const top = filtered[0];
                    if (top) {
                      selectCategory(top.id);
                    } else if (canCreate) {
                      startCreate();
                    }
                  }}
                  placeholder="Search or type to create…"
                  className="ui-input"
                  style={{ paddingLeft: 32 }}
                />
              </div>

              <ul className="max-h-56 overflow-y-auto">
                <li>
                  <button
                    type="button"
                    onClick={() => selectCategory(undefined)}
                    className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-[13px] text-muted hover:bg-surface"
                  >
                    <span>No category</span>
                    {!value ? <Check className="size-4" /> : null}
                  </button>
                </li>
                {filtered.map((cat) => (
                  <li key={cat.id}>
                    <button
                      type="button"
                      onClick={() => selectCategory(cat.id)}
                      className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-surface"
                    >
                      <span className="inline-flex items-center gap-2">
                        <span
                          aria-hidden
                          className="inline-block size-2.5 rounded-full"
                          style={{ backgroundColor: cat.color }}
                        />
                        {cat.name}
                      </span>
                      {value === cat.id ? <Check className="size-4" /> : null}
                    </button>
                  </li>
                ))}
                {filtered.length === 0 && !canCreate ? (
                  <li className="px-2 py-2 text-[12px] text-muted">
                    No categories. Type a name to create one.
                  </li>
                ) : null}
              </ul>

              {canCreate ? (
                <button
                  type="button"
                  onClick={startCreate}
                  className="ui-button-secondary justify-start text-left"
                >
                  <Plus className="size-4" />
                  Create &quot;{trimmedQuery}&quot;
                </button>
              ) : null}
            </>
          ) : (
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                  New category
                </span>
                <button
                  type="button"
                  onClick={() => setIsCreating(false)}
                  className="inline-flex size-6 items-center justify-center rounded-sm text-muted hover:bg-surface hover:text-foreground"
                  aria-label="Back"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="rounded-sm border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground">
                {trimmedQuery}
              </div>
              <div className="flex flex-wrap gap-1">
                {PROJECT_SWATCHES.map((swatch) => {
                  const isSelected =
                    swatch.value.toLowerCase() === newColor.toLowerCase();
                  return (
                    <button
                      key={swatch.value}
                      type="button"
                      onClick={() => setNewColor(swatch.value)}
                      aria-label={swatch.label}
                      aria-pressed={isSelected}
                      className={cn(
                        "size-6 rounded-md border transition",
                        isSelected
                          ? "border-foreground"
                          : "border-border hover:border-border-strong",
                      )}
                      style={{ backgroundColor: swatch.value }}
                    />
                  );
                })}
              </div>
              {/* Focused on entry so Enter confirms the create. It can't be a
                  nested <form>/submit — this dropdown renders inside the task
                  form, and Enter there would save the task instead. */}
              <button
                autoFocus
                type="button"
                onClick={submitCreate}
                disabled={isPending}
                className="ui-button-primary"
              >
                {isPending ? <CircleNotch className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {isPending ? "Creating…" : "Create category"}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
