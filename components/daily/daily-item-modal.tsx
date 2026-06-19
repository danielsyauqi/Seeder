"use client";

import { useEffect, useState } from "react";
import { createPortal, useFormStatus } from "react-dom";
import { CircleNotch, Kanban, Trash, X } from "@phosphor-icons/react";

import {
  createDailyTaskAction,
  deleteDailyTaskAction,
  updateDailyTaskAction,
} from "@/lib/actions";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RichTextField } from "@/components/rich-text/rich-text-field";
import { SearchSelect } from "@/components/ui/search-select";
import type { SearchSelectOption } from "@/components/ui/search-select";
import { formatFriendlyDate, parseDateKey } from "@/lib/daily";
import { cn } from "@/lib/utils";

export type PlannerProject = {
  id: string;
  name: string;
  slug: string | null;
  tasks: { id: string; title: string; status: string; code: string | null }[];
};

export type PlannerItem = {
  id: string;
  title: string;
  description: string | null;
  status: "todo" | "doing" | "done";
  priority: "low" | "medium" | "high";
  kind: "adhoc" | "project";
  projectId: string | null;
  projectName: string | null;
  projectColor: string | null;
  projectCode: string | null;
  linkedTaskId: string | null;
  // The linked board task's custom status name + color (null when unlinked).
  linkedStatus: string | null;
  linkedStatusColor: string | null;
  boardHref: string | null;
  dateKey: string;
};

type ModalProps = {
  mode: "create" | "edit";
  dateKey: string;
  projects: PlannerProject[];
  item?: PlannerItem;
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

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="ui-button-primary mt-2 w-full px-4 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? <CircleNotch className="size-4 animate-spin" /> : null}
      {pending ? pendingLabel : label}
    </button>
  );
}

// Two-button segmented control reusing the header-action button look.
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

export function DailyItemModal({ mode, dateKey, projects, item, onClose }: ModalProps) {
  const isEdit = mode === "edit";

  // Create-only relationship state.
  const [kind, setKind] = useState<"adhoc" | "project">(item?.kind ?? "adhoc");
  const [projectId, setProjectId] = useState<string | undefined>(
    item?.projectId ?? undefined,
  );
  const [projectMode, setProjectMode] = useState<"new" | "existing">("new");
  const [bindToBoard, setBindToBoard] = useState(false);
  const [linkedTaskId, setLinkedTaskId] = useState<string | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const dateForForm = item?.dateKey ?? dateKey;
  const friendlyDate = formatFriendlyDate(parseDateKey(dateForForm));

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

  const action = isEdit ? updateDailyTaskAction : createDailyTaskAction;

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
                Daily ops
              </p>
              <div>
                <h3 className="text-[1.2rem] font-medium tracking-[-0.022em] text-foreground">
                  {isEdit ? "Edit item" : "Add item"}
                </h3>
                <p className="mt-2 text-[13px] leading-6 text-muted">
                  {isEdit
                    ? "Update this planned item. Linked board cards stay independent."
                    : `Plan a task on ${friendlyDate}. Bind it to a project board if it should also live on the Execution Board.`}
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

          <form action={action} className="grid gap-4">
            {isEdit ? (
              <input type="hidden" name="dailyTaskId" value={item!.id} />
            ) : null}

            <label className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Title</span>
              <input
                name="title"
                required
                defaultValue={item?.title ?? ""}
                className="ui-input"
                placeholder="Finalize the Amway slides"
                autoFocus
              />
            </label>

            <div className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Description</span>
              <RichTextField
                name="description"
                defaultValue={item?.description ?? null}
                placeholder="Optional notes or context."
                ariaLabel="Daily item description"
              />
            </div>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Date</span>
              <input
                type="date"
                name="plannedDate"
                defaultValue={dateForForm}
                className="ui-input"
              />
            </label>

            {/* Relationship controls only matter when creating. */}
            {!isEdit ? (
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
                      <span className="text-[12px] font-medium text-muted">
                        Project
                      </span>
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
                                Creates a matching card on this project&apos;s board so
                                the team sees it in the kanban. The two stay independent
                                — completing one won&apos;t change the other.
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
                            <p className="text-[12px] leading-5 text-muted">
                              Shows the board card&apos;s live status here so your
                              executive can see what you&apos;re working on today.
                            </p>
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Status</span>
                <select
                  name="status"
                  defaultValue={item?.status ?? "todo"}
                  className="ui-select"
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Priority</span>
                <select
                  name="priority"
                  defaultValue={item?.priority ?? "medium"}
                  className="ui-select"
                >
                  {PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <SubmitButton
              label={isEdit ? "Save changes" : "Add item"}
              pendingLabel={isEdit ? "Saving…" : "Adding…"}
            />
          </form>

          {isEdit ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="ui-button-danger mt-3 w-full justify-center"
              >
                <Trash className="size-4" />
                Delete item
              </button>
              <ConfirmDialog
                open={confirmingDelete}
                title="Delete this item?"
                description="This removes it from your daily plan. Any linked board card stays on the Execution Board."
                confirmLabel="Delete"
                cancelLabel="Keep"
                variant="danger"
                onCancel={() => setConfirmingDelete(false)}
                onConfirm={() => {
                  const form = document.getElementById(
                    "daily-delete-form",
                  ) as HTMLFormElement | null;
                  form?.requestSubmit();
                }}
              />
              <form
                id="daily-delete-form"
                action={deleteDailyTaskAction}
                className="hidden"
              >
                <input type="hidden" name="dailyTaskId" value={item!.id} />
              </form>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
