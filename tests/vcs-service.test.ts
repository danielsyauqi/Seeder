// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Integration tests for lib/services/vcs.ts `ingest` (spec §1.9 service-level
// cases) plus a composition test of the webhook route's verify -> dedup ->
// parse -> ingest pipeline using the checked-in fixtures. Runs against a real
// in-memory schema (tests/helpers/test-db.ts), following the same
// vi.mock("@/lib/db") pattern as tests/public-board.test.ts.
//
// A true route-level HTTP test (importing the Next.js route handler and
// driving it with a Request) is not attempted here — see the "concerns" note
// in the implementing task's final report. This file instead calls
// adapter.verify -> insertDeliveryOrIgnore -> adapter.parse -> ingest exactly
// as the route does, in the same order, which exercises the same logic
// without a Next.js route-handler test harness.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "./helpers/test-db";

const h = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock("@/lib/db", () => ({ getDb: () => h.db }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

// lib/env.ts reads VCS_ENCRYPTION_KEY at import time (lib/crypto/secrets.ts
// depends on it), so it must be set before the first import of
// lib/services/vcs — dynamic imports inside beforeAll, matching
// tests/secrets.test.ts.
let ingest: typeof import("@/lib/services/vcs").ingest;
let insertDeliveryOrIgnore: typeof import("@/lib/services/vcs").insertDeliveryOrIgnore;
let createConnection: typeof import("@/lib/services/vcs").createConnection;
let listConnections: typeof import("@/lib/services/vcs").listConnections;
let updateConnection: typeof import("@/lib/services/vcs").updateConnection;
let deleteConnection: typeof import("@/lib/services/vcs").deleteConnection;
let syncNow: typeof import("@/lib/services/vcs").syncNow;
let encryptSecret: typeof import("@/lib/crypto/secrets").encryptSecret;
let ADAPTERS: typeof import("@/lib/services/vcs/adapters").ADAPTERS;
let VCS_BOT_USER_ID: typeof import("@/lib/services/vcs/constants").VCS_BOT_USER_ID;
let schema: typeof import("@/lib/db/schema");

const FIXTURES_DIR = path.join(process.cwd(), "tests/fixtures/vcs");
function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

let client: { close: () => void };

const PROJECT_ID = "proj-1";
const OWNER_ID = "owner-1";
const AUTHOR_USER_ID = "author-1";
const OUTSIDER_ID = "outsider-1";
const TASK_ID = "task-123";
const REQUEST_ID = "req-45";
const BRANCH_CONN_ID = "conn-branch-mode";
const TICKET_CONN_ID = "conn-ticket-mode";

beforeAll(async () => {
  process.env.VCS_ENCRYPTION_KEY = "E0qJM8RYDT8w9ZQBBfnCP2ieDKJ4DHuiw16XEXHgZTE=";

  const made = await createTestDb();
  h.db = made.db;
  client = made.client;

  const vcsMod = await import("@/lib/services/vcs");
  ingest = vcsMod.ingest;
  insertDeliveryOrIgnore = vcsMod.insertDeliveryOrIgnore;
  createConnection = vcsMod.createConnection;
  listConnections = vcsMod.listConnections;
  updateConnection = vcsMod.updateConnection;
  deleteConnection = vcsMod.deleteConnection;
  syncNow = vcsMod.syncNow;
  const secretsMod = await import("@/lib/crypto/secrets");
  encryptSecret = secretsMod.encryptSecret;
  const adaptersMod = await import("@/lib/services/vcs/adapters");
  ADAPTERS = adaptersMod.ADAPTERS;
  const constantsMod = await import("@/lib/services/vcs/constants");
  VCS_BOT_USER_ID = constantsMod.VCS_BOT_USER_ID;
  schema = await import("@/lib/db/schema");

  const db = h.db;

  await db.insert(schema.user).values([
    { id: OWNER_ID, name: "Owner", email: "owner@example.test" },
    { id: AUTHOR_USER_ID, name: "Priya Natarajan", email: "priya@octo-org.example.com" },
    { id: OUTSIDER_ID, name: "Outsider", email: "outsider@example.test" },
    // vcs-bot is inserted by migration 0038 itself (applied by createTestDb),
    // so it already exists — do not re-insert it here.
  ]);

  await db.insert(schema.projects).values({
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: "Seeder Demo",
    slug: "SEEDER",
  });

  await db.insert(schema.taskStatuses).values({
    id: "st-todo",
    projectId: PROJECT_ID,
    name: "Todo",
    color: "#8a8f98",
    sortOrder: 0,
    isInitial: true,
    isTerminal: false,
  });

  await db.insert(schema.tasks).values({
    id: TASK_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: "Fix login",
    codeNumber: 123,
    statusId: "st-todo",
    statusName: "Todo",
    statusColor: "#8a8f98",
    isTerminal: false,
    sortOrder: 0,
  });

  await db.insert(schema.clientRequests).values({
    id: REQUEST_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    title: "Adjust copy",
    codeNumber: 45,
  });

  // Two connections on the same project, differing only in linkMode, so the
  // branch-name-inheritance tests can push the same envelope shape through
  // each and compare outcomes.
  await db.insert(schema.vcsConnections).values([
    {
      id: BRANCH_CONN_ID,
      projectId: PROJECT_ID,
      provider: "github",
      owner: "octo-org",
      repo: "seeder-demo",
      accessTokenEnc: "v1:unused:unused",
      webhookSecretEnc: "v1:unused:unused",
      linkMode: "branch",
    },
    {
      id: TICKET_CONN_ID,
      projectId: PROJECT_ID,
      provider: "github",
      owner: "octo-org",
      repo: "seeder-demo",
      accessTokenEnc: "v1:unused:unused",
      webhookSecretEnc: "v1:unused:unused",
      linkMode: "ticket",
    },
  ]);
});

afterAll(() => {
  client.close();
});

function systemCtx() {
  return { kind: "system" as const, botUserId: VCS_BOT_USER_ID, projectId: PROJECT_ID };
}

async function getConnection(id: string) {
  const db = h.db;
  const [row] = await db
    .select()
    .from(schema.vcsConnections)
    .where(eq(schema.vcsConnections.id, id))
    .limit(1);
  if (!row) throw new Error(`connection ${id} not found`);
  return row;
}

describe("ingest — commit upsert idempotency", () => {
  const sha = "idem0001111111111111111111111111111111";

  it("inserts one row for a commit sha seen twice", async () => {
    const conn = await getConnection(TICKET_CONN_ID);
    const envelope = {
      provider: "github" as const,
      event: "push" as const,
      deliveryId: "d-idem-1",
      ref: "main",
      headSha: sha,
      pushTimestamp: 1000,
      commits: [
        {
          sha,
          message: "uncoded change",
          url: `https://github.com/octo-org/seeder-demo/commit/${sha}`,
          authorEmail: "priya@octo-org.example.com",
        },
      ],
    };

    const first = await ingest(h.db, systemCtx(), conn, envelope);
    expect(first.commitsInserted).toBe(1);

    const second = await ingest(h.db, systemCtx(), conn, envelope);
    expect(second.commitsInserted).toBe(0); // already present -> nothing new

    const rows = await h.db
      .select()
      .from(schema.vcsCommits)
      .where(and(eq(schema.vcsCommits.connectionId, TICKET_CONN_ID), eq(schema.vcsCommits.sha, sha)));
    expect(rows).toHaveLength(1);
    expect(rows[0].authorUserId).toBe(AUTHOR_USER_ID); // resolved by email
  });
});

describe("ingest — monotonic ref guard", () => {
  const refName = "guarded-branch";

  it("does not regress head_sha when a stale (older pushTimestamp) push arrives", async () => {
    const conn = await getConnection(TICKET_CONN_ID);
    const newerSha = "newer000000000000000000000000000000000";
    const olderSha = "older000000000000000000000000000000000";

    await ingest(h.db, systemCtx(), conn, {
      provider: "github",
      event: "push",
      deliveryId: "d-guard-1",
      ref: refName,
      headSha: newerSha,
      pushTimestamp: 5000,
      commits: [{ sha: newerSha, message: "newer commit", url: "https://example.test/newer" }],
    });

    // A stale/replayed/out-of-order push with an EARLIER pushTimestamp must
    // not move head_sha backwards, even though it carries a different sha.
    await ingest(h.db, systemCtx(), conn, {
      provider: "github",
      event: "push",
      deliveryId: "d-guard-2",
      ref: refName,
      headSha: olderSha,
      pushTimestamp: 1000,
      commits: [{ sha: olderSha, message: "older/stale commit", url: "https://example.test/older" }],
    });

    const [ref] = await h.db
      .select()
      .from(schema.vcsRefs)
      .where(and(eq(schema.vcsRefs.connectionId, TICKET_CONN_ID), eq(schema.vcsRefs.name, refName)));
    expect(ref.headSha).toBe(newerSha);
    expect(ref.lastEventAt?.getTime()).toBe(5000);

    // The stale push's commit is still recorded (backfill-style gap fill) —
    // only the ref's head pointer is guarded, not commit ingestion.
    const staleCommit = await h.db
      .select()
      .from(schema.vcsCommits)
      .where(and(eq(schema.vcsCommits.connectionId, TICKET_CONN_ID), eq(schema.vcsCommits.sha, olderSha)));
    expect(staleCommit).toHaveLength(1);
  });
});

describe("ingest — link-mode inheritance", () => {
  const codedRef = "feature/seeder-123-login";

  it("'branch' mode: an uncoded commit on a coded branch links via link_source='branch_name'", async () => {
    const conn = await getConnection(BRANCH_CONN_ID);
    const sha = "branchmode0000000000000000000000000000";

    await ingest(h.db, systemCtx(), conn, {
      provider: "github",
      event: "push",
      deliveryId: "d-branchmode-1",
      ref: codedRef,
      headSha: sha,
      pushTimestamp: 2000,
      commits: [{ sha, message: "totally uncoded message", url: "https://example.test/c" }],
    });

    const [commitRow] = await h.db
      .select()
      .from(schema.vcsCommits)
      .where(and(eq(schema.vcsCommits.connectionId, BRANCH_CONN_ID), eq(schema.vcsCommits.sha, sha)));

    const links = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(
        and(
          eq(schema.vcsWorkLinks.gitEntityType, "commit"),
          eq(schema.vcsWorkLinks.gitEntityId, commitRow.id),
        ),
      );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      targetType: "task",
      targetId: TASK_ID,
      linkSource: "branch_name",
    });

    // The ref itself is also linked via its coded name (both modes do this).
    const [refRow] = await h.db
      .select()
      .from(schema.vcsRefs)
      .where(and(eq(schema.vcsRefs.connectionId, BRANCH_CONN_ID), eq(schema.vcsRefs.name, codedRef)));
    const refLinks = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(
        and(eq(schema.vcsWorkLinks.gitEntityType, "ref"), eq(schema.vcsWorkLinks.gitEntityId, refRow.id)),
      );
    expect(refLinks).toHaveLength(1);
    expect(refLinks[0]).toMatchObject({ targetType: "task", targetId: TASK_ID, linkSource: "branch_name" });
  });

  it("'ticket' mode: the same push links the ref but NOT the uncoded commit", async () => {
    const conn = await getConnection(TICKET_CONN_ID);
    const sha = "ticketmode0000000000000000000000000000";

    await ingest(h.db, systemCtx(), conn, {
      provider: "github",
      event: "push",
      deliveryId: "d-ticketmode-1",
      ref: codedRef,
      headSha: sha,
      pushTimestamp: 2000,
      commits: [{ sha, message: "totally uncoded message", url: "https://example.test/c2" }],
    });

    const [commitRow] = await h.db
      .select()
      .from(schema.vcsCommits)
      .where(and(eq(schema.vcsCommits.connectionId, TICKET_CONN_ID), eq(schema.vcsCommits.sha, sha)));
    const commitLinks = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(
        and(
          eq(schema.vcsWorkLinks.gitEntityType, "commit"),
          eq(schema.vcsWorkLinks.gitEntityId, commitRow.id),
        ),
      );
    expect(commitLinks).toHaveLength(0); // ticket mode: no message code -> no commit link

    const [refRow] = await h.db
      .select()
      .from(schema.vcsRefs)
      .where(and(eq(schema.vcsRefs.connectionId, TICKET_CONN_ID), eq(schema.vcsRefs.name, codedRef)));
    const refLinks = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(
        and(eq(schema.vcsWorkLinks.gitEntityType, "ref"), eq(schema.vcsWorkLinks.gitEntityId, refRow.id)),
      );
    expect(refLinks).toHaveLength(1); // ref-by-branch-name linking happens in BOTH modes
  });

  it("a commit message code links regardless of link mode", async () => {
    const conn = await getConnection(TICKET_CONN_ID);
    const sha = "msgcode00000000000000000000000000000000".slice(0, 40);

    await ingest(h.db, systemCtx(), conn, {
      provider: "github",
      event: "push",
      deliveryId: "d-msgcode-1",
      ref: "unrelated-branch",
      headSha: sha,
      pushTimestamp: 2100,
      commits: [
        { sha, message: "SEEDER-CR-45 adjust copy per client", url: "https://example.test/c3" },
      ],
    });

    const [commitRow] = await h.db
      .select()
      .from(schema.vcsCommits)
      .where(and(eq(schema.vcsCommits.connectionId, TICKET_CONN_ID), eq(schema.vcsCommits.sha, sha)));
    const commitLinks = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(
        and(
          eq(schema.vcsWorkLinks.gitEntityType, "commit"),
          eq(schema.vcsWorkLinks.gitEntityId, commitRow.id),
        ),
      );
    expect(commitLinks).toHaveLength(1);
    expect(commitLinks[0]).toMatchObject({
      targetType: "request",
      targetId: REQUEST_ID,
      linkSource: "commit_msg",
    });
  });
});

