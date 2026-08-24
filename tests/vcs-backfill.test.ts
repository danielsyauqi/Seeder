// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Integration tests for lib/services/vcs/backfill.ts `backfillConnection`:
// - apiBase() must build api.github.com (not `${baseUrl}/api/v3`) for a
//   github.com connection with no baseUrl (the wizard-default-baseUrl bug).
// - Provider commit-list pages (newest-first) must be reversed before being
//   handed to ingest() (oldest-first, head = last), so vcs_refs.head_sha and
//   the activity/notification "head" land on the newest commit, not the
//   oldest.
// - Backfill must suppress notifications (history import, not a live push).
// - Once a branch's initial walk completes (backfill_cursor = 'done'), a
//   later sync must restart at page 1 and stop as soon as it hits an
//   entirely-already-known page, so new commits (including the truncated
//   tail of a >20-commit webhook push) get healed without re-walking all of
//   history every time.
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "./helpers/test-db";

const h = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock("@/lib/db", () => ({ getDb: () => h.db }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

let backfillConnection: typeof import("@/lib/services/vcs/backfill").backfillConnection;
let encryptSecret: typeof import("@/lib/crypto/secrets").encryptSecret;
let schema: typeof import("@/lib/db/schema");

let client: { close: () => void };

const PROJECT_ID = "proj-bf-1";
const OWNER_ID = "owner-bf-1";
const MEMBER_ID = "member-bf-1";

type GitHubCommitFixture = {
  sha: string;
  message: string;
  committedAtMs: number;
};

function toGitHubCommitRow(c: GitHubCommitFixture) {
  return {
    sha: c.sha,
    html_url: `https://github.com/octo/demo/commit/${c.sha}`,
    commit: {
      message: c.message,
      author: {
        name: "Test Author",
        email: "author@example.test",
        date: new Date(c.committedAtMs).toISOString(),
      },
    },
    author: { login: "test-author" },
  };
}

beforeAll(async () => {
  process.env.VCS_ENCRYPTION_KEY = "E0qJM8RYDT8w9ZQBBfnCP2ieDKJ4DHuiw16XEXHgZTE=";

  const made = await createTestDb();
  h.db = made.db;
  client = made.client;

  const backfillMod = await import("@/lib/services/vcs/backfill");
  backfillConnection = backfillMod.backfillConnection;
  const secretsMod = await import("@/lib/crypto/secrets");
  encryptSecret = secretsMod.encryptSecret;
  schema = await import("@/lib/db/schema");

  const db = h.db;
  await db.insert(schema.user).values([
    { id: OWNER_ID, name: "Owner", email: "owner@example.test" },
    { id: MEMBER_ID, name: "Member", email: "member@example.test" },
  ]);
  await db.insert(schema.projects).values({
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: "Backfill Demo",
    slug: "BFDEMO",
  });
  await db.insert(schema.projectMembers).values({
    id: "pm-bf-1",
    projectId: PROJECT_ID,
    userId: MEMBER_ID,
    role: "member",
  });
});

afterAll(() => {
  client.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeConnection(overrides: Partial<typeof schema.vcsConnections.$inferInsert> = {}) {
  const id = overrides.id ?? `conn-${crypto.randomUUID()}`;
  await h.db.insert(schema.vcsConnections).values({
    id,
    projectId: PROJECT_ID,
    provider: "github",
    baseUrl: null,
    owner: "octo",
    repo: "demo",
    accessTokenEnc: await encryptSecret("test-pat"),
    webhookSecretEnc: await encryptSecret("test-webhook-secret"),
    linkMode: "ticket",
    ...overrides,
  });
  const [row] = await h.db
    .select()
    .from(schema.vcsConnections)
    .where(eq(schema.vcsConnections.id, id));
  return row;
}

describe("backfillConnection — apiBase URL", () => {
  it("hits api.github.com (not baseUrl/api/v3) for a github.com connection with no baseUrl", async () => {
    const conn = await makeConnection({ baseUrl: null });
    const calledUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        calledUrls.push(url);
        if (url.includes("/branches")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    await backfillConnection(h.db, conn);

    expect(calledUrls.some((u) => u.startsWith("https://api.github.com/"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("/api/v3"))).toBe(false);
  });

  it("hits {baseUrl}/api/v3 for a GitHub Enterprise connection", async () => {
    const conn = await makeConnection({ baseUrl: "https://ghe.example.test" });
    const calledUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        calledUrls.push(String(input));
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    await backfillConnection(h.db, conn);

    expect(calledUrls.some((u) => u.startsWith("https://ghe.example.test/api/v3/"))).toBe(true);
  });
});

describe("backfillConnection — commit ordering, notifications, cursor healing", () => {
  const c1: GitHubCommitFixture = { sha: "c1".padEnd(40, "1"), message: "first", committedAtMs: 1000 };
  const c2: GitHubCommitFixture = { sha: "c2".padEnd(40, "2"), message: "second", committedAtMs: 2000 };
  const c3: GitHubCommitFixture = { sha: "c3".padEnd(40, "3"), message: "third", committedAtMs: 3000 };
  const c4: GitHubCommitFixture = { sha: "c4".padEnd(40, "4"), message: "fourth", committedAtMs: 4000 };

  let conn: Awaited<ReturnType<typeof makeConnection>>;
  let page1Commits: GitHubCommitFixture[];

  beforeEach(async () => {
    conn = await makeConnection();
    page1Commits = [c3, c2, c1]; // newest-first, as the real GitHub API returns
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/branches")) {
          return new Response(JSON.stringify([{ name: "main" }]), { status: 200 });
        }
        if (url.includes("/commits")) {
          const pageMatch = url.match(/[?&]page=(\d+)/);
          const page = pageMatch ? Number(pageMatch[1]) : 1;
          const rows = page === 1 ? page1Commits.map(toGitHubCommitRow) : [];
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  it("reverses newest-first pages so vcs_refs.head_sha lands on the newest commit, and suppresses notifications", async () => {
    const result = await backfillConnection(h.db, conn);
    expect(result.degraded).toBe(false);
    expect(result.commitsIngested).toBe(3);

    const [ref] = await h.db
      .select()
      .from(schema.vcsRefs)
      .where(and(eq(schema.vcsRefs.connectionId, conn.id), eq(schema.vcsRefs.name, "main")));
    expect(ref.headSha).toBe(c3.sha); // newest of the page, not c1 (the oldest)
    expect(ref.backfillCursor).toBe("done"); // page had < PER_PAGE rows -> end of history

    const notifs = await h.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.recipientId, MEMBER_ID));
    expect(notifs).toHaveLength(0); // history import must not notify members
  });

  it("heals a new commit landing after the walk is done without re-walking all of history", async () => {
    await backfillConnection(h.db, conn); // first pass: cursor -> "done", 3 commits ingested

    // A new commit (c4) has landed at the tip; page 1 now returns it ahead of
    // the already-known c3/c2/c1.
    page1Commits = [c4, c3, c2, c1];

    const second = await backfillConnection(h.db, conn);
    expect(second.pagesFetched).toBe(1); // only re-checks page 1, doesn't re-walk deeper pages
    expect(second.commitsIngested).toBe(4); // page size fetched (idempotent upsert dedupes c1-c3)

    const [ref] = await h.db
      .select()
      .from(schema.vcsRefs)
      .where(and(eq(schema.vcsRefs.connectionId, conn.id), eq(schema.vcsRefs.name, "main")));
    expect(ref.headSha).toBe(c4.sha);

    const commitRows = await h.db
      .select()
      .from(schema.vcsCommits)
      .where(eq(schema.vcsCommits.connectionId, conn.id));
    expect(commitRows).toHaveLength(4); // c1-c3 not duplicated, c4 added
  });

  it("stops immediately (no ingest) once a page is entirely already-known shas", async () => {
    await backfillConnection(h.db, conn); // cursor -> "done"

    const third = await backfillConnection(h.db, conn); // page 1 unchanged: all known
    expect(third.pagesFetched).toBe(1);
    expect(third.commitsIngested).toBe(0);
  });
});
