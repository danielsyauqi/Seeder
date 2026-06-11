// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Integration tests for the public client board — the only unauthenticated
// data surface in the app. These codify the cross-tenant leakage probes run by
// hand: a shared board exposes ONLY its own project, a board with sharing
// disabled (or archived) is unreachable, and a forged token resolves to
// nothing. The query runs against a real in-memory schema (see test-db).

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "./helpers/test-db";

// Hand getDb() the in-memory database. vi.hoisted keeps the holder reachable
// from the hoisted vi.mock factory; getDb is only ever called after beforeAll.
const h = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock("@/lib/db", () => ({ getDb: () => h.db }));
// cache() is a request-scoped React API; make it a passthrough under Node.
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

import { getDb } from "@/lib/db";
import {
  projects,
  tasks,
  projectStatusUpdates,
  taskChecklistItems,
  taskComments,
  user,
} from "@/lib/db/schema";
import { getPublicProjectBoard } from "@/lib/data";

const SHARED_TOKEN = "auroraBoard_3kP9xZ2mQ7wL5vN8rT6yH1";
const SHARED_ID = "proj-shared";
const PRIVATE_ID = "proj-private";
const ARCHIVED_ID = "proj-archived";
const ARCHIVED_TOKEN = "archivedBoard_tok";

let client: { close: () => void };

beforeAll(async () => {
  const made = await createTestDb();
  h.db = made.db;
  client = made.client;
  const db = getDb();

  await db.insert(user).values({
    id: "owner-1",
    name: "Owner",
    email: "owner@example.test",
  });

  await db.insert(projects).values([
    {
      id: SHARED_ID,
      ownerId: "owner-1",
      name: "Aurora Mobile App",
      slug: "AURORA",
      clientName: "Northwind Retail",
      summary: "Shared summary.",
      status: "production",
      clientShareEnabled: true,
      clientShareToken: SHARED_TOKEN,
    },
    {
      id: PRIVATE_ID,
      ownerId: "owner-1",
      name: "Atlas Analytics",
      slug: "ATLAS",
      clientName: "Meridian Health",
      summary: "Private summary — must never surface.",
      status: "development",
      clientShareEnabled: false,
      clientShareToken: null,
    },
    {
      id: ARCHIVED_ID,
      ownerId: "owner-1",
      name: "Archived Project",
      slug: "ARCH",
      status: "completed",
      clientShareEnabled: true,
      clientShareToken: ARCHIVED_TOKEN,
      archivedAt: new Date(),
    },
  ]);

  await db.insert(tasks).values([
    {
      id: "task-shared",
      ownerId: "owner-1",
      projectId: SHARED_ID,
      title: "Shared task",
      description: '{"type":"doc","content":[]}',
      status: "doing",
      sortOrder: 0,
    },
    {
      id: "task-private",
      ownerId: "owner-1",
      projectId: PRIVATE_ID,
      title: "SECRET private task",
      description: "internal-only",
      status: "todo",
      sortOrder: 0,
    },
  ]);

  await db.insert(projectStatusUpdates).values([
    {
      id: "upd-shared",
      ownerId: "owner-1",
      projectId: SHARED_ID,
      taskId: "task-shared",
      summary: "Shared update",
    },
    {
      id: "upd-private",
      ownerId: "owner-1",
      projectId: PRIVATE_ID,
      taskId: "task-private",
      summary: "SECRET private update",
    },
  ]);

  await db.insert(taskChecklistItems).values([
    {
      id: "ck-shared",
      ownerId: "owner-1",
      projectId: SHARED_ID,
      taskId: "task-shared",
      content: "Shared subtask",
      isCompleted: false,
      sortOrder: 0,
    },
    {
      id: "ck-private",
      ownerId: "owner-1",
      projectId: PRIVATE_ID,
      taskId: "task-private",
      content: "SECRET private subtask",
      isCompleted: false,
      sortOrder: 0,
    },
  ]);

  await db.insert(taskComments).values({
    id: "cm-private",
    authorId: "owner-1",
    projectId: PRIVATE_ID,
    taskId: "task-private",
    content: "SECRET comment",
  });
});

afterAll(() => {
  client.close();
});

describe("getPublicProjectBoard", () => {
  it("returns only the shared project for a valid token", async () => {
    const board = await getPublicProjectBoard(SHARED_TOKEN);
    expect(board).not.toBeNull();
    expect(board!.project.id).toBe(SHARED_ID);
    expect(board!.project.name).toBe("Aurora Mobile App");
  });

  it("never leaks another project's tasks, updates, or checklist items", async () => {
    const board = await getPublicProjectBoard(SHARED_TOKEN);
    const serialized = JSON.stringify(board);

    // The private project's content must not appear anywhere in the payload.
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("Atlas");
    expect(serialized).not.toContain("Meridian");
    expect(serialized).not.toContain(PRIVATE_ID);

    expect(board!.tasks.every((t) => t.id === "task-shared")).toBe(true);
    expect(board!.statusUpdates.every((u) => u.id === "upd-shared")).toBe(true);
  });

  it("does not expose internal columns on status updates", async () => {
    const board = await getPublicProjectBoard(SHARED_TOKEN);
    const update = board!.statusUpdates[0] as Record<string, unknown>;
    // After the tightening, only render-needed fields are selected.
    expect(update).not.toHaveProperty("ownerId");
    expect(update).not.toHaveProperty("projectId");
  });

  it("returns null when sharing is disabled, even with a known id", async () => {
    expect(await getPublicProjectBoard(PRIVATE_ID)).toBeNull();
    expect(await getPublicProjectBoard("ATLAS")).toBeNull();
  });

  it("returns null for an archived project whose token is still set", async () => {
    expect(await getPublicProjectBoard(ARCHIVED_TOKEN)).toBeNull();
  });

  it("returns null for forged, empty, or tampered tokens", async () => {
    expect(await getPublicProjectBoard("")).toBeNull();
    expect(await getPublicProjectBoard("nope")).toBeNull();
    // off-by-one on the real token
    expect(
      await getPublicProjectBoard(SHARED_TOKEN.slice(0, -1) + "X"),
    ).toBeNull();
  });

  it("rewrites embedded upload src to the token-scoped public route", async () => {
    const db = getDb();
    await db.insert(tasks).values({
      id: "task-img",
      ownerId: "owner-1",
      projectId: SHARED_ID,
      title: "Task with image",
      description:
        '{"type":"doc","content":[{"type":"image","attrs":{"src":"/api/uploads/images/pic.png"}}]}',
      status: "todo",
      sortOrder: 1,
    });

    const board = await getPublicProjectBoard(SHARED_TOKEN);
    const imgTask = board!.tasks.find((t) => t.id === "task-img");
    expect(imgTask!.description).toContain(
      `/api/client/${SHARED_TOKEN}/uploads/images/pic.png`,
    );
    expect(imgTask!.description).not.toContain("/api/uploads/images/pic.png");
  });
});