describe("ingest — branch_delete", () => {
  it("flips vcs_refs.state to 'deleted' and creates no work links, even for a coded branch name", async () => {
    const conn = await getConnection(TICKET_CONN_ID);
    const refName = "feature/seeder-123-doomed";

    // First, an ordinary push establishes the ref (so we're testing "delete
    // flips an existing open ref", not "delete of an unknown ref"). This push
    // legitimately links the ref (coded branch name) — that link is expected
    // and is NOT what this test is about.
    await ingest(h.db, systemCtx(), conn, {
      provider: "github",
      event: "push",
      deliveryId: "d-delete-setup",
      ref: refName,
      headSha: "predelete00000000000000000000000000000",
      pushTimestamp: 3000,
      commits: [
        { sha: "predelete00000000000000000000000000000", message: "setup", url: "https://example.test/pd" },
      ],
    });

    const linksBeforeDelete = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(eq(schema.vcsWorkLinks.connectionId, TICKET_CONN_ID));

    await ingest(h.db, systemCtx(), conn, {
      provider: "github",
      event: "branch_delete",
      deliveryId: "d-delete-1",
      ref: refName,
      pushTimestamp: 4000,
      commits: [],
    });

    const [refRow] = await h.db
      .select()
      .from(schema.vcsRefs)
      .where(and(eq(schema.vcsRefs.connectionId, TICKET_CONN_ID), eq(schema.vcsRefs.name, refName)));
    expect(refRow.state).toBe("deleted");
    expect(refRow.deletedAt).not.toBeNull();

    // The delete event itself must create no NEW links — even though the ref
    // name is coded and an earlier push already linked it, the delete's own
    // processing "touches no tasks" (spec DoD).
    const linksAfterDelete = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(eq(schema.vcsWorkLinks.connectionId, TICKET_CONN_ID));
    expect(linksAfterDelete).toHaveLength(linksBeforeDelete.length);
  });

  it("creates no work links at all when the branch is deleted before any push was ever seen", async () => {
    const conn = await getConnection(TICKET_CONN_ID);
    const refName = "feature/seeder-123-never-pushed";

    await ingest(h.db, systemCtx(), conn, {
      provider: "github",
      event: "branch_delete",
      deliveryId: "d-delete-fresh-1",
      ref: refName,
      pushTimestamp: 4500,
      commits: [],
    });

    const [refRow] = await h.db
      .select()
      .from(schema.vcsRefs)
      .where(and(eq(schema.vcsRefs.connectionId, TICKET_CONN_ID), eq(schema.vcsRefs.name, refName)));
    expect(refRow.state).toBe("deleted");

    const refLinks = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(
        and(eq(schema.vcsWorkLinks.gitEntityType, "ref"), eq(schema.vcsWorkLinks.gitEntityId, refRow.id)),
      );
    expect(refLinks).toHaveLength(0); // despite the coded name, delete links nothing
  });
});

