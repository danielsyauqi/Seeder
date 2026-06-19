"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useFormStatus } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowSquareOut,
  Check,
  CircleNotch,
  GitCommit,
  Kanban,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";

import {
  convertRequestToTaskAction,
  deleteProjectAction,
  deleteTaskStatusUpdateAction,
  saveTaskStatusUpdateAction,
  updateProjectAction,
} from "@/lib/actions";
import { CategorySelect } from "@/components/projects/category-select";
import { LabelSelect } from "@/components/projects/label-select";
import { CommentThread } from "@/components/projects/comment-thread";
import { RichTextField } from "@/components/rich-text/rich-text-field";
import { RichTextRenderer } from "@/components/rich-text";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select";
import { PROJECT_STATUS_OPTIONS } from "@/lib/project-status";
import { toast } from "@/lib/toast";
import {
  createRequestCommentAction,
  createTaskCommentAction,
  deleteRequestCommentAction,
  deleteTaskCommentAction,
  updateRequestCommentAction,
  updateTaskCommentAction,
} from "@/lib/actions";
import { formatRequestCode, formatTaskCode } from "@/lib/codes";
import type { ProjectWorkspace } from "@/lib/data";
import type { UserRole } from "@/lib/db/schema";
import { CATEGORY_SWATCHES } from "@/lib/swatches";
import { cn, withSearchParams } from "@/lib/utils";

type WorkspaceModalKind =
  | "new-task"
  | "new-checklist-item"
  | "task"
  | "delete-task"
  | "new-request"
  | "request"
  | "delete-project"
  | "project"
  | "status-update";

type WorkspaceModalState =
  | {
      kind: WorkspaceModalKind;
      taskId?: string | null;
      // Whether the task is in a terminal/done status — gates the "publish client
      // update" action (only terminal tasks can be published).
      taskIsTerminal?: boolean | null;
      requestId?: string | null;
    }
  | null;

type ProjectWorkspaceUiContextValue = {
  openModal: (state: NonNullable<WorkspaceModalState>) => void;
  openTask: (taskId: string) => void;
  openRequest: (requestId: string) => void;
  openStatusUpdate: (taskId: string, isTerminal?: boolean | null) => void;
  closeModal: () => void;
};

type WorkspaceChecklistItem = Pick<
  ProjectWorkspace["checklistItems"][number],
  "id" | "taskId" | "content" | "isCompleted" | "sortOrder"
>;

const ProjectWorkspaceUiContext =
  createContext<ProjectWorkspaceUiContextValue | null>(null);

const fieldClassName = "ui-input";
const selectClassName = "ui-select";
const textAreaClassName = "ui-textarea";

function formatDateForInput(value: Date | null) {
  if (!value) {
    return "";
  }

  return value.toISOString().slice(0, 10);
}

function normalizeColorValue(value: string | null) {
  return value ?? "#8a8f98";
}

const STATUS_UPDATE_MAX = 5000;
const STATUS_UPDATE_NEAR_LIMIT = 200;

