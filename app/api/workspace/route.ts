import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getViewer } from "@/lib/auth-server";
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
  createRequest,
  createRequestInputSchema,
  deleteRequest,
  deleteRequestInputSchema,
  updateRequest,
  updateRequestInputSchema,
} from "@/lib/services/requests";
import { setTaskLabels } from "@/lib/services/labels";
import {
  createTask,
  createTaskInputSchema,
  deleteTask,
  deleteTaskInputSchema,
  updateTask,
  updateTaskInputSchema,
} from "@/lib/services/tasks";

// The HTTP contract for the web app. Each variant is the matching service input
// schema + its `action` discriminator, so the parsed payload type IS the
// service input type (single source of truth, also reused by the MCP tools).
const workspaceMutationSchema = z.discriminatedUnion("action", [
  createTaskInputSchema.extend({ action: z.literal("create-task") }),
  updateTaskInputSchema.extend({ action: z.literal("update-task") }),
  deleteTaskInputSchema.extend({ action: z.literal("delete-task") }),
  createChecklistItemInputSchema.extend({
    action: z.literal("create-checklist-item"),
  }),
  toggleChecklistItemInputSchema.extend({
    action: z.literal("toggle-checklist-item"),
  }),
  updateChecklistItemInputSchema.extend({
    action: z.literal("update-checklist-item"),
  }),
  deleteChecklistItemInputSchema.extend({
    action: z.literal("delete-checklist-item"),
  }),
  createRequestInputSchema.extend({ action: z.literal("create-request") }),
  updateRequestInputSchema.extend({ action: z.literal("update-request") }),
  deleteRequestInputSchema.extend({ action: z.literal("delete-request") }),
]);

// Labels are many-to-many (a join table), so they ride alongside the task
// create/update payload rather than living on the task schema: the form submits
// them as a comma-separated `labelIds` field (kept out of the discriminated
// union, which would strip it). `undefined` = not provided (leave labels
// untouched, e.g. an MCP call); a present value (even empty) replaces the set.
function readLabelIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }
  return undefined;
}

function revalidateProjectViews(
  projectId: string,
  options: {
    projects?: boolean;
    today?: boolean;
    overview?: boolean;
    requests?: boolean;
    board?: boolean;
    clientBoard?: boolean;
  },
) {
  const basePath = `/projects/${projectId}`;

  if (options.projects) {
    revalidatePath("/projects");
  }

  if (options.today) {
    revalidatePath("/today");
  }

  if (options.overview) {
    revalidatePath(basePath);
  }

  if (options.requests) {
    revalidatePath(`${basePath}/requests`);
  }

  if (options.board) {
    revalidatePath(`${basePath}/board`);
  }

  if (options.clientBoard) {
    // Public board is keyed by share token, not project id — revalidate the route.
    revalidatePath("/client/[token]", "page");
  }
}

// Thin dispatcher: authenticate (cookie session), validate, delegate to the
// shared service, then revalidate the affected views and shape the response.
// The mutation logic itself lives in lib/services/* so the MCP server runs the
// exact same code with identical authz + activity logging.
export async function POST(request: Request) {
  const viewer = await getViewer();

  if (!viewer) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const payload = workspaceMutationSchema.parse(body);

    if (payload.action === "create-task") {
      const { taskId } = await createTask(viewer, payload);
      const labelIds = readLabelIds(body.labelIds);
      if (labelIds) {
        await setTaskLabels(viewer, {
          projectId: payload.projectId,
          taskId,
          labelIds,
        });
      }
      revalidateProjectViews(payload.projectId, {
        projects: true,
        today: true,
        overview: true,
        board: true,
        clientBoard: true,
      });
      return Response.json({ ok: true, taskId });
    }

    if (payload.action === "update-task") {
      const { taskId } = await updateTask(viewer, payload);
      const labelIds = readLabelIds(body.labelIds);
      if (labelIds) {
        await setTaskLabels(viewer, {
          projectId: payload.projectId,
          taskId,
          labelIds,
        });
      }
      revalidateProjectViews(payload.projectId, {
        projects: true,
        today: true,
        overview: true,
        board: true,
        clientBoard: true,
      });
      return Response.json({ ok: true, taskId });
    }

    if (payload.action === "delete-task") {
      const { taskId } = await deleteTask(viewer, payload);
      revalidateProjectViews(payload.projectId, {
        projects: true,
        today: true,
        overview: true,
        board: true,
        clientBoard: true,
      });
      return Response.json({ ok: true, taskId });
    }

    if (payload.action === "create-checklist-item") {
      const { item } = await createChecklistItem(viewer, payload);
      revalidateProjectViews(payload.projectId, {
        projects: true,
        overview: true,
        board: true,
      });
      return Response.json({ ok: true, item });
    }

    if (payload.action === "toggle-checklist-item") {
      const { item } = await toggleChecklistItem(viewer, payload);
      revalidateProjectViews(payload.projectId, {
        projects: true,
        overview: true,
        board: true,
      });
      return Response.json({ ok: true, item });
    }

    if (payload.action === "update-checklist-item") {
      const { item } = await updateChecklistItem(viewer, payload);
      revalidateProjectViews(payload.projectId, {
        projects: true,
        overview: true,
        board: true,
      });
      return Response.json({ ok: true, item });
    }

    if (payload.action === "delete-checklist-item") {
      const { checklistItemId } = await deleteChecklistItem(viewer, payload);
      revalidateProjectViews(payload.projectId, {
        projects: true,
        overview: true,
        board: true,
      });
      return Response.json({ ok: true, checklistItemId });
    }

    if (payload.action === "create-request") {
      const { requestId } = await createRequest(viewer, payload);
      revalidateProjectViews(payload.projectId, {
        projects: true,
        overview: true,
        requests: true,
      });
      return Response.json({ ok: true, requestId });
    }

    if (payload.action === "update-request") {
      const { requestId } = await updateRequest(viewer, payload);
      revalidateProjectViews(payload.projectId, {
        projects: true,
        overview: true,
        requests: true,
      });
      return Response.json({ ok: true, requestId });
    }

    if (payload.action === "delete-request") {
      const { requestId } = await deleteRequest(viewer, payload);
      revalidateProjectViews(payload.projectId, {
        projects: true,
        overview: true,
        requests: true,
      });
      return Response.json({ ok: true, requestId });
    }

    return Response.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to process workspace mutation.";

    return Response.json({ error: message }, { status: 400 });
  }
}
