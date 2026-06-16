// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Builds the Seeder MCP server for a given authenticated token. Pure (no
// request/transport concerns — the route owns those). Read tools are always
// registered; write tools ONLY when the token's scope is "readwrite", so a
// read token never even sees them in tools/list. Write tools call the shared
// lib/services/* functions, so an MCP mutation runs the exact same validation,
// authz, and activity logging as the web app.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Viewer } from "@/lib/auth-server";
import type { TokenAuth } from "@/lib/auth-token";
import { requestStatusValues, taskStatusValues } from "@/lib/db/schema";
import {
  createTaskCategory,
  createTaskCategoryInputSchema,
  deleteTaskCategory,
  deleteTaskCategoryInputSchema,
  listTaskCategories,
  listTaskCategoriesInputSchema,
  updateTaskCategory,
  updateTaskCategoryInputSchema,
} from "@/lib/services/categories";
import {
  createChecklistItem,
  createChecklistItemInputSchema,
  deleteChecklistItem,
  deleteChecklistItemInputSchema,
  toggleChecklistItem,
  toggleChecklistItemInputSchema,
  updateChecklistItem,
  updateChecklistItemInputSchema,
} from "@/lib/services/checklist";
import {
  addProjectMember,
  addProjectMemberInputSchema,
  createInvite,
  createInviteInputSchema,
  listInvites,
  listProjectMembers,
  listProjectMembersInputSchema,
  removeProjectMember,
  removeProjectMemberInputSchema,
  revokeInvite,
  revokeInviteInputSchema,
} from "@/lib/services/members";
import {
  archiveProject,
  createProject,
  createProjectInputSchema,
  deleteProject,
  duplicateProject,
  projectIdInputSchema,
  restoreProject,
  rotateClientShareToken,
  setClientShare,
  setClientShareInputSchema,
  setProjectColor,
  setProjectColorInputSchema,
  setProjectSlug,
  setProjectSlugInputSchema,
  updateProject,
  updateProjectInputSchema,
} from "@/lib/services/projects";
import {
  addRequestCommentInputSchema,
  addTaskCommentInputSchema,
  createRequestComment,
  createTaskComment,
  deleteRequestComment,
  deleteRequestCommentInputSchema,
  deleteTaskComment,
  deleteTaskCommentInputSchema,
  listRequestComments,
  listRequestCommentsInputSchema,
  listTaskComments,
  listTaskCommentsInputSchema,
} from "@/lib/services/comments";
import {
  addTaskLabelInputSchema,
  addTaskLabels,
  createTaskLabel,
  createTaskLabelInputSchema,
  deleteTaskLabel,
  deleteTaskLabelInputSchema,
  listTaskLabels,
  listTaskLabelsInputSchema,
  removeTaskLabelInputSchema,
  removeTaskLabels,
  updateTaskLabel,
  updateTaskLabelInputSchema,
} from "@/lib/services/labels";
import {
  createProjectNote,
  createProjectNoteInputSchema,
} from "@/lib/services/notes";
import {
  deleteStatusUpdate,
  deleteStatusUpdateInputSchema,
  publishStatusUpdate,
  publishStatusUpdateInputSchema,
} from "@/lib/services/status-updates";
import {
  listDailyTasks,
  listProjectActivity,
  listProjects,
  listRequests,
  listStatusUpdates,
  listTasks,
  readProject,
  listProjectNotes,
  readRequest,
  readTask,
  search,
} from "@/lib/services/reads";
import {
  createRequest,
  createRequestInputSchema,
  deleteRequest,
  deleteRequestInputSchema,
  updateRequest,
  updateRequestInputSchema,
} from "@/lib/services/requests";
import {
  createTask,
  createTaskInputSchema,
  deleteTask,
  deleteTaskInputSchema,
  setTaskCategory,
  setTaskCategoryInputSchema,
  updateTask,
  updateTaskInputSchema,
  updateTaskStatus,
  updateTaskStatusInputSchema,
} from "@/lib/services/tasks";
import { PROJECT_SWATCHES } from "@/lib/swatches";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Service functions throw plain Errors ("Project not found.", etc.); surface
// them as MCP tool errors rather than letting them 500 the transport.
async function runWrite(fn: () => Promise<unknown>) {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "Operation failed.",
        },
      ],
    };
  }
}