function StatusUpdateForm({
  projectId,
  taskId,
  returnTo,
  defaultValue,
  isUpdate,
}: {
  projectId: string;
  taskId: string;
  returnTo: string;
  defaultValue: string;
  isUpdate: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  const length = value.length;
  const trimmedLength = value.trim().length;
  const remaining = STATUS_UPDATE_MAX - length;
  const atLimit = length >= STATUS_UPDATE_MAX;
  const overLimit = length > STATUS_UPDATE_MAX; // defensive: only via stale defaultValue
  const isNearLimit = remaining <= STATUS_UPDATE_NEAR_LIMIT && !atLimit;
  const submitDisabled = trimmedLength === 0 || overLimit;

  const counterTone = atLimit
    ? "text-danger"
    : isNearLimit
      ? "text-accent"
      : "text-muted";

  return (
    <form action={saveTaskStatusUpdateAction} className="grid gap-4">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <div className="grid gap-1.5">
        <textarea
          name="summary"
          rows={5}
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={STATUS_UPDATE_MAX}
          className={textAreaClassName}
          placeholder="Describe what changed in a clean client-facing way."
        />
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {atLimit ? (
              <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-danger">
                Character limit reached
              </p>
            ) : isNearLimit ? (
              <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-accent">
                {remaining} characters left
              </p>
            ) : null}
          </div>
          <span
            className={cn(
              "shrink-0 font-mono text-[11px] uppercase tracking-[0.04em]",
              counterTone,
            )}
          >
            {length} / {STATUS_UPDATE_MAX}
          </span>
        </div>
      </div>
      <SubmitButton
        pendingLabel={isUpdate ? "Updating commit..." : "Publishing commit..."}
        disabled={submitDisabled}
      >
        {isUpdate ? "Update commit" : "Publish commit"}
      </SubmitButton>
    </form>
  );
}

function NewTaskForm({
  workspace,
  isPending,
  errorNotice,
  onSubmit,
}: {
  workspace: ProjectWorkspace;
  isPending: boolean;
  errorNotice: React.ReactNode;
  onSubmit: (payload: {
    title: string;
    description: string;
    requestId: string;
    categoryId: string;
    labelIds: string;
    phase: string;
    priority: string;
    dueDate: string;
    assigneeId: string;
  }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [descriptionDefault, setDescriptionDefault] = useState<string>("");
  const [descriptionKey, setDescriptionKey] = useState(0);

  // Show every non-closed request — user may want to spin off a related
  // follow-up task from a request that was already converted.
  const importableRequests = useMemo(
    () =>
      workspace.requests.filter((request) => request.status !== "closed"),
    [workspace.requests],
  );

  const importOptions: SearchSelectOption[] = importableRequests.map(
    (request) => {
      const code = formatRequestCode(workspace.project.slug, request.codeNumber);
      return {
        value: request.id,
        label: code ? `${code} · ${request.title}` : request.title,
        sublabel: request.status,
      };
    },
  );

  function applyRequestImport(nextId: string | undefined) {
    setRequestId(nextId);
    if (!nextId) return;
    const request = importableRequests.find((r) => r.id === nextId);
    if (!request) return;
    setTitle(request.title);
    setDescriptionDefault(request.description ?? "");
    setDescriptionKey((key) => key + 1);
    setPriority(request.priority);
  }

  return (
    <form
      className="grid gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        await onSubmit({
          title: getFormValue(formData, "title"),
          description: getFormValue(formData, "description"),
          requestId: getFormValue(formData, "requestId"),
          categoryId: getFormValue(formData, "categoryId"),
          labelIds: getFormValue(formData, "labelIds"),
          phase: getFormValue(formData, "phase"),
          priority: getFormValue(formData, "priority"),
          dueDate: getFormValue(formData, "dueDate"),
          assigneeId: getFormValue(formData, "assigneeId"),
        });
      }}
    >
      <input type="hidden" name="requestId" value={requestId ?? ""} />

      <label className="grid gap-2">
        <span className="text-sm font-medium text-foreground">Task title</span>
        <input
          name="title"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={fieldClassName}
          placeholder="Ship revised pricing section"
        />
      </label>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="grid content-start gap-2">
          <span className="text-sm font-medium text-foreground">Description</span>
          <RichTextField
            key={descriptionKey}
            name="description"
            defaultValue={descriptionDefault}
            placeholder="Add task context, blockers, or definition of done."
            ariaLabel="Task description"
          />
        </div>

        <aside className="grid content-start gap-4 rounded-md border border-border bg-surface p-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
            Details
          </p>

          {importableRequests.length > 0 ? (
            <div className="grid gap-1.5">
              <span className="text-[12px] font-medium text-foreground">
                Import from request{" "}
                <span className="text-muted">(optional)</span>
              </span>
              <SearchSelect
                options={importOptions}
                value={requestId}
                onChange={applyRequestImport}
                placeholder="Start blank"
                searchPlaceholder="Search request id or title…"
                clearLabel="Start blank"
              />
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Category</span>
            <CategorySelect
              name="categoryId"
              projectId={workspace.project.id}
              categories={workspace.categories}
            />
          </div>

          <div className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Labels</span>
            <LabelSelect
              name="labelIds"
              projectId={workspace.project.id}
              labels={workspace.labels}
              defaultValues={[]}
            />
          </div>

          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">
              Phase <span className="text-muted">(optional)</span>
            </span>
            <input
              name="phase"
              className={fieldClassName}
              placeholder="Discovery / Beta"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Priority</span>
            <select
              name="priority"
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as "low" | "medium" | "high")
              }
              className={selectClassName}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>

          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Due date</span>
            <input type="date" name="dueDate" className={fieldClassName} />
          </label>

          <div className="grid gap-1.5">
            <span className="text-[12px] font-medium text-foreground">Assignee</span>
            <AssigneeSelect name="assigneeId" members={workspace.members} />
          </div>
        </aside>
      </div>

      {errorNotice}

      <ActionButton
        type="submit"
        isPending={isPending}
        pendingLabel="Creating task..."
        className="justify-self-end px-6"
      >
        Create task
      </ActionButton>
    </form>
  );
}

function ConvertRequestButton({
  projectId,
  requestId,
  returnTo,
}: {
  projectId: string;
  requestId: string;
  returnTo: string;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        const formData = new FormData();
        formData.set("projectId", projectId);
        formData.set("requestId", requestId);
        formData.set("returnTo", returnTo);
        startTransition(async () => {
          await convertRequestToTaskAction(formData);
        });
      }}
      className="ui-button-secondary w-full disabled:cursor-not-allowed disabled:opacity-60"
    >
      {isPending ? (
        <CircleNotch className="size-4 animate-spin" />
      ) : (
        <Kanban className="size-4" />
      )}
      {isPending ? "Converting…" : "Convert to task"}
    </button>
  );
}

function AssigneeSelect({
  name,
  defaultValue,
  members,
}: {
  name: string;
  defaultValue?: string | null;
  members: Array<{ userId: string; name: string; email: string }>;
}) {
  const [value, setValue] = useState<string | undefined>(
    defaultValue || undefined,
  );

  const options: SearchSelectOption[] = members.map((member) => ({
    value: member.userId,
    label: member.name,
    sublabel: member.email,
  }));

  return (
    <>
      <input type="hidden" name={name} value={value ?? ""} />
      <SearchSelect
        options={options}
        value={value}
        onChange={setValue}
        placeholder="Unassigned"
        searchPlaceholder="Search by name or email…"
        clearLabel="Unassigned"
      />
    </>
  );
}

function CategoryColorPicker({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue: string;
}) {
  const initial =
    CATEGORY_SWATCHES.find((swatch) => swatch.value.toLowerCase() === defaultValue.toLowerCase())?.value ??
    CATEGORY_SWATCHES[0].value;
  const [color, setColor] = useState(initial);

  return (
    <>
      <input type="hidden" name={name} value={color} />
      <div className="flex flex-wrap gap-1.5">
        {CATEGORY_SWATCHES.map((swatch) => {
          const isSelected = color.toLowerCase() === swatch.value.toLowerCase();
          return (
            <button
              key={swatch.value}
              type="button"
              onClick={() => setColor(swatch.value)}
              aria-label={swatch.label}
              aria-pressed={isSelected}
              className={cn(
                "size-7 rounded-md border transition",
                isSelected
                  ? "border-foreground"
                  : "border-border hover:border-border-strong",
              )}
              style={{ backgroundColor: swatch.value }}
            />
          );
        })}
      </div>
    </>
  );
}

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function buildModalHref(
  currentPath: string,
  modal: WorkspaceModalKind,
  extra?: Record<string, string | null | undefined>,
) {
  return withSearchParams(currentPath, {
    modal,
    ...extra,
  });
}

