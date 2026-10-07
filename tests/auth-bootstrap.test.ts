import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "./helpers/test-db";

const h = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock("@/lib/db", () => ({ getDb: () => h.db }));

import { hasRegisteredUser } from "@/lib/auth-bootstrap";
import { user } from "@/lib/db/schema";
import { VCS_BOT_USER_ID } from "@/lib/services/vcs/constants";

let client: { close: () => void };

beforeAll(async () => {
  const made = await createTestDb();
  h.db = made.db;
  client = made.client;
});

afterAll(() => {
  client.close();
});

describe("first-owner bootstrap", () => {
  it("stays open after migrations create the VCS bot, then closes for a real user", async () => {
    const rows = await h.db.select({ id: user.id }).from(user);
    expect(rows).toEqual([{ id: VCS_BOT_USER_ID }]);
    expect(await hasRegisteredUser()).toBe(false);

    await h.db.insert(user).values({
      id: "owner-1",
      name: "Owner",
      email: "owner@example.test",
    });

    expect(await hasRegisteredUser()).toBe(true);
  });
});