describe("webhook composition: verify -> dedup -> parse -> ingest", () => {
  const secret = "s3cr3t-webhook-secret-for-composition-test";
  const CONN_ID = "conn-fixture-flow";

  beforeAll(async () => {
    const webhookSecretEnc = await encryptSecret(secret);
    await h.db.insert(schema.vcsConnections).values({
      id: CONN_ID,
      projectId: PROJECT_ID,
      provider: "github",
      owner: "octo-org",
      repo: "seeder-demo",
      accessTokenEnc: "v1:unused:unused",
      webhookSecretEnc,
      linkMode: "ticket",
    });
  });

  function hmacFor(body: string): string {
    return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  }

  it("valid signature -> fresh delivery -> ingest writes commits + links + one activity row", async () => {
    const raw = loadFixture("github-push.json");
    const headers = new Headers({
      "x-github-event": "push",
      "x-github-delivery": "delivery-flow-1",
    });
    const adapter = ADAPTERS.github;
    const decryptedSecret = secret; // known plaintext for this test

    const sigOk = await adapter.verify(raw, decryptedSecret, hmacFor(raw));
    expect(sigOk).toBe(true);

    const fresh = await insertDeliveryOrIgnore(h.db, "delivery-flow-1", CONN_ID);
    expect(fresh).toBe(true);

    const envelope = adapter.parse(headers, raw);
    expect(envelope).not.toBeNull();

    const conn = await getConnection(CONN_ID);
    const result = await ingest(
      h.db,
      { kind: "system", botUserId: VCS_BOT_USER_ID, projectId: PROJECT_ID },
      conn,
      envelope!,
    );
    expect(result.commitsInserted).toBe(3); // fixture has 3 commits, all new

    const commitRows = await h.db
      .select()
      .from(schema.vcsCommits)
      .where(eq(schema.vcsCommits.connectionId, CONN_ID));
    expect(commitRows).toHaveLength(3);

    // entityId on the collapsed activity row is the head (most recent) new
    // commit's vcs_commits.id, so scope the lookup to one of THIS push's
    // commit ids — the shared in-memory DB also carries commit-type activity
    // rows from earlier describe() blocks in this file.
    const commitIds = new Set(commitRows.map((row) => row.id));
    const activityRows = await h.db
      .select()
      .from(schema.projectActivity)
      .where(eq(schema.projectActivity.entityType, "commit"));
    const ownRows = activityRows.filter((row) => commitIds.has(row.entityId));
    expect(ownRows).toHaveLength(1); // ONE collapsed row, not 3
    expect(ownRows[0].label).toBe("3 commits pushed to feature/seeder-123-login");
    expect(ownRows[0].ownerId).toBe(AUTHOR_USER_ID); // resolved by commit author email

    // SEEDER-123 (task) and SEEDER-CR-45 (request) both linked via commit_msg.
    const links = await h.db
      .select()
      .from(schema.vcsWorkLinks)
      .where(eq(schema.vcsWorkLinks.connectionId, CONN_ID));
    expect(links.some((l) => l.targetType === "task" && l.targetId === TASK_ID)).toBe(true);
    expect(links.some((l) => l.targetType === "request" && l.targetId === REQUEST_ID)).toBe(true);
  });

  it("rejects an invalid signature", async () => {
    const raw = loadFixture("github-push.json");
    const adapter = ADAPTERS.github;
    const sigOk = await adapter.verify(raw, secret, hmacFor(raw + "\ntampered"));
    expect(sigOk).toBe(false);
  });

  it("a replayed delivery id is not fresh the second time", async () => {
    // "delivery-flow-1" was already inserted by the first test in this block.
    const fresh = await insertDeliveryOrIgnore(h.db, "delivery-flow-1", CONN_ID);
    expect(fresh).toBe(false);
  });
});

