"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal, useFormStatus } from "react-dom";
import { CircleNotch, Kanban, MagnifyingGlass, X } from "@phosphor-icons/react";

import { adminCreateDailyTaskForUsersAction } from "@/lib/actions";
import { Avatar } from "@/components/ui/avatar";
import { RichTextField } from "@/components/rich-text/rich-text-field";
import { SearchSelect } from "@/components/ui/search-select";
import type { SearchSelectOption } from "@/components/ui/search-select";
import type { PlannerProject } from "@/components/daily/daily-item-modal";
import { formatFriendlyDate, parseDateKey } from "@/lib/daily";
import { cn } from "@/lib/utils";

export type AssignUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

type AssignModalProps = {
  dateKey: string;
  users: AssignUser[];
  projects: PlannerProject[];
  preselectUserId?: string;
  onClose: () => void;
};

const STATUS_OPTIONS = [
  { value: "todo", label: "Todo" },
  { value: "doing", label: "Doing" },
  { value: "done", label: "Done" },
];

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-8 rounded-sm px-3 text-[13px] font-medium transition",
            value === option.value
              ? "bg-surface-strong text-foreground"
              : "text-muted hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SubmitButton({ count, total }: { count: number; total: number }) {
  const { pending } = useFormStatus();
  const label =
    count === total && total > 0
      ? `Assign to everyone (${total})`
      : `Assign to ${count} ${count === 1 ? "person" : "people"}`;
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="ui-button-primary mt-2 w-full px-4 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? <CircleNotch className="size-4 animate-spin" /> : null}
      {pending ? "Assigning…" : label}
    </button>
  );
}

