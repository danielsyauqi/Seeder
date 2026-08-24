// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// VCS Sync service (spec §1.3) — connects a project to a GitHub/GitLab repo,
// ingests webhook pushes, and links commits/branches to tasks/requests by
// ticket code. Shared by Server Actions, MCP, and the webhook route
// (app/api/integrations/[provider]/webhook/[connectionId]/route.ts).
//
// Deliberately free of `getCloudflareContext` — every function takes/derives
// its own `db` via `getDb()` so this file works unchanged on both Cloudflare
// Workers and `RUNTIME=node` (see lib/db/index.ts). The webhook route and
// lib/services/vcs/backfill.ts both call `ingest`/`getDb` directly rather than
// this module reaching into Workers-only globals.
import type { BatchItem } from "drizzle-orm/batch";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { toActivityRow } from "@/lib/activity";
import type { Viewer } from "@/lib/auth-server";
import { canAccessProject, canAdministerProject } from "@/lib/authz";
import { encryptSecret } from "@/lib/crypto/secrets";
import { getDb } from "@/lib/db";
import {
  clientRequests,
  projectActivity,
  projectMembers,
  projects,
  tasks,
  user,
  vcsCommits,
  vcsConnections,
  vcsDeliveries,
  vcsLinkModeValues,
  vcsProviderValues,
  vcsRefs,
  vcsWorkLinks,
  type VcsConnection,
  type VcsCommit,
  type VcsLinkMode,
  type VcsProvider,
} from "@/lib/db/schema";
import { serverEnv } from "@/lib/env";
import { createNotifications, type NotificationInput } from "@/lib/notifications";
import { assertProjectAdminister } from "@/lib/services/_shared";
import { backfillConnection, type BackfillResult } from "@/lib/services/vcs/backfill";
import { VCS_BOT_USER_ID } from "@/lib/services/vcs/constants";
import { parseTicketRefs, type TicketRef } from "@/lib/services/vcs/parse";
import type { NormalizedEnvelope, VcsActor } from "@/lib/services/vcs/types";
import { chunk } from "@/lib/utils";

// D1 caps every statement (including each item inside db.batch) at 100 bound
// parameters. These are floor(100 / columns-per-row) for the multi-row
// inserts below — libsql (RUNTIME=node) and the local D1 simulator don't
// enforce this, so it's silent until a deployed Workers request hits it.
const COMMITS_INSERT_CHUNK = 7; // 13 columns/row
const WORK_LINKS_INSERT_CHUNK = 11; // 9 columns/row

type DbClient = ReturnType<typeof getDb>;
type SystemActor = Extract<VcsActor, { kind: "system" }>;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

// baseUrl is fetched server-side during backfill/"Sync now" with the
// connection's decrypted PAT attached as an auth header (see
// lib/services/vcs/backfill.ts apiBase()), so an unrestricted URL lets a
// project admin turn the server into a credentialed SSRF probe against
// internal services / cloud metadata endpoints. Require http(s) and reject
// loopback/link-local/private/metadata hosts. (This is a format-level
// guard, not DNS-rebinding-proof — it doesn't re-check the resolved IP at
// fetch time — but it closes the direct-literal case, which is what the
// wizard's freeform text input actually exposes.)
function isDisallowedBaseUrlHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "::") return true;
  if (host.endsWith(".localhost")) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
    if (a === 0) return true;
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return true;

  return false;
}

const optionalUrl = z
  .string()
  .trim()
  .url()
  .refine(
    (value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !isDisallowedBaseUrlHost(url.hostname)
      );
    },
    { message: "Base URL must be a public http(s) address." },
  )
  .optional()
  .or(z.literal("").transform(() => undefined));

export const createConnectionInputSchema = z.object({
  projectId: z.string().min(1),
  provider: z.enum(vcsProviderValues),
  baseUrl: optionalUrl.describe(
    "Base URL for self-managed instances (GHE, self-hosted GitLab). Omit for github.com/gitlab.com.",
  ),
  owner: z.string().trim().min(1).max(200),
  repo: z.string().trim().min(1).max(200),
  accessToken: z.string().trim().min(1).describe("Read-scope PAT, encrypted at rest."),
  linkMode: z.enum(vcsLinkModeValues),
});
export type CreateConnectionInput = z.infer<typeof createConnectionInputSchema>;

