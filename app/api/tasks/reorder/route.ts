import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  logProjectActivities,
  type ActivityInput,
} from "@/lib/activity";
import { getViewer } from "@/lib/auth-server";
import { canProjectCapability } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { projects, taskStatuses, tasks } from "@/lib/db/schema";

// Dynamic board reorder: the client sends the columns in left-to-right order,
// each keyed by its status id with the ordered task ids in it. (Replaces the
// fixed todo/doing/done shape — this is a wire contract shared with the board
// client, so both sides change together.)
const reorderSchema = z.object({
  projectId: z.string().min(1),
  // The branch the board was showing. When present, the reorder is constrained
  // to tasks on that branch so a payload can never renumber another branch's
  // cards (and a card moved off-branch concurrently is simply skipped).
  branchId: z.string().min(1).optional(),
  columns: z
    .array(
      z.object({
        statusId: z.string().min(1),
        taskIds: z.array(z.string()),
      }),
    )
    .max(100),
});

export async function POST(request: Request) {
  const viewer = await getViewer();

  if (!viewer) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: z.infer<typeof reorderSchema>;
  try {
    payload = reorderSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }
  const db = getDb();

  if (!(await canProjectCapability(viewer, payload.projectId, "task.write"))) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const now = new Date();

  // The project's statuses — used to validate each column id belongs to this
  // project and to write the denormalized status_name/status_color/is_terminal
  // cache onto moved tasks.
  const statusRows = await db
    .select({
      id: taskStatuses.id,
      name: taskStatuses.name,
      color: taskStatuses.color,
      isTerminal: taskStatuses.isTerminal,
    })
    .from(taskStatuses)
    .where(eq(taskStatuses.projectId, payload.projectId));
  const statusById = new Map(statusRows.map((s) => [s.id, s]));

  const branchScope = payload.branchId
    ? and(eq(tasks.projectId, payload.projectId), eq(tasks.branchId, payload.branchId))
    : eq(tasks.projectId, payload.projectId);
  const existingTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      statusId: tasks.statusId,
    })
    .from(tasks)
    .where(branchScope);
  const taskMap = new Map(existingTasks.map((task) => [task.id, task]));
  const activityEntries: ActivityInput[] = [];

  for (const column of payload.columns) {
    const status = statusById.get(column.statusId);
    // Skip a column whose status id isn't part of this project (stale client).
    if (!status) continue;

    for (const [index, taskId] of column.taskIds.entries()) {
      const existingTask = taskMap.get(taskId);
      const movedColumns = Boolean(
        existingTask && existingTask.statusId !== status.id,
      );

      if (movedColumns && existingTask) {
        activityEntries.push({
          ownerId: viewer.id,
          projectId: payload.projectId,
          entityType: "task" as const,
          entityId: taskId,
          action: "moved" as const,
          label: `Moved task to ${status.name}`,
          detail: existingTask.title,
          createdAt: now,
        });
      }

      await db
        .update(tasks)
        .set({
          statusId: status.id,
          statusName: status.name,
          statusColor: status.color,
          isTerminal: status.isTerminal,
          sortOrder: index,
          updatedAt: now,
          // Only refresh the column-entry stamp on an actual column change, so a
          // pure within-column reorder doesn't reset "in <status> since".
          ...(movedColumns ? { statusChangedAt: now } : {}),
        })
        .where(
          payload.branchId
            ? and(
                eq(tasks.id, taskId),
                eq(tasks.projectId, payload.projectId),
                eq(tasks.branchId, payload.branchId),
              )
            : and(eq(tasks.id, taskId), eq(tasks.projectId, payload.projectId)),
        );
    }
  }

  await db
    .update(projects)
    .set({
      updatedAt: now,
    })
    .where(eq(projects.id, payload.projectId));

  await logProjectActivities(db, activityEntries);

  revalidatePath("/projects");
  revalidatePath("/today");
  revalidatePath(`/projects/${payload.projectId}`);
  revalidatePath(`/projects/${payload.projectId}/board`);
  // Public board is keyed by share token, not project id — revalidate the route.
  revalidatePath("/client/[token]", "page");

  return Response.json({ ok: true });
}
