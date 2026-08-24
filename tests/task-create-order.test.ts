// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Regression test for "latest task on top". A newly created task — from the web
// UI or an MCP client, both of which run createTask — must land at the TOP of
// its column: it gets a smaller sortOrder than the tasks already there, so the
// board (which renders each column by sortOrder ASC) shows the newest card
// first. A status *move* still re-homes to the bottom of the new column, so that
// path (getNextTaskSortOrder) is deliberately not exercised here.

import { asc } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "./helpers/test-db";

const h = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock("@/lib/db", () => ({ getDb: () => h.db }));
// cache() is a request-scoped React API; make it a passthrough under Node.
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

import { getDb } from "@/lib/db";
import type { Viewer } from "@/lib/auth-server";
import { branches, projects, tasks, user } from "@/lib/db/schema";
import { seedDefaultStatuses } from "@/lib/services/statuses";
import { createTask } from "@/lib/services/tasks";

const PROJECT_ID = "proj-1";
const BRANCH_ID = "branch-main";
// An admin-tier viewer resolves to "owner" for any project (authz), so
// task.write passes without a membership row.
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
  await db.delete(branches);
  await db.delete(projects);
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, ownerId: "owner-1", name: "Proj", status: "development" });
  await db
    .insert(branches)
    .values({ id: BRANCH_ID, projectId: PROJECT_ID, name: "Main", isDefault: true });
  await seedDefaultStatuses(PROJECT_ID);
});

describe("createTask ordering", () => {
  it("places each new task at the top of its column", async () => {
    await createTask(viewer, { projectId: PROJECT_ID, title: "First", priority: "medium" });
    await createTask(viewer, { projectId: PROJECT_ID, title: "Second", priority: "medium" });
    await createTask(viewer, { projectId: PROJECT_ID, title: "Third", priority: "medium" });

    const rows = await getDb()
      .select({ title: tasks.title, sortOrder: tasks.sortOrder })
      .from(tasks)
      .orderBy(asc(tasks.sortOrder));

    // Newest first, with strictly-decreasing sortOrder as each create inserts above.
    expect(rows.map((r) => r.title)).toEqual(["Third", "Second", "First"]);
    expect(rows[0].sortOrder).toBeLessThan(rows[1].sortOrder);
    expect(rows[1].sortOrder).toBeLessThan(rows[2].sortOrder);
  });
});