export const updateConnectionInputSchema = z.object({
  connectionId: z.string().min(1),
  linkMode: z.enum(vcsLinkModeValues).optional(),
});
export type UpdateConnectionInput = z.infer<typeof updateConnectionInputSchema>;

export const deleteConnectionInputSchema = z.object({
  connectionId: z.string().min(1),
});
export type DeleteConnectionInput = z.infer<typeof deleteConnectionInputSchema>;

export const syncNowInputSchema = z.object({
  connectionId: z.string().min(1),
});
export type SyncNowInput = z.infer<typeof syncNowInputSchema>;

// ---------------------------------------------------------------------------
// Output shapes (never leak accessTokenEnc / webhookSecretEnc)
// ---------------------------------------------------------------------------

export type VcsConnectionSummary = {
  id: string;
  projectId: string;
  provider: VcsProvider;
  baseUrl: string | null;
  owner: string;
  repo: string;
  defaultBranch: string | null;
  linkMode: VcsLinkMode;
  syncMode: VcsConnection["syncMode"];
  lastReconciledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toConnectionSummary(row: VcsConnection): VcsConnectionSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider,
    baseUrl: row.baseUrl,
    owner: row.owner,
    repo: row.repo,
    defaultBranch: row.defaultBranch,
    linkMode: row.linkMode,
    syncMode: row.syncMode,
    lastReconciledAt: row.lastReconciledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type CommitSummary = {
  id: string;
  connectionId: string;
  sha: string;
  message: string | null;
  authorName: string | null;
  authorEmail: string | null;
  authorUsername: string | null;
  authorUserId: string | null;
  url: string | null;
  refName: string | null;
  committedAt: Date | null;
  createdAt: Date;
};

function toCommitSummary(row: VcsCommit): CommitSummary {
  return {
    id: row.id,
    connectionId: row.connectionId,
    sha: row.sha,
    message: row.message,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    authorUsername: row.authorUsername,
    authorUserId: row.authorUserId,
    url: row.url,
    refName: row.refName,
    committedAt: row.committedAt,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Loose UUID-shape check for the webhook route's connectionId param — not a
 * real lookup, just cheap enough to reject junk before touching the DB. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildReceiverUrl(provider: VcsProvider, connectionId: string): string {
  const base = serverEnv.betterAuthUrl?.replace(/\/$/, "") ?? "";
  return `${base}/api/integrations/${provider}/webhook/${connectionId}`;
}

/**
 * Load a connection for a management op (update/delete/sync). Requires
 * `canAdministerProject` on the connection's project — opaque "not found"
 * otherwise (mirrors assertProjectAdminister's no-existence-oracle pattern).
 */
async function assertConnectionAdminister(
  viewer: Viewer,
  connectionId: string,
): Promise<VcsConnection> {
  const db = getDb();
  const [connection] = await db
    .select()
    .from(vcsConnections)
    .where(eq(vcsConnections.id, connectionId))
    .limit(1);
  if (!connection) throw new Error("Connection not found.");
  if (!(await canAdministerProject(viewer, connection.projectId))) {
    throw new Error("Connection not found.");
  }
  return connection;
}

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

// The cloud default for each provider — apiBase() (lib/services/vcs/backfill.ts)
// treats ANY non-null baseUrl as a self-managed instance and builds
// `${baseUrl}/api/v3|v4`, which is wrong for github.com/gitlab.com (cloud API
// is api.github.com / gitlab.com/api/v4, not github.com/api/v3). The wizard
// pre-fills this exact string and always submits it, so normalize it away
// here too (not just client-side) so MCP/direct callers get the same
// treatment as "leave Base URL blank".
const PROVIDER_DEFAULT_BASE_URL: Partial<Record<VcsProvider, string>> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
};

function normalizeBaseUrl(provider: VcsProvider, baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  const cloudDefault = PROVIDER_DEFAULT_BASE_URL[provider];
  if (cloudDefault && baseUrl.replace(/\/$/, "") === cloudDefault) return null;
  return baseUrl;
}

export async function createConnection(
  viewer: Viewer,
  rawInput: CreateConnectionInput,
): Promise<{ connection: VcsConnectionSummary; receiverUrl: string; webhookSecret: string }> {
  const input = createConnectionInputSchema.parse(rawInput);
  await assertProjectAdminister(viewer, input.projectId);

  const db = getDb();
  const id = crypto.randomUUID();
  const webhookSecret = randomHex(32); // 64 hex chars
  const now = new Date();
  const baseUrl = normalizeBaseUrl(input.provider, input.baseUrl);

  const [accessTokenEnc, webhookSecretEnc] = await Promise.all([
    encryptSecret(input.accessToken),
    encryptSecret(webhookSecret),
  ]);

  await db.insert(vcsConnections).values({
    id,
    projectId: input.projectId,
    provider: input.provider,
    baseUrl,
    owner: input.owner,
    repo: input.repo,
    authType: "pat",
    accessTokenEnc,
    webhookSecretEnc,
    linkMode: input.linkMode,
    syncMode: "webhook",
    createdBy: viewer.id,
    createdAt: now,
    updatedAt: now,
  });

  const connection: VcsConnectionSummary = {
    id,
    projectId: input.projectId,
    provider: input.provider,
    baseUrl,
    owner: input.owner,
    repo: input.repo,
    defaultBranch: null,
    linkMode: input.linkMode,
    syncMode: "webhook",
    lastReconciledAt: null,
    createdAt: now,
    updatedAt: now,
  };

  return { connection, receiverUrl: buildReceiverUrl(input.provider, id), webhookSecret };
}

export async function listConnections(
  viewer: Viewer,
  projectId: string,
): Promise<VcsConnectionSummary[]> {
  if (!(await canAccessProject(viewer, projectId))) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(vcsConnections)
    .where(eq(vcsConnections.projectId, projectId))
    .orderBy(desc(vcsConnections.createdAt));
  return rows.map(toConnectionSummary);
}

export async function updateConnection(
  viewer: Viewer,
  rawInput: UpdateConnectionInput,
): Promise<VcsConnectionSummary> {
  const input = updateConnectionInputSchema.parse(rawInput);
  const connection = await assertConnectionAdminister(viewer, input.connectionId);
  if (input.linkMode === undefined || input.linkMode === connection.linkMode) {
    return toConnectionSummary(connection);
  }

  const db = getDb();
  const now = new Date();
  await db
    .update(vcsConnections)
    .set({ linkMode: input.linkMode, updatedAt: now })
    .where(eq(vcsConnections.id, connection.id));

  return toConnectionSummary({ ...connection, linkMode: input.linkMode, updatedAt: now });
}

export async function deleteConnection(
  viewer: Viewer,
  rawInput: DeleteConnectionInput,
): Promise<{ connectionId: string; projectId: string }> {
  const input = deleteConnectionInputSchema.parse(rawInput);
  const connection = await assertConnectionAdminister(viewer, input.connectionId);
  const db = getDb();
  // Cascades vcs_deliveries/vcs_commits/vcs_refs/vcs_work_links via ON DELETE
  // CASCADE (migration 0038) — nothing else to clean up.
  await db.delete(vcsConnections).where(eq(vcsConnections.id, connection.id));
  return { connectionId: connection.id, projectId: connection.projectId };
}

export async function syncNow(
  viewer: Viewer,
  rawInput: SyncNowInput,
): Promise<BackfillResult> {
  const input = syncNowInputSchema.parse(rawInput);
  const connection = await assertConnectionAdminister(viewer, input.connectionId);
  const db = getDb();
  const result = await backfillConnection(db, connection);
  await db
    .update(vcsConnections)
    .set({ lastReconciledAt: new Date() })
    .where(eq(vcsConnections.id, connection.id));
  return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCommits(
  viewer: Viewer,
  projectId: string,
  opts: { limit?: number } = {},
): Promise<CommitSummary[]> {
  if (!(await canAccessProject(viewer, projectId))) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(vcsCommits)
    .where(eq(vcsCommits.projectId, projectId))
    .orderBy(desc(vcsCommits.committedAt))
    .limit(opts.limit ?? 50);
  return rows.map(toCommitSummary);
}

export async function listCommitsForTask(
  viewer: Viewer,
  taskId: string,
): Promise<CommitSummary[]> {
  const db = getDb();
  const [task] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task) return [];
  if (!(await canAccessProject(viewer, task.projectId))) return [];

  const linkRows = await db
    .select({ gitEntityId: vcsWorkLinks.gitEntityId })
    .from(vcsWorkLinks)
    .where(
      and(
        eq(vcsWorkLinks.targetType, "task"),
        eq(vcsWorkLinks.targetId, taskId),
        eq(vcsWorkLinks.gitEntityType, "commit"),
      ),
    );
  const commitIds = [...new Set(linkRows.map((row) => row.gitEntityId))];
  if (!commitIds.length) return [];

  const rows = await db
    .select()
    .from(vcsCommits)
    .where(inArray(vcsCommits.id, commitIds))
    .orderBy(desc(vcsCommits.committedAt));
  return rows.map(toCommitSummary);
}

// ---------------------------------------------------------------------------
// Webhook route helpers (spec §1.4) — no viewer/capability gate: the caller
// (the webhook route) authenticates via HMAC/token verification instead.
// ---------------------------------------------------------------------------

export async function loadConnectionById(
  db: DbClient,
  connectionId: string,
): Promise<VcsConnection | null> {
  const [row] = await db
    .select()
    .from(vcsConnections)
    .where(eq(vcsConnections.id, connectionId))
    .limit(1);
  return row ?? null;
}

/**
 * INSERT OR IGNORE against vcs_deliveries' primary key (delivery_id). Returns
 * true iff this is a fresh delivery (row inserted) — false means it's a
 * replay and the caller should skip ingest() entirely.
 */
export async function insertDeliveryOrIgnore(
  db: DbClient,
  deliveryId: string,
  connectionId: string,
): Promise<boolean> {
  const result = await db
    .insert(vcsDeliveries)
    .values({ deliveryId, connectionId })
    .onConflictDoNothing({ target: vcsDeliveries.deliveryId })
    .returning({ deliveryId: vcsDeliveries.deliveryId });
  return result.length > 0;
}

/**
 * Removes a delivery id's dedup record so a forge redelivery gets a fresh
 * ingest attempt instead of being acked as a no-op "duplicate". Call this
 * when `ingest()` throws for a delivery you just recorded — `ingest()` is
 * idempotent by commit sha, so re-running on retry/redelivery is safe, but
 * leaving the delivery row in place would make a failed push permanently
 * unrecoverable (the forge's automatic retries and manual "Redeliver" would
 * all be swallowed by the dedup check with no ingest ever re-attempted).
 */
export async function deleteDeliveryRecord(db: DbClient, deliveryId: string): Promise<void> {
  await db.delete(vcsDeliveries).where(eq(vcsDeliveries.deliveryId, deliveryId));
}

// ---------------------------------------------------------------------------
// Ingest (spec §1.3 step-by-step)
// ---------------------------------------------------------------------------

/** Resolve parsed ticket refs (task/request codes) to real row ids, scoped to
 * one project. Callers batch every ref they need resolved into one call so
 * ingest() never issues more than two extra SELECTs regardless of how many
 * branch names / commit messages carry codes. */
async function resolveTicketTargets(
  db: DbClient,
  projectId: string,
  refs: TicketRef[],
): Promise<Map<string, { kind: "task" | "request"; id: string }>> {
  const taskNumbers = [...new Set(refs.filter((r) => r.kind === "task").map((r) => r.number))];
  const requestNumbers = [
    ...new Set(refs.filter((r) => r.kind === "request").map((r) => r.number)),
  ];

  const [taskRows, requestRows] = await Promise.all([
    taskNumbers.length
      ? db
          .select({ id: tasks.id, codeNumber: tasks.codeNumber })
          .from(tasks)
          .where(and(eq(tasks.projectId, projectId), inArray(tasks.codeNumber, taskNumbers)))
      : Promise.resolve([]),
    requestNumbers.length
      ? db
          .select({ id: clientRequests.id, codeNumber: clientRequests.codeNumber })
          .from(clientRequests)
          .where(
            and(
              eq(clientRequests.projectId, projectId),
              inArray(clientRequests.codeNumber, requestNumbers),
            ),
          )
      : Promise.resolve([]),
  ]);

  const byKey = new Map<string, { kind: "task" | "request"; id: string }>();
  for (const row of taskRows) {
    if (row.codeNumber !== null) byKey.set(`task:${row.codeNumber}`, { kind: "task", id: row.id });
  }
  for (const row of requestRows) {
    if (row.codeNumber !== null) {
      byKey.set(`request:${row.codeNumber}`, { kind: "request", id: row.id });
    }
  }
  return byKey;
}

async function getProjectRecipientIds(db: DbClient, projectId: string): Promise<string[]> {
  const [ownerRows, memberRows] = await Promise.all([
    db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1),
    db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId)),
  ]);
  const ids = new Set<string>();
  if (ownerRows[0]?.ownerId) ids.add(ownerRows[0].ownerId);
  for (const row of memberRows) ids.add(row.userId);
  ids.delete(VCS_BOT_USER_ID);
  return [...ids];
}