describe("connection CRUD", () => {
  const ownerViewer = {
    id: OWNER_ID,
    email: "owner@example.test",
    name: "Owner",
    role: "member" as const, // workspace role — project OWNERSHIP is what grants admin here
    image: null,
  };
  const outsiderViewer = {
    id: OUTSIDER_ID,
    email: "outsider@example.test",
    name: "Outsider",
    role: "member" as const,
    image: null,
  };

  it("createConnection gates on canAdministerProject and returns the plaintext secret once", async () => {
    await expect(
      createConnection(outsiderViewer, {
        projectId: PROJECT_ID,
        provider: "github",
        owner: "octo-org",
        repo: "seeder-demo",
        accessToken: "ghp_outsider",
        linkMode: "ticket",
      }),
    ).rejects.toThrow();

    const { connection, receiverUrl, webhookSecret } = await createConnection(ownerViewer, {
      projectId: PROJECT_ID,
      provider: "github",
      owner: "octo-org",
      repo: "seeder-demo",
      accessToken: "ghp_crud_test_token",
      linkMode: "ticket",
    });

    expect(connection.projectId).toBe(PROJECT_ID);
    expect(connection.linkMode).toBe("ticket");
    expect(receiverUrl).toContain(`/api/integrations/github/webhook/${connection.id}`);
    expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    // The stored row never exposes secrets through the summary shape.
    expect(connection).not.toHaveProperty("accessTokenEnc");
    expect(connection).not.toHaveProperty("webhookSecretEnc");

    const [row] = await h.db
      .select()
      .from(schema.vcsConnections)
      .where(eq(schema.vcsConnections.id, connection.id));
    expect(row.accessTokenEnc).not.toBe("ghp_crud_test_token"); // encrypted at rest
    expect(row.webhookSecretEnc).not.toBe(webhookSecret);
  });

  it("listConnections / updateConnection / deleteConnection round-trip", async () => {
    const { connection } = await createConnection(ownerViewer, {
      projectId: PROJECT_ID,
      provider: "gitlab",
      owner: "acme",
      repo: "seeder-demo",
      accessToken: "glpat_crud_test",
      linkMode: "ticket",
    });

    const listed = await listConnections(ownerViewer, PROJECT_ID);
    expect(listed.some((c) => c.id === connection.id)).toBe(true);
    // An outsider (no project access) sees nothing, not an error.
    expect(await listConnections(outsiderViewer, PROJECT_ID)).toEqual([]);

    const updated = await updateConnection(ownerViewer, {
      connectionId: connection.id,
      linkMode: "branch",
    });
    expect(updated.linkMode).toBe("branch");

    await expect(
      updateConnection(outsiderViewer, { connectionId: connection.id, linkMode: "ticket" }),
    ).rejects.toThrow();

    const { connectionId } = await deleteConnection(ownerViewer, {
      connectionId: connection.id,
    });
    expect(connectionId).toBe(connection.id);
    const afterDelete = await h.db
      .select()
      .from(schema.vcsConnections)
      .where(eq(schema.vcsConnections.id, connection.id));
    expect(afterDelete).toHaveLength(0);
  });

  it("syncNow degrades gracefully for a provider backfill can't fetch yet, and still touches lastReconciledAt", async () => {
    const { connection } = await createConnection(ownerViewer, {
      projectId: PROJECT_ID,
      provider: "gitea",
      owner: "octo-org",
      repo: "seeder-demo",
      accessToken: "gitea_pat_test",
      linkMode: "ticket",
    });

    const result = await syncNow(ownerViewer, { connectionId: connection.id });
    expect(result.degraded).toBe(true);
    expect(result.commitsIngested).toBe(0);

    const [row] = await h.db
      .select()
      .from(schema.vcsConnections)
      .where(eq(schema.vcsConnections.id, connection.id));
    expect(row.lastReconciledAt).not.toBeNull();
  });
});
