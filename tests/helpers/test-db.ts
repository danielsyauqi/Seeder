// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// A real-schema, in-memory SQLite database for integration tests that need to
// exercise data-access logic (e.g. the public client board). Unlike the pure
// unit tests, these import app DB code, so they live in their own files and
// build the schema from the checked-in migrations — the same SQL that runs in
// production — rather than mocking query results.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "@/lib/db/schema";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// Build a fresh in-memory database with every migration applied, in order.
export async function createTestDb(): Promise<{ db: TestDb; client: Client }> {
  const client = createClient({ url: ":memory:" });

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.executeMultiple(sql);
  }

  const db = drizzle(client, { schema });
  return { db, client };
}
