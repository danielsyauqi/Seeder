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
  listDailyTasks,
  listProjectActivity,
  listProjects,
  listRequests,
  listStatusUpdates,
  listTasks,
  readProjectNotes,
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
  updateTask,
  updateTaskInputSchema,
  updateTaskStatus,
  updateTaskStatusInputSchema,
} from "@/lib/services/tasks";

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
        "Read a project's notes scratchpad by projectId. Returns null if there's no note or you can't access the project. Read-only.",
      inputSchema: { projectId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await readProjectNotes(viewer, args)),
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

  // Phase 5+ (deferred): project & daily-task write tools — pending the
  // lib/services/projects.ts and daily.ts extraction. Admin-tier tools would
  // gate on isAdminTier(viewer.role).
}