function parseUrlModalState(
  searchParams: ReturnType<typeof useSearchParams>,
): WorkspaceModalState {
  const modal = searchParams.get("modal");

  if (
    modal !== "new-task" &&
    modal !== "new-checklist-item" &&
    modal !== "task" &&
    modal !== "delete-task" &&
    modal !== "new-request" &&
    modal !== "request" &&
    modal !== "delete-project" &&
    modal !== "project" &&
    modal !== "status-update"
  ) {
    return null;
  }

  return {
    kind: modal,
    taskId: searchParams.get("task"),
    requestId: searchParams.get("request"),
  };
}

function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  className,
  icon,
  disabled,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  const variantClassName =
    variant === "danger"
      ? "ui-button-danger"
      : variant === "secondary"
        ? "ui-button-secondary"
        : "ui-button-primary";

  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={cn(
        variantClassName,
        "w-full disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      {pending ? <CircleNotch className="size-4 animate-spin" /> : icon}
      {pending ? pendingLabel : children}
    </button>
  );
}

function ActionButton({
  children,
  type = "button",
  pendingLabel,
  isPending = false,
  variant = "primary",
  className,
  icon,
  onClick,
}: {
  children: React.ReactNode;
  type?: "button" | "submit";
  pendingLabel: string;
  isPending?: boolean;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  icon?: React.ReactNode;
  onClick?: () => void | Promise<void>;
}) {
  const variantClassName =
    variant === "danger"
      ? "ui-button-danger"
      : variant === "secondary"
        ? "ui-button-secondary"
        : "ui-button-primary";

  return (
    <button
      type={type}
      disabled={isPending}
      onClick={onClick}
      className={cn(
        variantClassName,
        "w-full disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      {isPending ? <CircleNotch className="size-4 animate-spin" /> : icon}
      {isPending ? pendingLabel : children}
    </button>
  );
}

function ModalShell({
  title,
  description,
  children,
  onClose,
  maxWidthClassName = "max-w-2xl",
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onClose: () => void;
  maxWidthClassName?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close modal"
        onClick={onClose}
        className="ui-modal-backdrop absolute inset-0 backdrop-blur-xs"
      />
      <div className="relative flex min-h-full items-end justify-center sm:items-center">
        <div
          className={cn(
            "ui-modal-panel relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-md border border-border bg-surface-strong p-5 shadow-xl sm:max-h-[calc(100dvh-3rem)] sm:p-6",
            maxWidthClassName,
          )}
        >
          <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                Workspace modal
              </p>
              <div>
                <h3 className="text-[20px] font-medium tracking-[-0.022em] text-foreground">
                  {title}
                </h3>
                <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
                  {description}
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
          <div className="min-h-0 overflow-y-auto pr-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

function ProjectWorkspaceModalHost({
  workspace,
  currentPath,
  viewer,
  modalState,
  onClose,
  openModal,
  openTask,
}: {
  workspace: ProjectWorkspace;
  currentPath: string;
  viewer: { id: string; role: UserRole };
  modalState: WorkspaceModalState;
  onClose: () => void;
  openModal: (state: NonNullable<WorkspaceModalState>) => void;
  openTask: (taskId: string) => void;
}) {
  const viewerCanModerate =
    viewer.role === "owner" ||
    viewer.role === "admin" ||
    workspace.project.ownerId === viewer.id;
  const router = useRouter();
  const [, startRefreshTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const selectedTask = modalState?.taskId
    ? workspace.tasks.find((task) => task.id === modalState.taskId) ?? null
    : null;
  const selectedRequest = modalState?.requestId
    ? workspace.requests.find((request) => request.id === modalState.requestId) ??
      null
    : null;
  const linkedTask = selectedRequest
    ? workspace.tasks.find((task) => task.requestId === selectedRequest.id) ?? null
    : null;
  const checklistItemsSeed: WorkspaceChecklistItem[] = selectedTask
    ? workspace.checklistItems
        .filter((item) => item.taskId === selectedTask.id)
        .map((item) => ({
          id: item.id,
          taskId: item.taskId,
          content: item.content,
          isCompleted: item.isCompleted,
          sortOrder: item.sortOrder,
        }))
    : [];
  const checklistItemsSeedKey = checklistItemsSeed
    .map(
      (item) =>
        `${item.id}:${item.content}:${item.isCompleted ? "1" : "0"}:${item.sortOrder}`,
    )
    .join("|");
  const [clientChecklistItems, setClientChecklistItems] = useState(
    checklistItemsSeed,
  );
  const [editingChecklistItemId, setEditingChecklistItemId] = useState<string | null>(null);
  const [editingChecklistContent, setEditingChecklistContent] = useState("");
  const publishedUpdate = selectedTask
    ? workspace.statusUpdates.find((update) => update.taskId === selectedTask.id) ??
      null
    : null;
  const statusUpdateModalPath = selectedTask
    ? buildModalHref(currentPath, "status-update", {
        task: selectedTask.id,
      })
    : currentPath;
  const canCommit =
    (modalState?.taskIsTerminal ?? selectedTask?.isTerminal) === true;
  const errorNotice = mutationError ? (
    <div className="rounded-md border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm leading-6 text-danger">
      {mutationError}
    </div>
  ) : null;

  useEffect(() => {
    setPendingAction(null);
    setMutationError(null);
  }, [modalState?.kind, modalState?.taskId, modalState?.requestId]);

  useEffect(() => {
    setClientChecklistItems(checklistItemsSeed);
    setEditingChecklistItemId(null);
    setEditingChecklistContent("");
  }, [selectedTask?.id, checklistItemsSeedKey]);

  function refreshWorkspace() {
    startRefreshTransition(() => {
      router.refresh();
    });
  }

  async function runWorkspaceMutation(
    actionKey: string,
    payload: Record<string, string | null | undefined>,
    options: { successMessage?: string } = {},
  ) {
    setMutationError(null);
    setPendingAction(actionKey);

    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;

      if (!response.ok) {
        throw new Error(
          typeof result?.error === "string"
            ? result.error
            : "Unable to save workspace changes.",
        );
      }

      if (options.successMessage) {
        toast(options.successMessage, "success");
      }
      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to save workspace changes.";
      setMutationError(message);
      toast(message, "danger");
      return null;
    } finally {
      setPendingAction(null);
    }
  }

  if (!modalState) {
    return null;
  }

  if (modalState.kind === "new-task") {
    return (
      <ModalShell
        onClose={onClose}
        title="Create task"
        description="Add a task without leaving the board-focused workspace."
        maxWidthClassName="max-w-6xl"
      >
        <NewTaskForm
          workspace={workspace}
          isPending={pendingAction === "create-task"}
          errorNotice={errorNotice}
          onSubmit={async (payload) => {
            const result = await runWorkspaceMutation(
              "create-task",
              {
                action: "create-task",
                projectId: workspace.project.id,
                // Create on the branch currently being viewed (not always Main).
                branchId: workspace.currentBranchId ?? undefined,
                ...payload,
              },
              { successMessage: "Task created" },
            );
            if (!result) return false;
            onClose();
            refreshWorkspace();
            return true;
          }}
        />
      </ModalShell>
    );
  }

  if (modalState.kind === "new-checklist-item" && selectedTask) {
    return (
      <ModalShell
        onClose={() =>
          openModal({
            kind: "task",
            taskId: selectedTask.id,
            taskIsTerminal: modalState.taskIsTerminal ?? selectedTask.isTerminal,
          })
        }
        title="Add subtask"
        description="Add one small checklist item for this task."
      >
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();

            const formData = new FormData(event.currentTarget);
            const result = await runWorkspaceMutation(
              "create-checklist-item",
              {
                action: "create-checklist-item",
                projectId: workspace.project.id,
                taskId: selectedTask.id,
                content: getFormValue(formData, "content"),
              },
              { successMessage: "Subtask added" },
            );

            if (!result || !result.item || typeof result.item !== "object") {
              return;
            }

            const nextItem = result.item as {
              id: string;
              taskId: string;
              content: string;
              isCompleted: boolean;
              sortOrder: number;
            };

            setClientChecklistItems((currentItems) =>
              [...currentItems, nextItem].sort(
                (left, right) => left.sortOrder - right.sortOrder,
              ),
            );
            openModal({
              kind: "task",
              taskId: selectedTask.id,
              taskIsTerminal: modalState.taskIsTerminal ?? selectedTask.isTerminal,
            });
            refreshWorkspace();
          }}
        >
          <div className="rounded-md border border-border bg-surface px-4 py-4">
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
              Task
            </p>
            <p className="mt-2 text-sm font-semibold text-foreground">
              {selectedTask.title}
            </p>
          </div>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-foreground">Subtask</span>
            <input
              name="content"
              required
              className={fieldClassName}
              placeholder="Write release note copy"
            />
          </label>

          {errorNotice}

          <ActionButton
            type="submit"
            isPending={pendingAction === "create-checklist-item"}
            pendingLabel="Adding subtask..."
          >
            Add subtask
          </ActionButton>
        </form>
      </ModalShell>
    );
  }

  if (modalState.kind === "task" && selectedTask) {
    const taskCode = formatTaskCode(
      workspace.project.slug,
      selectedTask.codeNumber,
    );
    return (
      <ModalShell
        onClose={onClose}
        title={taskCode ? `Edit task · ${taskCode}` : "Edit task"}
        description="Adjust task details and keep the small execution steps directly under the description."
        maxWidthClassName="max-w-6xl"
      >
        <form
          className="grid gap-5"
          onSubmit={async (event) => {
            event.preventDefault();

            const formData = new FormData(event.currentTarget);
            const result = await runWorkspaceMutation("update-task", {
              action: "update-task",
              taskId: selectedTask.id,
              projectId: workspace.project.id,
              title: getFormValue(formData, "title"),
              description: getFormValue(formData, "description"),
              categoryId: getFormValue(formData, "categoryId"),
              labelIds: getFormValue(formData, "labelIds"),
              phase: getFormValue(formData, "phase"),
              statusId: getFormValue(formData, "statusId"),
              priority: getFormValue(formData, "priority"),
              dueDate: getFormValue(formData, "dueDate"),
              assigneeId: getFormValue(formData, "assigneeId"),
            });

            if (!result) {
              return;
            }

            // Keep the modal open — confirm with a toast so the user knows
            // the save landed without losing their place.
            toast("Task saved", "success");
            refreshWorkspace();
          }}
        >
          <label className="grid gap-2">
            <span className="text-sm font-medium text-foreground">Title</span>
            <input
              name="title"
              required
              defaultValue={selectedTask.title}
              className={fieldClassName}
            />
          </label>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid content-start gap-5">
              <div className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Description</span>
                <RichTextField
                  name="description"
                  defaultValue={selectedTask.description}
                  ariaLabel="Task description"
                />
              </div>

              <div className="grid gap-3 rounded-md border border-border bg-surface px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                Subtasks
              </p>
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted">
                {clientChecklistItems.length
                  ? `${clientChecklistItems.filter((item) => item.isCompleted).length}/${clientChecklistItems.length} done`
                  : "No subtasks yet"}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    openModal({
                      kind: "new-checklist-item",
                      taskId: selectedTask.id,
                      taskIsTerminal: modalState.taskIsTerminal ?? selectedTask.isTerminal,
                    })
                  }
                  className="ui-button-secondary"
                >
                  <Plus className="size-4" />
                  Add
                </button>
              </div>
            </div>

            {clientChecklistItems.length ? (
              <div className="space-y-2">
                {clientChecklistItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5"
                  >
                    <button
                      type="button"
                      disabled={pendingAction === `toggle-checklist-${item.id}`}
                      onClick={async () => {
                        const previousItems = clientChecklistItems;

                        setClientChecklistItems((currentItems) =>
                          currentItems.map((currentItem) =>
                            currentItem.id === item.id
                              ? {
                                  ...currentItem,
                                  isCompleted: !currentItem.isCompleted,
                                }
                              : currentItem,
                          ),
                        );

                        const result = await runWorkspaceMutation(
                          `toggle-checklist-${item.id}`,
                          {
                            action: "toggle-checklist-item",
                            projectId: workspace.project.id,
                            taskId: selectedTask.id,
                            checklistItemId: item.id,
                          },
                        );

                        if (!result) {
                          setClientChecklistItems(previousItems);
                          return;
                        }

                        refreshWorkspace();
                      }}
                      className={cn(
                        "inline-flex size-7 items-center justify-center rounded-sm border transition disabled:cursor-not-allowed disabled:opacity-60",
                        item.isCompleted
                          ? "border-emerald/40 bg-emerald/10 text-emerald"
                          : "border-border bg-background text-muted hover:border-border-strong hover:bg-surface-strong hover:text-foreground",
                      )}
                    >
                      {pendingAction === `toggle-checklist-${item.id}` ? (
                        <CircleNotch className="size-4 animate-spin" />
                      ) : item.isCompleted ? (
                        <Check className="size-4" />
                      ) : (
                        <span className="size-2 rounded-full bg-current" />
                      )}
                      <span className="sr-only">
                        {item.isCompleted ? "Mark incomplete" : "Mark complete"}
                      </span>
                    </button>

                    {editingChecklistItemId === item.id ? (
                      <input
                        autoFocus
                        type="text"
                        value={editingChecklistContent}
                        maxLength={180}
                        disabled={pendingAction === `update-checklist-${item.id}`}
                        onChange={(event) => setEditingChecklistContent(event.target.value)}
                        onBlur={async () => {
                          const trimmed = editingChecklistContent.trim();
                          if (trimmed.length === 0 || trimmed === item.content) {
                            setEditingChecklistItemId(null);
                            setEditingChecklistContent("");
                            return;
                          }

                          const previousItems = clientChecklistItems;
                          setClientChecklistItems((currentItems) =>
                            currentItems.map((currentItem) =>
                              currentItem.id === item.id
                                ? { ...currentItem, content: trimmed }
                                : currentItem,
                            ),
                          );
                          setEditingChecklistItemId(null);
                          setEditingChecklistContent("");

                          const result = await runWorkspaceMutation(
                            `update-checklist-${item.id}`,
                            {
                              action: "update-checklist-item",
                              projectId: workspace.project.id,
                              taskId: selectedTask.id,
                              checklistItemId: item.id,
                              content: trimmed,
                            },
                          );

                          if (!result) {
                            setClientChecklistItems(previousItems);
                            return;
                          }

                          refreshWorkspace();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setEditingChecklistItemId(null);
                            setEditingChecklistContent("");
                          }
                        }}
                        className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-0.5 text-sm leading-6 text-foreground outline-none focus:border-foreground"
                      />
                    ) : (
                      <p
                        onClick={() => {
                          setEditingChecklistItemId(item.id);
                          setEditingChecklistContent(item.content);
                        }}
                        className={cn(
                          "min-w-0 flex-1 cursor-text text-sm leading-6 text-foreground",
                          item.isCompleted && "text-muted line-through",
                        )}
                      >
                        {item.content}
                      </p>
                    )}

                    <button
                      type="button"
                      disabled={pendingAction === `delete-checklist-${item.id}`}
                      onClick={async () => {
                        const previousItems = clientChecklistItems;

                        setClientChecklistItems((currentItems) =>
                          currentItems.filter(
                            (currentItem) => currentItem.id !== item.id,
                          ),
                        );

                        const result = await runWorkspaceMutation(
                          `delete-checklist-${item.id}`,
                          {
                            action: "delete-checklist-item",
                            projectId: workspace.project.id,
                            taskId: selectedTask.id,
                            checklistItemId: item.id,
                          },
                          { successMessage: "Subtask removed" },
                        );

                        if (!result) {
                          setClientChecklistItems(previousItems);
                          return;
                        }

                        refreshWorkspace();
                      }}
                      className="inline-flex size-7 items-center justify-center rounded-sm border border-border bg-background text-muted transition hover:border-danger/30 hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {pendingAction === `delete-checklist-${item.id}` ? (
                        <CircleNotch className="size-4 animate-spin" />
                      ) : (
                        <Trash className="size-4" />
                      )}
                      <span className="sr-only">Delete subtask</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

              </div>
            </div>

            <aside className="grid content-start gap-4 rounded-md border border-border bg-surface p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                Details
              </p>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Status</span>
                <select
                  name="statusId"
                  defaultValue={selectedTask.statusId}
                  className={selectClassName}
                >
                  {workspace.statuses.map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Priority</span>
                <select
                  name="priority"
                  defaultValue={selectedTask.priority}
                  className={selectClassName}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>

              <div className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Assignee</span>
                <AssigneeSelect
                  name="assigneeId"
                  defaultValue={selectedTask.assigneeId}
                  members={workspace.members}
                />
              </div>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Due date</span>
                <input
                  type="date"
                  name="dueDate"
                  defaultValue={formatDateForInput(selectedTask.dueDate)}
                  className={fieldClassName}
                />
              </label>

              <div className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Category</span>
                <CategorySelect
                  name="categoryId"
                  projectId={workspace.project.id}
                  categories={workspace.categories}
                  defaultValue={selectedTask.categoryId}
                />
              </div>

              <div className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Labels</span>
                <LabelSelect
                  name="labelIds"
                  projectId={workspace.project.id}
                  labels={workspace.labels}
                  defaultValues={(selectedTask.labels ?? []).map((l) => l.id)}
                />
              </div>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">
                  Phase <span className="text-muted">(optional)</span>
                </span>
                <input
                  name="phase"
                  defaultValue={selectedTask.phase ?? ""}
                  className={fieldClassName}
                  placeholder="Discovery / Beta"
                />
              </label>

              {selectedTask.requestId ? (() => {
                const sourceRequest = workspace.requests.find(
                  (r) => r.id === selectedTask.requestId,
                );
                if (!sourceRequest) return null;
                const sourceCode = formatRequestCode(
                  workspace.project.slug,
                  sourceRequest.codeNumber,
                );
                return (
                  <div className="border-t border-border pt-4">
                    <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                      Source request
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        openModal({
                          kind: "request",
                          requestId: sourceRequest.id,
                        })
                      }
                      className="ui-button-secondary mt-2 w-full"
                    >
                      <ArrowSquareOut className="size-4" />
                      {sourceCode ?? "Open source request"}
                    </button>
                  </div>
                );
              })() : null}
            </aside>
          </div>

          {errorNotice}

          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_280px]">
            <ActionButton
              type="submit"
              isPending={pendingAction === "update-task"}
              pendingLabel="Saving task..."
              className="w-full"
            >
              Save task
            </ActionButton>
            <button
              type="button"
              onClick={() =>
                openModal({
                  kind: "delete-task",
                  taskId: selectedTask.id,
                  taskIsTerminal: modalState.taskIsTerminal ?? selectedTask.isTerminal,
                })
              }
              className="ui-button-danger w-full"
            >
              <Trash className="size-4" />
              Delete task
            </button>
          </div>
        </form>

        <div className="mt-6 border-t border-border pt-5">
          <CommentThread
            comments={workspace.taskComments
              .filter((c) => c.taskId === selectedTask.id)
              .map((c) => ({
                id: c.id,
                content: c.content,
                authorId: c.authorId,
                authorName: c.authorName,
                authorImage: c.authorImage,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
              }))}
            projectId={workspace.project.id}
            parentId={selectedTask.id}
            viewerId={viewer.id}
            viewerCanModerate={viewerCanModerate}
            actions={{
              create: createTaskCommentAction,
              update: updateTaskCommentAction,
              remove: deleteTaskCommentAction,
            }}
          />
        </div>
      </ModalShell>
    );
  }

  if (modalState.kind === "delete-task" && selectedTask) {
    return (
      <ModalShell
        onClose={() =>
          openModal({
            kind: "task",
            taskId: selectedTask.id,
            taskIsTerminal: modalState.taskIsTerminal ?? selectedTask.isTerminal,
          })
        }
        title="Delete task"
        description="This removes the task and its subtasks. Use this only when the task should disappear completely."
      >
        <div className="grid gap-4">
          <div className="ui-panel-danger px-4 py-4 text-sm leading-6 text-muted">
            You are deleting{" "}
            <span className="font-semibold text-foreground">{selectedTask.title}</span>.
            This cannot be undone.
          </div>

          {errorNotice}

          <ActionButton
            isPending={pendingAction === "delete-task"}
            pendingLabel="Deleting task..."
            variant="danger"
            onClick={async () => {
              const result = await runWorkspaceMutation(
                "delete-task",
                {
                  action: "delete-task",
                  taskId: selectedTask.id,
                  projectId: workspace.project.id,
                },
                { successMessage: "Task deleted" },
              );

              if (!result) {
                return;
              }

              onClose();
              refreshWorkspace();
            }}
          >
              Delete task
          </ActionButton>
        </div>
      </ModalShell>
    );
  }

  if (modalState.kind === "status-update" && selectedTask) {
    return (
      <ModalShell
        onClose={onClose}
        title="Commit client update"
        description="Write a short client-facing update for this completed task."
      >
        {canCommit ? (
          <div className="grid gap-4">
            <div className="rounded-md border border-border bg-surface px-4 py-4">
              <div className="flex items-start gap-3">
                <span className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-background text-accent">
                  <GitCommit className="size-5" />
                </span>
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                    Done task
                  </p>
                  <h4 className="mt-2 text-base font-semibold text-foreground">
                    {selectedTask.title}
                  </h4>
                </div>
              </div>
            </div>

            <StatusUpdateForm
              projectId={workspace.project.id}
              taskId={selectedTask.id}
              returnTo={statusUpdateModalPath}
              defaultValue={publishedUpdate?.summary ?? ""}
              isUpdate={Boolean(publishedUpdate)}
            />

            {publishedUpdate ? (
              <form action={deleteTaskStatusUpdateAction}>
                <input
                  type="hidden"
                  name="projectId"
                  value={workspace.project.id}
                />
                <input type="hidden" name="taskId" value={selectedTask.id} />
                <input type="hidden" name="returnTo" value={statusUpdateModalPath} />
                <SubmitButton pendingLabel="Removing commit..." variant="danger">
                  Remove commit
                </SubmitButton>
              </form>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-background px-4 py-5 text-sm leading-6 text-muted">
            Only tasks in the <span className="font-semibold text-foreground">Done</span> column can be committed to the client log.
          </div>
        )}
      </ModalShell>
    );
  }

  if (modalState.kind === "new-request") {
    return (
      <ModalShell
        onClose={onClose}
        title="Capture request"
        description="Keep incoming asks in the inbox first, then convert them into execution work when ready."
        maxWidthClassName="max-w-6xl"
      >
        <form
          className="grid gap-5"
          onSubmit={async (event) => {
            event.preventDefault();

            const formData = new FormData(event.currentTarget);
            const result = await runWorkspaceMutation(
              "create-request",
              {
                action: "create-request",
                projectId: workspace.project.id,
                // Capture on the branch currently being viewed (not always Main).
                branchId: workspace.currentBranchId ?? undefined,
                title: getFormValue(formData, "title"),
                description: getFormValue(formData, "description"),
                priority: getFormValue(formData, "priority"),
              },
              { successMessage: "Request captured" },
            );

            if (!result) {
              return;
            }

            onClose();
            refreshWorkspace();
          }}
        >
          <label className="grid gap-2">
            <span className="text-sm font-medium text-foreground">Request title</span>
            <input
              name="title"
              required
              className={fieldClassName}
              placeholder="Homepage CTA needs revision"
            />
          </label>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid content-start gap-2">
              <span className="text-sm font-medium text-foreground">Context</span>
              <RichTextField
                name="description"
                placeholder="Capture the ask, constraints, and expected change."
                ariaLabel="Request context"
              />
            </div>

            <aside className="grid content-start gap-4 rounded-md border border-border bg-surface p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                Details
              </p>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Priority</span>
                <select
                  name="priority"
                  defaultValue="medium"
                  className={selectClassName}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
            </aside>
          </div>

          {errorNotice}

          <ActionButton
            type="submit"
            isPending={pendingAction === "create-request"}
            pendingLabel="Saving request..."
            className="justify-self-end px-6"
          >
            Save request
          </ActionButton>
        </form>
      </ModalShell>
    );
  }

  if (modalState.kind === "request" && selectedRequest) {
    const requestCode = formatRequestCode(
      workspace.project.slug,
      selectedRequest.codeNumber,
    );
    return (
      <ModalShell
        onClose={onClose}
        title={requestCode ? `Review request · ${requestCode}` : "Review request"}
        description="Edit the request, then convert it into a task when the work is ready to move onto the board."
        maxWidthClassName="max-w-6xl"
      >
        <form
          className="grid gap-5"
          onSubmit={async (event) => {
            event.preventDefault();

            const formData = new FormData(event.currentTarget);
            const result = await runWorkspaceMutation(
              "update-request",
              {
                action: "update-request",
                requestId: selectedRequest.id,
                projectId: workspace.project.id,
                title: getFormValue(formData, "title"),
                description: getFormValue(formData, "description"),
                status: getFormValue(formData, "status"),
                priority: getFormValue(formData, "priority"),
              },
              { successMessage: "Request saved" },
            );

            if (!result) {
              return;
            }

            onClose();
            refreshWorkspace();
          }}
        >
          <label className="grid gap-2">
            <span className="text-sm font-medium text-foreground">Title</span>
            <input
              name="title"
              required
              defaultValue={selectedRequest.title}
              className={fieldClassName}
            />
          </label>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="grid content-start gap-2">
              <span className="text-sm font-medium text-foreground">Description</span>
              <RichTextField
                name="description"
                defaultValue={selectedRequest.description}
                ariaLabel="Request description"
              />
            </div>

            <aside className="grid content-start gap-4 rounded-md border border-border bg-surface p-4">
              <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                Details
              </p>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Status</span>
                <select
                  name="status"
                  defaultValue={selectedRequest.status}
                  className={selectClassName}
                >
                  <option value="new">New</option>
                  <option value="reviewed">Reviewed</option>
                  <option value="converted">Converted</option>
                  <option value="closed">Closed</option>
                </select>
              </label>

              <label className="grid gap-1.5">
                <span className="text-[12px] font-medium text-foreground">Priority</span>
                <select
                  name="priority"
                  defaultValue={selectedRequest.priority}
                  className={selectClassName}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>

              <div className="border-t border-border pt-4">
                {linkedTask ? (() => {
                  const linkedTaskCode = formatTaskCode(
                    workspace.project.slug,
                    linkedTask.codeNumber,
                  );
                  return (
                    <>
                      <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                        Linked task
                      </p>
                      <button
                        type="button"
                        onClick={() => openTask(linkedTask.id)}
                        className="ui-button-secondary mt-2 w-full"
                      >
                        <ArrowSquareOut className="size-4" />
                        {linkedTaskCode ?? "Open linked task"}
                      </button>
                    </>
                  );
                })() : selectedRequest.status === "converted" ? (
                  // Already converted, but its task isn't on this branch (moved
                  // to another branch). Never re-offer Convert — that would imply
                  // it's unconverted; point to where the task lives instead.
                  <>
                    <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                      Linked task
                    </p>
                    <p className="mt-2 text-[13px] leading-6 text-muted">
                      Converted — the linked task lives on another branch. Switch
                      to that branch to open it.
                    </p>
                  </>
                ) : (
                  <ConvertRequestButton
                    projectId={workspace.project.id}
                    requestId={selectedRequest.id}
                    returnTo={currentPath}
                  />
                )}
              </div>
            </aside>
          </div>

          {errorNotice}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <ActionButton
              isPending={pendingAction === "delete-request"}
              pendingLabel="Deleting request..."
              variant="danger"
              className="px-4"
              onClick={async () => {
                const result = await runWorkspaceMutation(
                  "delete-request",
                  {
                    action: "delete-request",
                    requestId: selectedRequest.id,
                    projectId: workspace.project.id,
                  },
                  { successMessage: "Request deleted" },
                );

                if (!result) {
                  return;
                }

                onClose();
                refreshWorkspace();
              }}
            >
              Delete request
            </ActionButton>
            <ActionButton
              type="submit"
              isPending={pendingAction === "update-request"}
              pendingLabel="Saving request..."
              className="px-6"
            >
              Save request
            </ActionButton>
          </div>
        </form>

        <div className="mt-6 border-t border-border pt-5">
          <CommentThread
            comments={workspace.requestComments
              .filter((c) => c.requestId === selectedRequest.id)
              .map((c) => ({
                id: c.id,
                content: c.content,
                authorId: c.authorId,
                authorName: c.authorName,
                authorImage: c.authorImage,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
              }))}
            projectId={workspace.project.id}
            parentId={selectedRequest.id}
            viewerId={viewer.id}
            viewerCanModerate={viewerCanModerate}
            actions={{
              create: createRequestCommentAction,
              update: updateRequestCommentAction,
              remove: deleteRequestCommentAction,
            }}
          />
        </div>
      </ModalShell>
    );
  }

  if (modalState.kind === "delete-project") {
    return (
      <ModalShell
        onClose={onClose}
        title="Delete workspace"
        description="This removes the project, requests, tasks, notes, and activity log. This action cannot be undone."
      >
        <div className="grid gap-4">
          <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-4 text-sm leading-7 text-muted">
            You are deleting{" "}
            <span className="font-semibold text-foreground">
              {workspace.project.name}
            </span>
            . If you still need the record, archive it instead.
          </div>

          <form action={deleteProjectAction}>
            <input type="hidden" name="projectId" value={workspace.project.id} />
            <SubmitButton pendingLabel="Deleting workspace..." variant="danger">
              Delete workspace
            </SubmitButton>
          </form>
        </div>
      </ModalShell>
    );
  }

  if (modalState.kind === "project") {
    return (
      <ModalShell
        onClose={onClose}
        title="Edit project"
        description="Update the core project metadata without turning the workspace itself into a long settings form."
      >
        <form action={updateProjectAction} className="grid gap-4">
          <input type="hidden" name="projectId" value={workspace.project.id} />
          <input type="hidden" name="returnTo" value={currentPath} />

          <label className="grid gap-2">
            <span className="text-sm font-medium text-foreground">Project name</span>
            <input
              name="name"
              required
              defaultValue={workspace.project.name}
              className={fieldClassName}
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-foreground">Client</span>
            <input
              name="clientName"
              defaultValue={workspace.project.clientName ?? ""}
              className={fieldClassName}
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-foreground">Summary</span>
            <textarea
              name="summary"
              defaultValue={workspace.project.summary ?? ""}
              rows={4}
              className={textAreaClassName}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Status</span>
              <select
                name="status"
                defaultValue={workspace.project.status}
                className={selectClassName}
              >
                {PROJECT_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-foreground">Deadline</span>
              <input
                type="date"
                name="deadline"
                defaultValue={formatDateForInput(workspace.project.deadline)}
                className={fieldClassName}
              />
            </label>
          </div>

          <SubmitButton pendingLabel="Saving project..." className="mt-2">
            Save project
          </SubmitButton>
        </form>
      </ModalShell>
    );
  }

  return null;
}

export function ProjectWorkspaceClientShell({
  workspace,
  currentPath,
  viewer,
  children,
}: {
  workspace: ProjectWorkspace;
  currentPath: string;
  viewer: { id: string; role: UserRole };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [modalState, setModalState] = useState<WorkspaceModalState>(null);

  // Sync the modal from the URL ONLY when the URL's modal params actually change
  // (deep links, back/forward nav) — keyed on a stable signature. Depending on
  // the raw searchParams object would re-run this on every unrelated re-render,
  // including a server action's revalidatePath() (which changes useSearchParams'
  // identity without changing the params) and would force-close a client-opened
  // modal — e.g. creating a task category from inside the open task modal.
  const urlModalSignature = [
    searchParams.get("modal") ?? "",
    searchParams.get("task") ?? "",
    searchParams.get("request") ?? "",
  ].join("|");
  const lastUrlModalSignature = useRef<string | null>(null);

  useEffect(() => {
    if (lastUrlModalSignature.current === urlModalSignature) return;
    lastUrlModalSignature.current = urlModalSignature;
    setModalState(parseUrlModalState(searchParams));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlModalSignature]);

  const value = useMemo<ProjectWorkspaceUiContextValue>(() => {
    return {
      openModal: (state) => {
        setModalState(state);
      },
      openTask: (taskId) => {
        setModalState({
          kind: "task",
          taskId,
        });
      },
      openRequest: (requestId) => {
        setModalState({
          kind: "request",
          requestId,
        });
      },
      openStatusUpdate: (taskId, isTerminal) => {
        setModalState({
          kind: "status-update",
          taskId,
          taskIsTerminal: isTerminal ?? null,
        });
      },
      closeModal: () => {
        setModalState(null);

        if (searchParams.get("modal")) {
          router.replace(currentPath, { scroll: false });
        }
      },
    };
  }, [currentPath, router, searchParams]);

  return (
    <ProjectWorkspaceUiContext.Provider value={value}>
      {children}
      <ProjectWorkspaceModalHost
        workspace={workspace}
        currentPath={currentPath}
        viewer={viewer}
        modalState={modalState}
        onClose={value.closeModal}
        openModal={value.openModal}
        openTask={value.openTask}
      />
    </ProjectWorkspaceUiContext.Provider>
  );
}

export function useOptionalProjectWorkspaceUi() {
  return useContext(ProjectWorkspaceUiContext);
}

export function ProjectWorkspaceModalTrigger({
  modal,
  taskId,
  requestId,
  children,
  className,
  style,
}: {
  modal: WorkspaceModalKind;
  taskId?: string;
  requestId?: string;
  children: React.ReactNode;
  className: string;
  style?: React.CSSProperties;
}) {
  const context = useContext(ProjectWorkspaceUiContext);

  if (!context) {
    return null;
  }

  return (
    <button
      type="button"
      style={style}
      onClick={() =>
        context.openModal({
          kind: modal,
          taskId,
          requestId,
        })
      }
      className={className}
    >
      {children}
    </button>
  );
}
