// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Project mutation services — shared by the web server actions (lib/actions.ts)
// and the MCP server (lib/mcp/server.ts). Each takes a Viewer + typed input,
// performs the authz check + DB mutation + activity logging, and returns a plain
// result. NO revalidatePath / redirect / FormData (those stay in the web action
// wrappers). Extracted from lib/actions.ts so an MCP mutation runs the exact
// same validation, authz, and activity logging as the web app.
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { logProjectActivity } from "@/lib/activity";
import {
  diffChanges,
  formatActivityDate,
  projectStatusLabel,
} from "@/lib/activity-diff";
import { type Viewer } from "@/lib/auth-server";
import {
  deriveSlug,
  isValidSlug,
  normalizeSlugInput,
  SLUG_MAX_LENGTH,
} from "@/lib/codes";
import { getDb } from "@/lib/db";
import {
  clientRequests,
  projectNotes,
  projects,
  projectStatusValues,
  taskChecklistItems,
  tasks,
} from "@/lib/db/schema";
import { optionalText, parseDate } from "@/lib/services/_shared";
import { isValidProjectColor } from "@/lib/swatches";

// --- Reusable field validators (mirror the web schemas in lib/actions.ts) ----

/** Optional project key: normalized to uppercase, "" collapses to undefined. */
const optionalSlugField = z
  .string()
  .trim()
  .transform((value) => normalizeSlugInput(value))
  .refine((value) => value === "" || isValidSlug(value), {
    message: `Slug must be 2-${SLUG_MAX_LENGTH} uppercase letters or numbers.`,
  })
  .optional()
  .or(z.literal("").transform(() => undefined));

/** Required project key: 2-10 uppercase letters/numbers after normalization. */
const slugField = z
  .string()
  .trim()
  .transform((value) => normalizeSlugInput(value))
  .refine(isValidSlug, {
    message: `Slug must be 2-${SLUG_MAX_LENGTH} uppercase letters or numbers.`,
  });

/** Empty string = no/clear color; any non-empty value must be a known swatch. */
const colorField = z
  .string()
  .trim()
  .refine((value) => value === "" || isValidProjectColor(value), {
    message: "Unknown project color.",
  });

// --- Input schemas (exported so the MCP tools can reuse them) ----------------

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: optionalSlugField.describe(
    "Project key, 2-10 uppercase letters/numbers (used in task/request codes). Auto-derived from the name if omitted.",
  ),
  clientName: optionalText.describe("Client or stakeholder name."),
  summary: optionalText.describe("Short project summary / scope."),
  status: z.enum(projectStatusValues).default("development"),
  deadline: optionalText.describe(
    "Deadline as an ISO-8601 date, e.g. 2026-06-04.",
  ),
  color: colorField
    .optional()
    .describe("Project color swatch key, or empty to leave uncolored."),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const updateProjectInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  clientName: optionalText.describe("Client or stakeholder name."),
  summary: optionalText.describe("Short project summary / scope."),
  status: z.enum(projectStatusValues),
  deadline: optionalText.describe(
    "Deadline as an ISO-8601 date, e.g. 2026-06-04. Omit to clear it.",
  ),
});
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const setProjectSlugInputSchema = z.object({
  projectId: z.string().min(1),
  slug: slugField,
});
export type SetProjectSlugInput = z.infer<typeof setProjectSlugInputSchema>;

export const setProjectColorInputSchema = z.object({
  projectId: z.string().min(1),
  color: colorField.describe(
    "Project color swatch key, or an empty string to clear the color.",
  ),
});
export type SetProjectColorInput = z.infer<typeof setProjectColorInputSchema>;

export const projectIdInputSchema = z.object({
  projectId: z.string().min(1),
});
export type ProjectIdInput = z.infer<typeof projectIdInputSchema>;

export const setClientShareInputSchema = z.object({
  projectId: z.string().min(1),
  enabled: z.boolean().describe("true publishes the public client board; false takes it offline."),
});
export type SetClientShareInput = z.infer<typeof setClientShareInputSchema>;

export const setClientShareVisibilityInputSchema = z.object({
  projectId: z.string().min(1),
  showBoard: z
    .boolean()
    .describe("Show the whole task board on the public client view."),
  showDescription: z
    .boolean()
    .describe(
      "Allow clients to open a task and read its full description; when false, cards are not clickable.",
    ),
  showCommits: z
    .boolean()
    .describe("Show the commit-changes / status-update log on the public view."),
});
export type SetClientShareVisibilityInput = z.infer<
  typeof setClientShareVisibilityInputSchema
>;

// --- Internal helpers --------------------------------------------------------

