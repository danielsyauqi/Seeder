// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Integration tests for the PUBLIC token-scoped upload route
// (/api/client/[token]/uploads/[...path]). This is the only route that serves
// bucket objects to a logged-out client, so it must serve an asset ONLY when
// the token resolves to a published, non-archived board AND the requested key
// is actually referenced by that board's content. Codifies the by-hand probes:
// non-image keys, unreferenced keys, and disabled boards all 404.

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "./helpers/test-db";

const h = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock("@/lib/db", () => ({ getDb: () => h.db }));

// Fake storage: only "images/pic.png" exists in the bucket.
const storageGet = vi.fn(async (key: string) =>
  key === "images/pic.png"
    ? {
        body: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
        etag: '"abc"',
        cacheControl: null,
      }
    : null,
);
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ get: storageGet }) }));

import { getDb } from "@/lib/db";
import { projects, tasks, taskStatuses, user } from "@/lib/db/schema";
import { GET } from "@/app/api/client/[token]/uploads/[...path]/route";

const TOKEN = "auroraBoard_3kP9xZ2mQ7wL5vN8rT6yH1";
const SHARED_ID = "proj-shared";

let client: { close: () => void };

function call(token: string, path: string[]) {
  return GET(new Request("http://localhost/"), {
    params: Promise.resolve({ token, path }),
  });
}

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
      name: "Aurora",
      clientShareEnabled: true,
      clientShareToken: TOKEN,
    },
    {
      id: "proj-private",
      ownerId: "owner-1",
      name: "Atlas",
      clientShareEnabled: false,
      clientShareToken: "atlasTok",
    },
  ]);
  await db.insert(taskStatuses).values({
    id: "st-shared-todo",
    projectId: SHARED_ID,
    name: "Todo",
    color: "#8a8f98",
    sortOrder: 0,
    isInitial: true,
    isTerminal: false,
  });
  // Only "images/pic.png" is referenced by the shared board; "images/secret.png"
  // exists in the bucket but is referenced by nothing.
  await db.insert(tasks).values({
    id: "task-shared",
    ownerId: "owner-1",
    projectId: SHARED_ID,
    title: "Has image",
    description:
      '{"type":"doc","content":[{"type":"image","attrs":{"src":"/api/uploads/images/pic.png"}}]}',
    statusId: "st-shared-todo",
    statusName: "Todo",
    statusColor: "#8a8f98",
    isTerminal: false,
    sortOrder: 0,
  });
});

afterAll(() => {
  client.close();
});

describe("GET /api/client/[token]/uploads/[...path]", () => {
  it("serves an image referenced by the matching shared board", async () => {
    const res = await call(TOKEN, ["images", "pic.png"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(storageGet).toHaveBeenCalledWith("images/pic.png");
  });

  it("404s a non-image key prefix", async () => {
    const res = await call(TOKEN, ["secrets", "passwd"]);
    expect(res.status).toBe(404);
  });

  it("404s an image that exists in the bucket but isn't referenced by the board", async () => {
    const res = await call(TOKEN, ["images", "secret.png"]);
    expect(res.status).toBe(404);
  });

  it("404s when the token belongs to a board with sharing disabled", async () => {
    const res = await call("atlasTok", ["images", "pic.png"]);
    expect(res.status).toBe(404);
  });

  it("404s a forged token", async () => {
    const res = await call("not-a-real-token", ["images", "pic.png"]);
    expect(res.status).toBe(404);
  });
});
