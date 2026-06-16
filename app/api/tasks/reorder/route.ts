import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  logProjectActivities,
  type ActivityInput,
} from "@/lib/activity";
import { getViewer } from "@/lib/auth-server";
import { canAccessProject } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { projects, tasks } from "@/lib/db/schema";

const reorderSchema = z.object({
  projectId: z.string().min(1),
  columns: z.object({
    todo: z.array(z.string()),
    doing: z.array(z.string()),
    done: z.array(z.string()),
  }),
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

  if (!(await canAccessProject(viewer, payload.projectId))) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const now = new Date();
  const existingTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.projectId, payload.projectId));
  const taskMap = new Map(existingTasks.map((task) => [task.id, task]));
  const orderedStatuses = [
    ["todo", payload.columns.todo],
    ["doing", payload.columns.doing],
    ["done", payload.columns.done],
  ] as const;
  const activityEntries: ActivityInput[] = [];

  for (const [status, ids] of orderedStatuses) {
    for (const [index, taskId] of ids.entries()) {
      const existingTask = taskMap.get(taskId);
      const movedColumns = Boolean(existingTask && existingTask.status !== status);

      if (movedColumns && existingTask) {
        activityEntries.push({
          ownerId: viewer.id,
          projectId: payload.projectId,
          entityType: "task" as const,
          entityId: taskId,
          action: "moved" as const,
          label: `Moved task to ${status}`,
          detail: existingTask.title,
          createdAt: now,
        });
      }

      await db
        .update(tasks)
        .set({
          status,
          sortOrder: index,
          updatedAt: now,
          // Only refresh the column-entry stamp on an actual column change, so a
          // pure within-column reorder doesn't reset "in <status> since".
          ...(movedColumns ? { statusChangedAt: now } : {}),
        })
        .where(
          and(eq(tasks.id, taskId), eq(tasks.projectId, payload.projectId)),
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