/**
 * Authority to mutate a project's settings / lifecycle (edit, slug, color,
 * archive, delete, share, duplicate): the project owner only — identical to
 * lib/actions.ts assertProjectOwnership, so an MCP token never exceeds the
 * caller's own web access (admins can manage members on any project, but only
 * the owner edits project settings). Uses the same opaque "Project not found."
 * so a probe can't distinguish a missing project from one the caller can't touch.
 */
async function assertProjectManage(viewer: Viewer, projectId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, viewer.id)))
    .limit(1);

  if (!project) throw new Error("Project not found.");
  return project;
}

async function isSlugTaken(
  slug: string,
  excludeProjectId?: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(2);
  if (rows.length === 0) return false;
  if (excludeProjectId && rows.every((row) => row.id === excludeProjectId)) {
    return false;
  }
  return true;
}

export async function resolveSlugForCreate(
  candidate: string | undefined,
  fallbackName: string,
): Promise<string> {
  const seed =
    candidate && candidate.length ? candidate : deriveSlug(fallbackName);
  if (!seed) {
    // Fallback: random-ish chunk so the project still gets a slug.
    return `PRJ${Math.floor(Date.now() % 100000)}`;
  }

  let attempt = seed;
  let counter = 2;
  while (await isSlugTaken(attempt)) {
    const suffix = String(counter);
    attempt = `${seed.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    counter += 1;
    if (counter > 999) {
      throw new Error("Could not allocate a unique project slug.");
    }
  }
  return attempt;
}

// High-entropy, URL-safe token for the public client board (mirrors the
// invite-token generator). 32 random bytes => 43-char base64url.
function generateShareToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

// --- Services ----------------------------------------------------------------

export async function createProject(
  viewer: Viewer,
  input: CreateProjectInput,
): Promise<{ projectId: string }> {
  const db = getDb();
  const now = new Date();
  const projectId = crypto.randomUUID();
  const slug = await resolveSlugForCreate(input.slug, input.name);

  await db.insert(projects).values({
    id: projectId,
    ownerId: viewer.id,
    name: input.name,
    slug,
    clientName: input.clientName ?? null,
    summary: input.summary ?? null,
    status: input.status,
    deadline: parseDate(input.deadline),
    color: input.color ? input.color : null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId,
    entityType: "project",
    entityId: projectId,
    action: "created",
    label: "Created project",
    detail: input.name,
    createdAt: now,
  });

  return { projectId };
}

export async function updateProject(
  viewer: Viewer,
  input: UpdateProjectInput,
): Promise<{ projectId: string }> {
  const db = getDb();
  const now = new Date();

  const existingProject = await assertProjectManage(viewer, input.projectId);

  const nextDeadline = parseDate(input.deadline);
  await db
    .update(projects)
    .set({
      name: input.name,
      clientName: input.clientName ?? null,
      summary: input.summary ?? null,
      status: input.status,
      deadline: nextDeadline,
      updatedAt: now,
    })
    .where(eq(projects.id, input.projectId));

  const changes = diffChanges([
    { field: "name", label: "Name", from: existingProject.name, to: input.name },
    {
      field: "clientName",
      label: "Client",
      from: existingProject.clientName,
      to: input.clientName ?? null,
    },
    {
      field: "summary",
      label: "Summary",
      from: existingProject.summary,
      to: input.summary ?? null,
    },
    {
      field: "status",
      label: "Status",
      from: projectStatusLabel(existingProject.status),
      to: projectStatusLabel(input.status),
    },
    {
      field: "deadline",
      label: "Deadline",
      from: formatActivityDate(existingProject.deadline),
      to: formatActivityDate(nextDeadline),
    },
  ]);

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "updated",
    label: "Updated project details",
    detail: input.name,
    changes,
    createdAt: now,
  });

  return { projectId: input.projectId };
}

export async function setProjectSlug(
  viewer: Viewer,
  input: SetProjectSlugInput,
): Promise<{ projectId: string; slug: string }> {
  const db = getDb();
  const now = new Date();

  const project = await assertProjectManage(viewer, input.projectId);

  if (project.slug === input.slug) {
    return { projectId: input.projectId, slug: input.slug };
  }

  if (await isSlugTaken(input.slug, input.projectId)) {
    throw new Error(
      `Slug "${input.slug}" is already taken by another project.`,
    );
  }

  await db
    .update(projects)
    .set({ slug: input.slug, updatedAt: now })
    .where(eq(projects.id, input.projectId));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "updated",
    label: "Updated project key",
    detail: `${project.slug ?? "(none)"} → ${input.slug}`,
    createdAt: now,
  });

  return { projectId: input.projectId, slug: input.slug };
}

export async function setProjectColor(
  viewer: Viewer,
  input: SetProjectColorInput,
): Promise<{ projectId: string; color: string | null }> {
  const db = getDb();
  const now = new Date();

  const project = await assertProjectManage(viewer, input.projectId);

  const nextColor = input.color === "" ? null : input.color;
  if ((project.color ?? null) === nextColor) {
    return { projectId: input.projectId, color: nextColor };
  }

  await db
    .update(projects)
    .set({ color: nextColor, updatedAt: now })
    .where(eq(projects.id, input.projectId));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "updated",
    label: "Updated project color",
    detail: nextColor ?? "cleared",
    createdAt: now,
  });

  return { projectId: input.projectId, color: nextColor };
}

export async function archiveProject(
  viewer: Viewer,
  input: ProjectIdInput,
): Promise<{ projectId: string }> {
  const db = getDb();
  const project = await assertProjectManage(viewer, input.projectId);
  const now = new Date();

  await db
    .update(projects)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(projects.id, input.projectId));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "archived",
    label: "Archived project",
    detail: project.name,
    createdAt: now,
  });

  return { projectId: input.projectId };
}

export async function restoreProject(
  viewer: Viewer,
  input: ProjectIdInput,
): Promise<{ projectId: string }> {
  const db = getDb();
  const project = await assertProjectManage(viewer, input.projectId);
  const now = new Date();

  await db
    .update(projects)
    .set({ archivedAt: null, updatedAt: now })
    .where(eq(projects.id, input.projectId));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "restored",
    label: "Restored project",
    detail: project.name,
    createdAt: now,
  });

  return { projectId: input.projectId };
}

export async function deleteProject(
  viewer: Viewer,
  input: ProjectIdInput,
): Promise<{ projectId: string }> {
  const db = getDb();
  await assertProjectManage(viewer, input.projectId);

  // Child rows (tasks, requests, notes, members, …) cascade via ON DELETE.
  await db.delete(projects).where(eq(projects.id, input.projectId));

  return { projectId: input.projectId };
}

export async function setClientShare(
  viewer: Viewer,
  input: SetClientShareInput,
): Promise<{
  projectId: string;
  enabled: boolean;
  shareToken: string | null;
  clientBoardPath: string | null;
}> {
  const db = getDb();
  const project = await assertProjectManage(viewer, input.projectId);
  const now = new Date();

  if (input.enabled) {
    // Generate a token on first enable; reuse the existing one on re-enable so a
    // previously shared link keeps working.
    const token = project.clientShareToken ?? generateShareToken();
    await db
      .update(projects)
      .set({ clientShareEnabled: true, clientShareToken: token, updatedAt: now })
      .where(eq(projects.id, input.projectId));

    await logProjectActivity(db, {
      ownerId: viewer.id,
      projectId: input.projectId,
      entityType: "project",
      entityId: input.projectId,
      action: "updated",
      label: "Published client board",
      detail: project.name,
      createdAt: now,
    });

    return {
      projectId: input.projectId,
      enabled: true,
      shareToken: token,
      clientBoardPath: `/client/${token}`,
    };
  }

  // Keep the token so re-enabling restores the same link; flipping the flag is
  // enough to take the board offline.
  await db
    .update(projects)
    .set({ clientShareEnabled: false, updatedAt: now })
    .where(eq(projects.id, input.projectId));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "updated",
    label: "Made client board private",
    detail: project.name,
    createdAt: now,
  });

  return {
    projectId: input.projectId,
    enabled: false,
    shareToken: project.clientShareToken,
    clientBoardPath: null,
  };
}

export async function setClientShareVisibility(
  viewer: Viewer,
  input: SetClientShareVisibilityInput,
): Promise<{
  projectId: string;
  showBoard: boolean;
  showDescription: boolean;
  showCommits: boolean;
}> {
  const db = getDb();
  const project = await assertProjectManage(viewer, input.projectId);
  const now = new Date();

  await db
    .update(projects)
    .set({
      clientShareShowBoard: input.showBoard,
      clientShareShowDescription: input.showDescription,
      clientShareShowCommits: input.showCommits,
      updatedAt: now,
    })
    .where(eq(projects.id, input.projectId));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "updated",
    label: "Updated client board visibility",
    detail: project.name,
    createdAt: now,
  });

  return {
    projectId: input.projectId,
    showBoard: input.showBoard,
    showDescription: input.showDescription,
    showCommits: input.showCommits,
  };
}

export async function rotateClientShareToken(
  viewer: Viewer,
  input: ProjectIdInput,
): Promise<{ projectId: string; shareToken: string; clientBoardPath: string }> {
  const db = getDb();
  const project = await assertProjectManage(viewer, input.projectId);
  const now = new Date();

  // A fresh token immediately invalidates the previous link.
  const token = generateShareToken();
  await db
    .update(projects)
    .set({ clientShareToken: token, updatedAt: now })
    .where(eq(projects.id, input.projectId));

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "updated",
    label: "Rotated client board link",
    detail: project.name,
    createdAt: now,
  });

  return {
    projectId: input.projectId,
    shareToken: token,
    clientBoardPath: `/client/${token}`,
  };
}

export async function duplicateProject(
  viewer: Viewer,
  input: ProjectIdInput,
): Promise<{ projectId: string }> {
  const db = getDb();
  const sourceProject = await assertProjectManage(viewer, input.projectId);

  // Copy the project owner's rows (matches the web action, where the duplicator
  // is the owner). The new workspace is owned by whoever triggered the copy.
  const sourceOwnerId = sourceProject.ownerId;
  const [sourceRequests, sourceTasks, sourceChecklistItems, sourceNote] =
    await Promise.all([
      db
        .select()
        .from(clientRequests)
        .where(
          and(
            eq(clientRequests.projectId, input.projectId),
            eq(clientRequests.ownerId, sourceOwnerId),
          ),
        )
        .orderBy(desc(clientRequests.createdAt)),
      db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, input.projectId),
            eq(tasks.ownerId, sourceOwnerId),
          ),
        )
        .orderBy(desc(tasks.createdAt)),
      db
        .select()
        .from(taskChecklistItems)
        .where(
          and(
            eq(taskChecklistItems.projectId, input.projectId),
            eq(taskChecklistItems.ownerId, sourceOwnerId),
          ),
        )
        .orderBy(desc(taskChecklistItems.createdAt)),
      db
        .select()
        .from(projectNotes)
        .where(
          and(
            eq(projectNotes.projectId, input.projectId),
            eq(projectNotes.ownerId, sourceOwnerId),
          ),
        )
        .limit(1),
    ]);

  const now = new Date();
  const newProjectId = crypto.randomUUID();
  const newProjectName = `${sourceProject.name} copy`;
  const newSlug = await resolveSlugForCreate(undefined, newProjectName);
  const requestIdMap = new Map<string, string>();
  const taskIdMap = new Map<string, string>();

  await db.insert(projects).values({
    id: newProjectId,
    ownerId: viewer.id,
    name: newProjectName,
    slug: newSlug,
    clientName: sourceProject.clientName,
    summary: sourceProject.summary,
    status: sourceProject.status,
    deadline: sourceProject.deadline,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  // Re-number requests + tasks starting at 1 in the duplicate. Preserve source's
  // created_at order so old codes map predictably to new codes.
  if (sourceRequests.length) {
    const orderedRequests = [...sourceRequests].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    await db.insert(clientRequests).values(
      orderedRequests.map((request, index) => {
        const id = crypto.randomUUID();
        requestIdMap.set(request.id, id);

        return {
          id,
          ownerId: viewer.id,
          projectId: newProjectId,
          title: request.title,
          description: request.description,
          codeNumber: index + 1,
          status: request.status,
          priority: request.priority,
          createdAt: now,
          updatedAt: now,
        };
      }),
    );
  }

  if (sourceTasks.length) {
    const orderedTasks = [...sourceTasks].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    await db.insert(tasks).values(
      orderedTasks.map((task, index) => {
        const id = crypto.randomUUID();
        taskIdMap.set(task.id, id);

        return {
          id,
          ownerId: viewer.id,
          projectId: newProjectId,
          requestId: task.requestId
            ? (requestIdMap.get(task.requestId) ?? null)
            : null,
          title: task.title,
          description: task.description,
          codeNumber: index + 1,
          categoryName: task.categoryName,
          categoryColor: task.categoryColor,
          phase: task.phase,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate,
          sortOrder: task.sortOrder,
          statusChangedAt: now,
          createdAt: now,
          updatedAt: now,
        };
      }),
    );
  }

  if (sourceChecklistItems.length) {
    const duplicatedChecklistItems = sourceChecklistItems.flatMap((item) => {
      const nextTaskId = taskIdMap.get(item.taskId);
      if (!nextTaskId) return [];

      return {
        id: crypto.randomUUID(),
        ownerId: viewer.id,
        projectId: newProjectId,
        taskId: nextTaskId,
        content: item.content,
        isCompleted: item.isCompleted,
        completedAt: item.isCompleted ? item.completedAt : null,
        sortOrder: item.sortOrder,
        createdAt: now,
        updatedAt: now,
      };
    });

    if (duplicatedChecklistItems.length) {
      await db.insert(taskChecklistItems).values(duplicatedChecklistItems);
    }
  }

  if (sourceNote[0]) {
    await db.insert(projectNotes).values({
      id: crypto.randomUUID(),
      ownerId: viewer.id,
      projectId: newProjectId,
      content: sourceNote[0].content,
      createdAt: now,
      updatedAt: now,
    });
  }

  await logProjectActivity(db, {
    ownerId: viewer.id,
    projectId: newProjectId,
    entityType: "project",
    entityId: newProjectId,
    action: "duplicated",
    label: "Duplicated workspace",
    detail: sourceProject.name,
    createdAt: now,
  });

  return { projectId: newProjectId };
}