export function AssignItemModal({
  dateKey,
  users,
  projects,
  preselectUserId,
  onClose,
}: AssignModalProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselectUserId ? [preselectUserId] : []),
  );
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<"adhoc" | "project">("adhoc");
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [projectMode, setProjectMode] = useState<"new" | "existing">("new");
  const [bindToBoard, setBindToBoard] = useState(false);
  const [linkedTaskId, setLinkedTaskId] = useState<string | undefined>(undefined);

  const allSelected = selected.size === users.length && users.length > 0;
  const friendlyDate = formatFriendlyDate(parseDateKey(dateKey));

  const selectedUsers = users.filter((u) => selected.has(u.id));
  const normalizedQuery = query.trim().toLowerCase();

  // Combobox: results appear only while typing, and already-picked people are
  // excluded (they live as chips above). No standing list of users is shown.
  const MAX_VISIBLE = 8;
  const matches = normalizedQuery
    ? users.filter(
        (u) =>
          !selected.has(u.id) &&
          (u.name.toLowerCase().includes(normalizedQuery) ||
            u.email.toLowerCase().includes(normalizedQuery)),
      )
    : [];
  const visibleMatches = matches.slice(0, MAX_VISIBLE);
  const hiddenCount = matches.length - visibleMatches.length;

  // Close the results dropdown when clicking outside the picker.
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  const pickUser = (id: string) => {
    toggleUser(id);
    setQuery("");
    setPickerOpen(true);
  };

  const projectOptions: SearchSelectOption[] = projects.map((project) => ({
    value: project.id,
    label: project.name,
    sublabel: project.slug ?? undefined,
  }));
  const selectedProject = projects.find((project) => project.id === projectId);
  const taskOptions: SearchSelectOption[] = (selectedProject?.tasks ?? []).map(
    (task) => ({
      value: task.id,
      label: task.title,
      sublabel: task.code ?? undefined,
    }),
  );

  const toggleUser = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleEveryone = () =>
    setSelected((prev) =>
      prev.size === users.length ? new Set() : new Set(users.map((u) => u.id)),
    );

  const userIdsJson = useMemo(
    () => JSON.stringify(Array.from(selected)),
    [selected],
  );

  // Portal to <body> so scoped CSS variables from an ancestor (e.g. a
  // .ui-header banner) can't cascade into the modal and wash out its tokens.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe portal: render null on the server, then portal after client mount to avoid a hydration mismatch.
    setMounted(true);
  }, []);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close modal"
        onClick={onClose}
        className="ui-modal-backdrop absolute inset-0 bg-[rgba(10,10,10,0.44)] backdrop-blur-xs"
      />
      <div className="relative flex min-h-full items-end justify-center sm:items-center">
        <div className="ui-modal-panel relative max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-md border border-border bg-surface-strong p-5 shadow-xl sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                Admin · daily ops
              </p>
              <div>
                <h3 className="text-[1.2rem] font-medium tracking-[-0.022em] text-foreground">
                  Assign item
                </h3>
                <p className="mt-2 text-[13px] leading-6 text-muted">
                  Plan work for one or many people on {friendlyDate}.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
            >
              <X className="size-4" />
              <span className="sr-only">Close modal</span>
            </button>
          </div>

          <form action={adminCreateDailyTaskForUsersAction} className="grid gap-4">
            <input
              type="hidden"
              name="target"
              value={allSelected ? "all" : "selective"}
            />
            <input type="hidden" name="userIds" value={userIdsJson} />

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">Assign to</span>
                <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleEveryone}
                    className="size-4 accent-[var(--accent)]"
                  />
                  Everyone ({users.length})
                </label>
              </div>

              {/* Selected people as removable chips. */}
              <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-md border border-border bg-background p-2">
                {selectedUsers.length === 0 ? (
                  <span className="px-1 text-[12px] text-muted">
                    No one selected yet — search to add people.
                  </span>
                ) : (
                  selectedUsers.map((u) => (
                    <span
                      key={u.id}
                      className="inline-flex items-center gap-1 rounded-sm border border-accent/30 bg-accent-soft py-0.5 pl-2 pr-1 text-[12px] font-medium text-accent"
                    >
                      {u.name}
                      <button
                        type="button"
                        onClick={() => toggleUser(u.id)}
                        aria-label={`Remove ${u.name}`}
                        className="inline-flex size-4 items-center justify-center rounded-sm transition hover:bg-accent/20"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))
                )}
              </div>

              {/* Type to search; results appear as a dropdown, pick one to add
                  it as a chip. No standing list of users is shown. */}
              <div className="relative" ref={pickerRef}>
                <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPickerOpen(true);
                  }}
                  onFocus={() => setPickerOpen(true)}
                  // Enter must never reach the surrounding assign form, which
                  // would submit it before anyone had been picked. Swallow it
                  // and add the top match instead.
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setPickerOpen(false);
                      return;
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const top = visibleMatches[0];
                    if (top) {
                      toggleUser(top.id);
                      setQuery("");
                    }
                  }}
                  placeholder="Search people to add…"
                  aria-label="Search people to assign"
                  autoComplete="off"
                  className="ui-input"
                  style={{ paddingLeft: 32 }}
                />
                {pickerOpen ? (
                  <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-surface-strong shadow-xl">
                    {!normalizedQuery ? (
                      <p className="px-3 py-3 text-center text-[12px] text-muted">
                        Type a name or email to find people.
                      </p>
                    ) : visibleMatches.length === 0 ? (
                      <p className="px-3 py-3 text-center text-[12px] text-muted">
                        No more people match.
                      </p>
                    ) : (
                      <>
                        {visibleMatches.map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => pickUser(u.id)}
                            className="flex w-full items-center gap-2.5 border-b border-border px-3 py-2 text-left transition last:border-b-0 hover:bg-surface"
                          >
                            <Avatar
                              name={u.name}
                              email={u.email}
                              image={u.image}
                              px={28}
                              className="size-7 bg-surface text-[10px]"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] text-foreground">
                                {u.name}
                              </span>
                              <span className="block truncate font-mono text-[11px] text-muted">
                                {u.email}
                              </span>
                            </span>
                          </button>
                        ))}
                        {hiddenCount > 0 ? (
                          <p className="px-3 py-2 text-center font-mono text-[11px] text-muted">
                            +{hiddenCount} more — keep typing to narrow.
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              <p className="font-mono text-[11px] text-muted">
                Selected: {selected.size} of {users.length}
              </p>
            </div>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Title</span>
              <input
                name="title"
                required
                className="ui-input"
                placeholder="Company town hall at 3pm"
                autoFocus
              />
            </label>

            <div className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Description</span>
              <RichTextField
                name="description"
                placeholder="Optional notes or context."
                ariaLabel="Assigned item description"
              />
            </div>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Date</span>
              <input
                type="date"
                name="plannedDate"
                defaultValue={dateKey}
                className="ui-input"
              />
            </label>

            <div className="grid gap-3 rounded-md border border-border bg-surface/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-foreground">Type</span>
                <Segmented
                  options={[
                    { value: "adhoc", label: "Adhoc" },
                    { value: "project", label: "Project" },
                  ]}
                  value={kind}
                  onChange={(value) => setKind(value as "adhoc" | "project")}
                />
              </div>
              <input type="hidden" name="kind" value={kind} />

              {kind === "project" ? (
                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <span className="text-[12px] font-medium text-muted">Project</span>
                    <input type="hidden" name="projectId" value={projectId ?? ""} />
                    <SearchSelect
                      options={projectOptions}
                      value={projectId}
                      onChange={(value) => {
                        setProjectId(value);
                        setLinkedTaskId(undefined);
                      }}
                      placeholder="Select a project"
                      searchPlaceholder="Search by project name…"
                    />
                  </div>

                  {projectId ? (
                    <>
                      <Segmented
                        options={[
                          { value: "new", label: "Create new" },
                          { value: "existing", label: "Link existing" },
                        ]}
                        value={projectMode}
                        onChange={(value) =>
                          setProjectMode(value as "new" | "existing")
                        }
                      />
                      {projectMode === "new" ? (
                        <label className="flex items-start gap-2.5 rounded-md border border-border bg-background p-3">
                          <input
                            type="checkbox"
                            name="bindToBoard"
                            value="true"
                            checked={bindToBoard}
                            onChange={(event) => setBindToBoard(event.target.checked)}
                            className="mt-0.5 size-4 accent-[var(--accent)]"
                          />
                          <span className="grid gap-1">
                            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                              <Kanban className="size-4 text-accent" />
                              Add to Execution Board
                            </span>
                            <span className="text-[12px] leading-5 text-muted">
                              Creates a board card for each person, assigned to them.
                            </span>
                          </span>
                        </label>
                      ) : (
                        <div className="grid gap-2">
                          <span className="text-[12px] font-medium text-muted">
                            Board task to reference
                          </span>
                          <input
                            type="hidden"
                            name="linkedTaskId"
                            value={linkedTaskId ?? ""}
                          />
                          <SearchSelect
                            options={taskOptions}
                            value={linkedTaskId}
                            onChange={setLinkedTaskId}
                            placeholder={
                              taskOptions.length
                                ? "Pick an open board task"
                                : "No open tasks in this project"
                            }
                            searchPlaceholder="Search tasks…"
                          />
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Status</span>
                <select name="status" defaultValue="todo" className="ui-select">
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Priority</span>
                <select name="priority" defaultValue="medium" className="ui-select">
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <SubmitButton count={selected.size} total={users.length} />
          </form>
        </div>
      </div>
    </div>,
    document.body,
  );
}