/**
 * The webhook worker (spec §1.3). Idempotent: replaying the same envelope
 * (same connection, same commit shas) inserts nothing new and emits no
 * activity/notification — the caller (webhook route) additionally dedupes by
 * delivery id before ever reaching here, so this idempotency is a second,
 * independent safety net (also exercised directly by backfill, which has no
 * delivery id to dedupe on).
 */
export async function ingest(
  db: DbClient,
  ctx: SystemActor,
  connection: VcsConnection,
  envelope: NormalizedEnvelope,
  opts: { suppressNotifications?: boolean } = {},
): Promise<{ commitsInserted: number }> {
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, connection.projectId))
    .limit(1);
  if (!project) throw new Error("Project not found for VCS connection.");
  const slug = project.slug ?? "";

  const now = new Date();
  const isDelete = envelope.event === "branch_delete";

  // --- 1. Which commits in this envelope are actually new? -------------------
  const shas = envelope.commits.map((c) => c.sha);
  const existingShaRows = shas.length
    ? await db
        .select({ sha: vcsCommits.sha })
        .from(vcsCommits)
        .where(and(eq(vcsCommits.connectionId, connection.id), inArray(vcsCommits.sha, shas)))
    : [];
  const existingShas = new Set(existingShaRows.map((row) => row.sha));
  const newCommits = envelope.commits
    .filter((c) => !existingShas.has(c.sha))
    .map((c) => ({ ...c, id: crypto.randomUUID() }));
  const idBySha = new Map(newCommits.map((c) => [c.sha, c.id]));

  // Resolve NEW commits' authors -> Seeder user ids by email (case-insensitive).
  const authorEmails = [
    ...new Set(newCommits.map((c) => c.authorEmail).filter((e): e is string => Boolean(e))),
  ];
  const authorRows = authorEmails.length
    ? await db
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(inArray(sql`lower(${user.email})`, authorEmails.map((e) => e.toLowerCase())))
    : [];
  const userIdByEmail = new Map(authorRows.map((row) => [row.email.toLowerCase(), row.id]));

  // --- 2. Ref upsert + monotonic guard ---------------------------------------
  const [existingRef] = await db
    .select()
    .from(vcsRefs)
    .where(and(eq(vcsRefs.connectionId, connection.id), eq(vcsRefs.name, envelope.ref)))
    .limit(1);

  const refId = existingRef?.id ?? crypto.randomUUID();
  const priorLastEventAt = existingRef?.lastEventAt?.getTime() ?? -Infinity;
  const isNewerEvent = envelope.pushTimestamp > priorLastEventAt;

  let refHeadSha = existingRef?.headSha ?? null;
  let refLastEventAt = existingRef?.lastEventAt ?? null;
  if (isNewerEvent && !isDelete) {
    refHeadSha = envelope.headSha ?? refHeadSha;
    refLastEventAt = new Date(envelope.pushTimestamp);
  }

  // A delete always wins (a deletion can arrive with any timestamp and must
  // still take effect). Otherwise, only a NEWER event may flip state back to
  // "open"/clear deletedAt — a stale/out-of-order push processed after a
  // delete (GitHub's dual push+delete delivery race, a webhook retry, or a
  // backfill page racing a remote deletion) must not resurrect a branch
  // that's actually gone, since no future event would ever correct it back.
  const refState = isDelete ? "deleted" : isNewerEvent ? "open" : (existingRef?.state ?? "open");
  const refDeletedAt = isDelete ? now : isNewerEvent ? null : (existingRef?.deletedAt ?? null);

  const statements: BatchItem<"sqlite">[] = [];

  if (existingRef) {
    statements.push(
      db
        .update(vcsRefs)
        .set({
          headSha: refHeadSha,
          lastEventAt: refLastEventAt,
          state: refState,
          deletedAt: refDeletedAt,
          url: envelope.refUrl ?? existingRef.url,
          updatedAt: now,
        })
        .where(eq(vcsRefs.id, existingRef.id)),
    );
  } else {
    statements.push(
      db.insert(vcsRefs).values({
        id: refId,
        connectionId: connection.id,
        projectId: connection.projectId,
        name: envelope.ref,
        refType: "branch",
        headSha: refHeadSha,
        lastEventAt: refLastEventAt,
        state: refState,
        url: envelope.refUrl ?? null,
        deletedAt: refDeletedAt,
        updatedAt: now,
      }),
    );
  }

  // --- 3. Commit upserts (idempotent) -----------------------------------------
  // Chunked to stay under D1's 100-bound-parameters-per-statement cap — a
  // single unchunked multi-row insert would throw once an envelope carries
  // >= 8 commits (13 params/row), which webhook pushes and backfill pages
  // routinely do.
  if (envelope.commits.length) {
    const commitRows = envelope.commits.map((c) => ({
      id: idBySha.get(c.sha) ?? crypto.randomUUID(), // discarded on conflict
      connectionId: connection.id,
      projectId: connection.projectId,
      sha: c.sha,
      message: c.message,
      authorName: c.authorName ?? null,
      authorEmail: c.authorEmail ?? null,
      authorUsername: c.authorUsername ?? null,
      authorUserId: c.authorEmail
        ? (userIdByEmail.get(c.authorEmail.toLowerCase()) ?? null)
        : null,
      url: c.url,
      refName: envelope.ref,
      committedAt: c.committedAt ? new Date(c.committedAt) : null,
      createdAt: now,
    }));
    for (const rows of chunk(commitRows, COMMITS_INSERT_CHUNK)) {
      statements.push(
        db
          .insert(vcsCommits)
          .values(rows)
          .onConflictDoNothing({ target: [vcsCommits.connectionId, vcsCommits.sha] }),
      );
    }
  }

  // --- 4. Linking, honoring connection.linkMode (skipped for branch_delete —
  //        a deleted remote branch must touch NO tasks/requests). ------------
  const branchRefs = isDelete ? [] : parseTicketRefs(envelope.ref, slug);
  const commitRefs = new Map<string, TicketRef[]>(); // commit id -> refs in its message
  if (!isDelete) {
    for (const c of newCommits) {
      commitRefs.set(c.id, parseTicketRefs(c.message, slug));
    }
  }

  const allRefs = [...branchRefs, ...[...commitRefs.values()].flat()];
  const targetsByKey = allRefs.length
    ? await resolveTicketTargets(db, connection.projectId, allRefs)
    : new Map<string, { kind: "task" | "request"; id: string }>();

  function resolveTargets(refs: TicketRef[]) {
    const out: { kind: "task" | "request"; id: string }[] = [];
    for (const ref of refs) {
      const target = targetsByKey.get(`${ref.kind}:${ref.number}`);
      if (target) out.push(target);
    }
    return out;
  }

  const branchTargets = resolveTargets(branchRefs);
  const linkValues: (typeof vcsWorkLinks.$inferInsert)[] = [];

  if (!isDelete) {
    for (const target of branchTargets) {
      linkValues.push({
        id: crypto.randomUUID(),
        projectId: connection.projectId,
        connectionId: connection.id,
        targetType: target.kind,
        targetId: target.id,
        gitEntityType: "ref",
        gitEntityId: refId,
        linkSource: "branch_name",
        createdAt: now,
      });
    }

    for (const c of newCommits) {
      for (const target of resolveTargets(commitRefs.get(c.id) ?? [])) {
        linkValues.push({
          id: crypto.randomUUID(),
          projectId: connection.projectId,
          connectionId: connection.id,
          targetType: target.kind,
          targetId: target.id,
          gitEntityType: "commit",
          gitEntityId: c.id,
          linkSource: "commit_msg",
          createdAt: now,
        });
      }
      // 'branch' link mode: every commit in the envelope ALSO inherits the
      // branch's ticket targets, even when its own message carries no code.
      if (connection.linkMode === "branch") {
        for (const target of branchTargets) {
          linkValues.push({
            id: crypto.randomUUID(),
            projectId: connection.projectId,
            connectionId: connection.id,
            targetType: target.kind,
            targetId: target.id,
            gitEntityType: "commit",
            gitEntityId: c.id,
            linkSource: "branch_name",
            createdAt: now,
          });
        }
      }
    }
  }

  // Chunked for the same D1 bound-parameter-cap reason as the commit insert
  // above (9 columns/row).
  for (const rows of chunk(linkValues, WORK_LINKS_INSERT_CHUNK)) {
    statements.push(
      db
        .insert(vcsWorkLinks)
        .values(rows)
        // The unique index dedupes overlap between a commit_msg link and an
        // inherited branch_name link for the same (commit, target) pair.
        .onConflictDoNothing({
          target: [
            vcsWorkLinks.gitEntityType,
            vcsWorkLinks.gitEntityId,
            vcsWorkLinks.targetType,
            vcsWorkLinks.targetId,
          ],
        }),
    );
  }

  // --- 5. One collapsed activity row, only when there's something new to
  //        report (branch_delete and no-op replays emit nothing). -----------
  let notificationHead: { id: string; authorUserId: string | null } | null = null;
  if (newCommits.length > 0) {
    const head = newCommits[newCommits.length - 1];
    const authorUserId = head.authorEmail
      ? (userIdByEmail.get(head.authorEmail.toLowerCase()) ?? null)
      : null;
    const n = newCommits.length;
    notificationHead = { id: head.id, authorUserId };

    statements.push(
      db.insert(projectActivity).values(
        toActivityRow({
          ownerId: authorUserId ?? ctx.botUserId,
          projectId: connection.projectId,
          entityType: "commit",
          entityId: head.id,
          action: "created",
          label: `${n} commit${n === 1 ? "" : "s"} pushed to ${envelope.ref}`,
          detail: head.message.split("\n")[0]?.slice(0, 200) ?? null,
          createdAt: now,
        }),
      ),
    );
  }

  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  // --- 6. Notifications (spec §1.3 step 5 / §1.8) — outside the atomic batch;
  //        idempotent in practice because the webhook route's delivery dedup
  //        (and this function's own upsert idempotency) already gate replays.
  //        Suppressed for backfill/history-import callers: since every
  //        backfilled sha is "new" to ingest(), notifying would otherwise
  //        fan out a "N commits pushed" notification to every project member
  //        per backfill page for months-old history.
  if (notificationHead && !opts.suppressNotifications) {
    const recipientIds = await getProjectRecipientIds(db, connection.projectId);
    const n = newCommits.length;
    const notificationInputs: NotificationInput[] = recipientIds.map((recipientId) => ({
      recipientId,
      actorId: notificationHead!.authorUserId,
      type: "vcs_commits_pushed",
      tone: "default",
      title: `${n} new commit${n === 1 ? "" : "s"} pushed`,
      body: `${envelope.ref} · ${connection.owner}/${connection.repo}`,
      href: `/projects/${connection.projectId}/git`,
      entityType: "commit",
      entityId: notificationHead.id,
    }));
    await createNotifications(db, notificationInputs);
  }

  return { commitsInserted: newCommits.length };
}