export function buildServer({ viewer, scope }: TokenAuth): McpServer {
  const server = new McpServer({ name: "seeder", version: "0.1.0" });

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Return the authenticated Seeder user and this token's scope.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      jsonResult({
        id: viewer.id,
        name: viewer.name,
        email: viewer.email,
        role: viewer.role,
        scope,
      }),
  );

  registerReadTools(server, viewer);
  if (scope === "readwrite") registerWriteTools(server, viewer);

  return server;
}

function registerReadTools(server: McpServer, viewer: Viewer) {
  server.registerTool(
    "list-projects",
    {
      title: "List projects",
      description:
        "List the projects you can access (owned or member). Read-only.",
      inputSchema: {
        includeArchived: z.boolean().optional(),
        onlyArchived: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listProjects(viewer, args)),
  );

  server.registerTool(
    "read-project",
    {
      title: "Read project",
      description:
        "Read one project's full record by id — name, client, summary, status, deadline, color, slug, archived, client-board state. Read this BEFORE update-project (a full replace) or set-project-color so you don't clobber fields. Returns null if it doesn't exist or you can't access it. Read-only.",
      inputSchema: { projectId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await readProject(viewer, args)),
  );

  server.registerTool(
    "list-tasks",
    {
      title: "List tasks",
      description:
        "List tasks in projects you can access. Filter by projectId, status (todo/doing/done), or assignedToMe. Capped at 100 — use filters to narrow. Read-only.",
      inputSchema: {
        projectId: z.string().optional(),
        status: z.enum(taskStatusValues).optional(),
        assignedToMe: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listTasks(viewer, args)),
  );

  server.registerTool(
    "read-task",
    {
      title: "Read task",
      description:
        "Read one task (with its subtasks) by id. Returns null if it doesn't exist or you can't access it. Read-only.",
      inputSchema: { projectId: z.string(), taskId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await readTask(viewer, args)),
  );

  server.registerTool(
    "list-task-categories",
    {
      title: "List task categories",
      description:
        "List a project's task categories (id, name, color, and how many tasks use each). Use this to find a categoryId before assigning one with create-task / update-task. Returns [] if you can't access the project. Read-only.",
      inputSchema: listTaskCategoriesInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listTaskCategories(viewer, args)),
  );

  server.registerTool(
    "list-task-labels",
    {
      title: "List task labels",
      description:
        "List a project's task labels (id, name, color, and how many tasks use each). Use this to find label ids before tagging tasks with add-task-label. Returns [] if you can't access the project. Read-only.",
      inputSchema: listTaskLabelsInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listTaskLabels(viewer, args)),
  );

  server.registerTool(
    "list-requests",
    {
      title: "List requests",
      description:
        "List client requests in projects you can access. Filter by projectId or status. Read-only.",
      inputSchema: {
        projectId: z.string().optional(),
        status: z.enum(requestStatusValues).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listRequests(viewer, args)),
  );

  server.registerTool(
    "read-request",
    {
      title: "Read request",
      description:
        "Read one client request by id. Returns null if it doesn't exist or you can't access it. Read-only.",
      inputSchema: { projectId: z.string(), requestId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await readRequest(viewer, args)),
  );

  server.registerTool(
    "list-task-comments",
    {
      title: "List task comments",
      description:
        "List the comment thread on a task (author, text, timestamps), oldest first. Returns [] if you can't access the project. Read-only.",
      inputSchema: listTaskCommentsInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listTaskComments(viewer, args)),
  );

  server.registerTool(
    "list-request-comments",
    {
      title: "List request comments",
      description:
        "List the comment thread on a client request (author, text, timestamps), oldest first. Returns [] if you can't access the project. Read-only.",
      inputSchema: listRequestCommentsInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listRequestComments(viewer, args)),
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Search your projects, tasks, and requests by text. Returns up to 50 hits. Read-only.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await search(viewer, args)),
  );

  server.registerTool(
    "list-daily-tasks",
    {
      title: "List daily tasks",
      description:
        "List your daily-plan items (your own day plan only). Filter by a single date or a from/to range — dates are YYYY-MM-DD. Capped at 100, ordered by day then sort. Read-only.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listDailyTasks(viewer, args)),
  );

  server.registerTool(
    "read-project-notes",
    {
      title: "Read project notes",
      description:
        "List a project's notes by projectId, newest first. Returns [] if there are no notes or you can't access the project. Read-only.",
      inputSchema: { projectId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listProjectNotes(viewer, args)),
  );

  server.registerTool(
    "list-color-swatches",
    {
      title: "List color swatches",
      description:
        "List the valid color swatches (value + label) accepted by set-project-color, create-project, and the task-category tools. Pass a swatch's `value` (a hex string) as the color. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      jsonResult({
        swatches: PROJECT_SWATCHES.map((s) => ({
          value: s.value,
          label: s.label,
        })),
      }),
  );

  server.registerTool(
    "list-project-activity",
    {
      title: "List project activity",
      description:
        "List project history (the audit log, with before→after diffs), newest first. Optional projectId scopes to one project; otherwise spans all you can access. Read-only.",
      inputSchema: {
        projectId: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listProjectActivity(viewer, args)),
  );

  server.registerTool(
    "list-status-updates",
    {
      title: "List status updates",
      description:
        "List published project status updates (the client-facing summaries), newest first. Optional projectId scopes to one project; otherwise spans all you can access. Read-only.",
      inputSchema: { projectId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await listStatusUpdates(viewer, args)),
  );
}

function registerWriteTools(server: McpServer, viewer: Viewer) {
  server.registerTool(
    "create-task",
    {
      title: "Create task",
      description:
        "Create a task in a project. CONFIRM the project, title, and details with the user before calling — this writes to their workspace. Returns the new taskId.",
      inputSchema: createTaskInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createTask(viewer, args)),
  );

  server.registerTool(
    "update-task",
    {
      title: "Update task",
      description:
        "Update ALL editable fields of a task (title, description, status, priority, dueDate, assignee, category, phase). This REPLACES fields — read the task first and pass the full set, or omitted fields are cleared. CONFIRM with the user.",
      inputSchema: updateTaskInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => updateTask(viewer, args)),
  );

  server.registerTool(
    "update-task-status",
    {
      title: "Update task status",
      description:
        "Move a task to a new status (todo/doing/done) without touching its other fields. Convenience over update-task. CONFIRM the move with the user.",
      inputSchema: updateTaskStatusInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => updateTaskStatus(viewer, args)),
  );

  server.registerTool(
    "set-task-category",
    {
      title: "Set task category",
      description:
        "Assign (or clear) a task's category WITHOUT touching its other fields — the partial-update analogue of update-task-status, so you don't need a full-replace update-task. Pass one task id or many for a bulk re-tag; omit categoryId to clear. Get a categoryId from list-task-categories (or create one with create-task-category). Returns which tasks updated and any that failed. CONFIRM with the user.",
      inputSchema: setTaskCategoryInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => setTaskCategory(viewer, args)),
  );

  server.registerTool(
    "delete-task",
    {
      title: "Delete task",
      description:
        "Permanently delete a task (and its subtasks via cascade). CONFIRM with the user — this cannot be undone.",
      inputSchema: deleteTaskInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteTask(viewer, args)),
  );

  server.registerTool(
    "create-checklist-item",
    {
      title: "Add subtask",
      description:
        "Add a subtask (checklist item) to a task. CONFIRM the content with the user before calling.",
      inputSchema: createChecklistItemInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createChecklistItem(viewer, args)),
  );

  server.registerTool(
    "toggle-checklist-item",
    {
      title: "Toggle subtask",
      description:
        "Flip a subtask between done and open. Calling twice returns to the original state. CONFIRM with the user.",
      inputSchema: toggleChecklistItemInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => toggleChecklistItem(viewer, args)),
  );

  server.registerTool(
    "update-checklist-item",
    {
      title: "Rename subtask",
      description: "Rename a subtask. CONFIRM the new content with the user.",
      inputSchema: updateChecklistItemInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => updateChecklistItem(viewer, args)),
  );

  server.registerTool(
    "delete-checklist-item",
    {
      title: "Delete subtask",
      description:
        "Permanently delete a subtask. CONFIRM with the user — this cannot be undone.",
      inputSchema: deleteChecklistItemInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteChecklistItem(viewer, args)),
  );

  // --- Task categories ------------------------------------------------------
  // Reusable per-project labels. Listing is a read tool (list-task-categories);
  // creating/editing/deleting is owner-only in the service, matching the web.

  server.registerTool(
    "create-task-category",
    {
      title: "Create task category",
      description:
        "Create a reusable task category (label + color swatch) in a project. Project owner only. CONFIRM the name and color with the user. Returns the new categoryId — pass it to create-task / update-task to tag a task. Names are unique per project.",
      inputSchema: createTaskCategoryInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createTaskCategory(viewer, args)),
  );

  server.registerTool(
    "update-task-category",
    {
      title: "Update task category",
      description:
        "Rename or recolor a task category. Only the fields you pass change (omit one to keep it). The new name/color cascade to every task already tagged with it. Project owner only. CONFIRM with the user.",
      inputSchema: updateTaskCategoryInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => updateTaskCategory(viewer, args)),
  );

  server.registerTool(
    "delete-task-category",
    {
      title: "Delete task category",
      description:
        "Permanently delete a task category. Fails if any task still uses it — reassign or clear those tasks first. Project owner only. CONFIRM with the user — this cannot be undone.",
      inputSchema: deleteTaskCategoryInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteTaskCategory(viewer, args)),
  );

  // --- Task labels ----------------------------------------------------------
  // Multi-tag analog of categories. Defining labels is owner-only; assigning
  // them to tasks (add/remove) is member-aware. A task may carry many labels.

  server.registerTool(
    "create-task-label",
    {
      title: "Create task label",
      description:
        "Create a reusable task label (tag + color swatch) in a project. Project owner only. CONFIRM the name and color with the user. Returns the new labelId — pass it to add-task-label to tag tasks. Names are unique per project.",
      inputSchema: createTaskLabelInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createTaskLabel(viewer, args)),
  );

  server.registerTool(
    "update-task-label",
    {
      title: "Update task label",
      description:
        "Rename or recolor a task label. Only the fields you pass change (omit one to keep it). Project owner only. CONFIRM with the user.",
      inputSchema: updateTaskLabelInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => updateTaskLabel(viewer, args)),
  );

  server.registerTool(
    "delete-task-label",
    {
      title: "Delete task label",
      description:
        "Permanently delete a task label; this also removes it from every task that has it. Project owner only. CONFIRM with the user — this cannot be undone.",
      inputSchema: deleteTaskLabelInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteTaskLabel(viewer, args)),
  );

  server.registerTool(
    "add-task-label",
    {
      title: "Add labels to tasks",
      description:
        "Add one or more labels to one or more tasks (a task can have many labels) WITHOUT touching other fields. Pass a single task id or many for a bulk tag; adding a label a task already has is a no-op. Get labelIds from list-task-labels. Returns which tasks updated and any that failed. CONFIRM with the user.",
      inputSchema: addTaskLabelInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => addTaskLabels(viewer, args)),
  );

  server.registerTool(
    "remove-task-label",
    {
      title: "Remove labels from tasks",
      description:
        "Remove one or more labels from one or more tasks WITHOUT touching other fields. Pass a single task id or many for a bulk removal. Returns which tasks updated and any that failed. CONFIRM with the user.",
      inputSchema: removeTaskLabelInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => removeTaskLabels(viewer, args)),
  );

  server.registerTool(
    "create-request",
    {
      title: "Create request",
      description:
        "Capture a new client request in a project. CONFIRM the project and details with the user. Returns the new requestId.",
      inputSchema: createRequestInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createRequest(viewer, args)),
  );

  server.registerTool(
    "update-request",
    {
      title: "Update request",
      description:
        "Update a client request (title, description, status, priority). REPLACES fields — read it first and pass the full set. CONFIRM with the user.",
      inputSchema: updateRequestInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => updateRequest(viewer, args)),
  );

  server.registerTool(
    "delete-request",
    {
      title: "Delete request",
      description:
        "Permanently delete a client request. CONFIRM with the user — this cannot be undone.",
      inputSchema: deleteRequestInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteRequest(viewer, args)),
  );

  // --- Projects -------------------------------------------------------------
  // Settings/lifecycle tools are owner-gated in the service (lib/services/
  // projects.ts), identical to the web app — a token never exceeds the caller's
  // own access.

  server.registerTool(
    "create-project",
    {
      title: "Create project",
      description:
        "Create a new project; you become its owner. CONFIRM the name and details with the user first — this writes to their workspace. The key/slug is auto-derived from the name if omitted. Returns the new projectId.",
      inputSchema: createProjectInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createProject(viewer, args)),
  );

  server.registerTool(
    "update-project",
    {
      title: "Update project",
      description:
        "Update a project's core details (name, client, summary, status, deadline). REPLACES those fields — read the project first and pass the full set, or omitted optional fields are cleared. Owner only. CONFIRM with the user. Slug and color have their own tools.",
      inputSchema: updateProjectInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => updateProject(viewer, args)),
  );

  server.registerTool(
    "set-project-key",
    {
      title: "Set project key",
      description:
        "Set a project's key/slug (2-10 uppercase letters or numbers), used in task and request codes. Must be unique across projects. Owner only. CONFIRM — existing codes re-render with the new key.",
      inputSchema: setProjectSlugInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => setProjectSlug(viewer, args)),
  );

  server.registerTool(
    "set-project-color",
    {
      title: "Set project color",
      description:
        "Set or clear a project's color swatch (pass an empty string to clear). Use list-color-swatches for the valid values. Owner only.",
      inputSchema: setProjectColorInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => setProjectColor(viewer, args)),
  );

  server.registerTool(
    "archive-project",
    {
      title: "Archive project",
      description:
        "Archive a project — reversible; it's hidden from active lists but kept. Owner only. CONFIRM with the user.",
      inputSchema: projectIdInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => archiveProject(viewer, args)),
  );

  server.registerTool(
    "restore-project",
    {
      title: "Restore project",
      description: "Restore a previously archived project. Owner only.",
      inputSchema: projectIdInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => restoreProject(viewer, args)),
  );

  server.registerTool(
    "duplicate-project",
    {
      title: "Duplicate project",
      description:
        "Duplicate a project, copying its requests, tasks, subtasks, and notes into a new '… copy' workspace you own. Owner only. CONFIRM with the user. Returns the new projectId.",
      inputSchema: projectIdInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => duplicateProject(viewer, args)),
  );

  server.registerTool(
    "delete-project",
    {
      title: "Delete project",
      description:
        "PERMANENTLY delete a project and everything in it (tasks, requests, notes, members) via cascade. Owner only. This CANNOT be undone — CONFIRM explicitly with the user, and prefer archive-project unless they truly want it erased.",
      inputSchema: projectIdInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteProject(viewer, args)),
  );

  server.registerTool(
    "set-client-board",
    {
      title: "Set client board sharing",
      description:
        "Publish (enabled=true) or unpublish (enabled=false) a project's public client board. Publishing returns a shareable clientBoardPath. Owner only. CONFIRM — publishing exposes a read-only board to anyone with the link.",
      inputSchema: setClientShareInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => setClientShare(viewer, args)),
  );

  server.registerTool(
    "rotate-client-board-link",
    {
      title: "Rotate client board link",
      description:
        "Generate a fresh public client-board link, immediately invalidating the previous one. Owner only. CONFIRM with the user.",
      inputSchema: projectIdInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => rotateClientShareToken(viewer, args)),
  );

  // --- Project notes & client status updates --------------------------------

  server.registerTool(
    "add-project-note",
    {
      title: "Add project note",
      description:
        "Add a note to a project. Markdown is accepted and converted to rich text. A project can hold many notes; each call adds a new one. Project owner only. CONFIRM with the user.",
      inputSchema: createProjectNoteInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createProjectNote(viewer, args)),
  );

  server.registerTool(
    "publish-status-update",
    {
      title: "Publish client status update",
      description:
        "Publish (or replace) the client-facing status update for a COMPLETED task — the summary clients see on the public board. The task must be done; one update per task. Owner only. CONFIRM with the user.",
      inputSchema: publishStatusUpdateInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => publishStatusUpdate(viewer, args)),
  );

  server.registerTool(
    "delete-status-update",
    {
      title: "Delete client status update",
      description:
        "Remove a task's published client status update. Owner only. CONFIRM with the user.",
      inputSchema: deleteStatusUpdateInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteStatusUpdate(viewer, args)),
  );

  // --- Comments -------------------------------------------------------------
  // Any project member can add a comment; deleting is author-or-admin. Content
  // accepts Markdown (normalized to rich text), like task/request descriptions.

  server.registerTool(
    "add-task-comment",
    {
      title: "Add task comment",
      description:
        "Post a comment on a task. Any project member may comment. Markdown is accepted. CONFIRM the content with the user before calling. Returns the new commentId.",
      inputSchema: addTaskCommentInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createTaskComment(viewer, args)),
  );

  server.registerTool(
    "delete-task-comment",
    {
      title: "Delete task comment",
      description:
        "Delete a task comment by id. You can delete your own comment; workspace admins can delete any. CONFIRM with the user — this cannot be undone.",
      inputSchema: deleteTaskCommentInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteTaskComment(viewer, args)),
  );

  server.registerTool(
    "add-request-comment",
    {
      title: "Add request comment",
      description:
        "Post a comment on a client request. Any project member may comment. Markdown is accepted. CONFIRM the content with the user before calling. Returns the new commentId.",
      inputSchema: addRequestCommentInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createRequestComment(viewer, args)),
  );

  server.registerTool(
    "delete-request-comment",
    {
      title: "Delete request comment",
      description:
        "Delete a client-request comment by id. You can delete your own comment; workspace admins can delete any. CONFIRM with the user — this cannot be undone.",
      inputSchema: deleteRequestCommentInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => deleteRequestComment(viewer, args)),
  );

  // --- Members --------------------------------------------------------------

  server.registerTool(
    "list-project-members",
    {
      title: "List project members",
      description:
        "List a project's owner and members (id, name, email, role). Handy for resolving a userId before assigning a task or removing someone.",
      inputSchema: listProjectMembersInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) => runWrite(() => listProjectMembers(viewer, args)),
  );

  server.registerTool(
    "add-project-member",
    {
      title: "Add project member",
      description:
        "Add an EXISTING workspace user to a project, by email or userId. They must already have an account — use create-invite first for someone brand new. Project owner or workspace admin only. CONFIRM with the user.",
      inputSchema: addProjectMemberInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => addProjectMember(viewer, args)),
  );

  server.registerTool(
    "remove-project-member",
    {
      title: "Remove project member",
      description:
        "Remove a member from a project by userId (does not delete their account). Project owner or workspace admin only. CONFIRM with the user.",
      inputSchema: removeProjectMemberInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => removeProjectMember(viewer, args)),
  );

  // --- Workspace invitations ------------------------------------------------

  server.registerTool(
    "create-invite",
    {
      title: "Create workspace invite",
      description:
        "Create an invitation so a new person can register and join the workspace with a role (member; admin is owners-only; owners can't be invited). Workspace owner/admin only. Returns a token and acceptPath — share <your-domain><acceptPath> with the invitee. CONFIRM with the user.",
      inputSchema: createInviteInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => runWrite(() => createInvite(viewer, args)),
  );

  server.registerTool(
    "list-invites",
    {
      title: "List workspace invites",
      description:
        "List workspace invitations with their status (pending / accepted / expired). Workspace owner/admin only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => runWrite(() => listInvites(viewer)),
  );

  server.registerTool(
    "revoke-invite",
    {
      title: "Revoke workspace invite",
      description:
        "Revoke (delete) a workspace invitation by id, invalidating its link. Workspace owner/admin only. CONFIRM with the user.",
      inputSchema: revokeInviteInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) => runWrite(() => revokeInvite(viewer, args)),
  );
}
