// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Integration tests for the custom task-status (board column) service: the
// per-project CRUD + the invariants that keep a board usable — you can't delete
// a status that still holds tasks, and a project must always keep at least one
// initial and one terminal status.

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "./helpers/test-db";

const h = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock("@/lib/db", () => ({ getDb: () => h.db }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

import { getDb } from "@/lib/db";
import type { Viewer } from "@/lib/auth-server";
import { projects, tasks, taskStatuses, user } from "@/lib/db/schema";
import {
  createTaskStatus,
  deleteTaskStatus,
  listTaskStatuses,
  reorderTaskStatuses,
  seedDefaultStatuses,
  updateTaskStatusDef,
} from "@/lib/services/statuses";

const PROJECT_ID = "proj-1";
// An admin-tier viewer resolves to the "owner" role for any project (authz), so
// the taxonomy.manage gate passes without needing a membership row.
const viewer = { id: "owner-1", role: "admin" } as Viewer;

let client: { close: () => void };

beforeAll(async () => {
  const made = await createTestDb();
  h.db = made.db;
  client = made.client;
  await getDb()
    .insert(user)
    .values({ id: "owner-1", name: "Owner", email: "owner@example.test" });
});

afterAll(() => client.close());

beforeEach(async () => {
  const db = getDb();
  await db.delete(tasks);
  await db.delete(taskStatuses);
  await db.delete(projects);
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, ownerId: "owner-1", name: "Proj", status: "development" });
  await seedDefaultStatuses(PROJECT_ID);
});

describe("task status service", () => {
  it("seeds Todo/Doing/Done with one initial and one terminal", async () => {
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    expect(list.map((s) => s.name)).toEqual(["Todo", "Doing", "Done"]);
    expect(list.filter((s) => s.isInitial)).toHaveLength(1);
    expect(list.filter((s) => s.isTerminal)).toHaveLength(1);
    expect(list.find((s) => s.name === "Todo")!.isInitial).toBe(true);
    expect(list.find((s) => s.name === "Done")!.isTerminal).toBe(true);
  });

  it("appends a new status after the existing columns", async () => {
    await createTaskStatus(viewer, {
      projectId: PROJECT_ID,
      name: "In Review",
      color: "#d99e25",
    });
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    expect(list.map((s) => s.name)).toEqual(["Todo", "Doing", "Done", "In Review"]);
    expect(list.at(-1)!.sortOrder).toBe(3);
  });

  it("rejects a duplicate status name", async () => {
    await expect(
      createTaskStatus(viewer, { projectId: PROJECT_ID, name: "Done" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("moving terminal flag to another status is allowed; removing the last is not", async () => {
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    const done = list.find((s) => s.name === "Done")!;
    // Can't unset the only terminal status.
    await expect(
      updateTaskStatusDef(viewer, { statusId: done.id, isTerminal: false }),
    ).rejects.toThrow(/terminal/i);
    // But marking another terminal first, then unsetting Done, works.
    const doing = list.find((s) => s.name === "Doing")!;
    await updateTaskStatusDef(viewer, { statusId: doing.id, isTerminal: true });
    await updateTaskStatusDef(viewer, { statusId: done.id, isTerminal: false });
    const after = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    expect(after.filter((s) => s.isTerminal).map((s) => s.name)).toEqual(["Doing"]);
  });

  it("setting a new initial clears the previous initial", async () => {
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    const doing = list.find((s) => s.name === "Doing")!;
    await updateTaskStatusDef(viewer, { statusId: doing.id, isInitial: true });
    const after = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    expect(after.filter((s) => s.isInitial).map((s) => s.name)).toEqual(["Doing"]);
  });

  it("rename/recolor cascades to the denormalized cache on tasks", async () => {
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    const todo = list.find((s) => s.name === "Todo")!;
    await getDb().insert(tasks).values({
      id: "t1",
      ownerId: "owner-1",
      projectId: PROJECT_ID,
      title: "A task",
      statusId: todo.id,
      statusName: "Todo",
      statusColor: "#8a8f98",
      isTerminal: false,
      sortOrder: 0,
    });
    await updateTaskStatusDef(viewer, {
      statusId: todo.id,
      name: "Backlog",
      color: "#eb5757",
    });
    const [row] = await getDb()
      .select({ statusName: tasks.statusName, statusColor: tasks.statusColor })
      .from(tasks);
    expect(row.statusName).toBe("Backlog");
    expect(row.statusColor).toBe("#eb5757");
  });

  it("refuses to delete a status that still holds tasks", async () => {
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    const todo = list.find((s) => s.name === "Todo")!;
    await getDb().insert(tasks).values({
      id: "t1",
      ownerId: "owner-1",
      projectId: PROJECT_ID,
      title: "A task",
      statusId: todo.id,
      statusName: "Todo",
      statusColor: "#8a8f98",
      isTerminal: false,
      sortOrder: 0,
    });
    await expect(
      deleteTaskStatus(viewer, { statusId: todo.id }),
    ).rejects.toThrow(/still has tasks/i);
  });

  it("refuses to delete the only initial or only terminal status", async () => {
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    const todo = list.find((s) => s.name === "Todo")!; // only initial
    const done = list.find((s) => s.name === "Done")!; // only terminal
    await expect(
      deleteTaskStatus(viewer, { statusId: todo.id }),
    ).rejects.toThrow(/initial/i);
    await expect(
      deleteTaskStatus(viewer, { statusId: done.id }),
    ).rejects.toThrow(/terminal/i);
  });

  it("deletes an empty, non-initial, non-terminal status", async () => {
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    const doing = list.find((s) => s.name === "Doing")!;
    await deleteTaskStatus(viewer, { statusId: doing.id });
    const after = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    expect(after.map((s) => s.name)).toEqual(["Todo", "Done"]);
  });

  it("reorders columns by the given id order", async () => {
    const list = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    const byName = Object.fromEntries(list.map((s) => [s.name, s.id]));
    await reorderTaskStatuses(viewer, {
      projectId: PROJECT_ID,
      orderedIds: [byName.Done, byName.Todo, byName.Doing],
    });
    const after = await listTaskStatuses(viewer, { projectId: PROJECT_ID });
    expect(after.map((s) => s.name)).toEqual(["Done", "Todo", "Doing"]);
  });
});
