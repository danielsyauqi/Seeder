// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Bounded backfill (spec §1.5) — fetches recent branches/commits via the
// provider's REST API using the connection's stored PAT, and replays them
// through `ingest()` as synthetic push envelopes so the exact same
// upsert+link path (idempotent commit upsert, monotonic ref guard, link-mode
// inheritance) is reused rather than duplicated here. Runs on connect and on
// "Sync now" (lib/services/vcs.ts `syncNow`).
//
// Page-capped so one invocation stays well under a Workers subrequest/CPU
// budget; `vcs_refs.backfill_cursor` (next page to fetch) lets a later call
// resume rather than re-walking history it already has. Degrades gracefully
// (returns `degraded: true`, never throws) when the provider API is
// unreachable or the PAT can't be decrypted — the connection keeps working via
// webhook-only sync either way.
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { vcsCommits, vcsRefs, type VcsConnection } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto/secrets";
import { VCS_BOT_USER_ID } from "@/lib/services/vcs/constants";
import { ingest } from "@/lib/services/vcs";
import type { NormalizedCommit, NormalizedEnvelope } from "@/lib/services/vcs/types";

type DbClient = ReturnType<typeof getDb>;

const PER_PAGE = 50;
// Total pages fetched across ALL branches in one invocation — keeps one
// "Sync now" / connect-time backfill well under Workers' cpu_ms/subrequest
// limits regardless of how many branches the repo has.
const MAX_PAGES_PER_INVOCATION = 5;
const MAX_BRANCHES = 25;

// `vcs_refs.backfill_cursor` stores a page number while the initial deep
// history walk for a branch is still in progress, and this sentinel once
// it's done. GitHub/GitLab's commit-list APIs page newest-first, so a
// strictly-forward numeric cursor that never resets would walk past page 1
// forever and could never see new commits again — including the truncated
// tail of a >20-commit webhook push (GitHub caps push commits[] at 20; the
// spec relies on backfill to heal that gap). Once the walk is DONE, every
// subsequent backfill instead restarts at page 1 and walks forward only
// until it hits a page of entirely-already-known shas (see `countKnownShas`
// below) — the idempotent-upsert boundary above which there's nothing left
// to heal.
const DONE_CURSOR = "done";

export type BackfillResult = {
  branchesSeen: number;
  pagesFetched: number;
  commitsIngested: number;
  degraded: boolean;
};

const DEGRADED: BackfillResult = {
  branchesSeen: 0,
  pagesFetched: 0,
  commitsIngested: 0,
  degraded: true,
};

function apiBase(connection: VcsConnection): string {
  if (connection.provider === "github" || connection.provider === "gitea") {
    return connection.baseUrl
      ? `${connection.baseUrl.replace(/\/$/, "")}/api/v3`
      : "https://api.github.com";
  }
  return connection.baseUrl
    ? `${connection.baseUrl.replace(/\/$/, "")}/api/v4`
    : "https://gitlab.com/api/v4";
}

// --- GitHub -------------------------------------------------------------------

type GitHubBranchRow = { name: string };
type GitHubCommitRow = {
  sha: string;
  html_url: string;
  commit?: { message?: string; author?: { name?: string; email?: string; date?: string } };
  author?: { login?: string } | null;
};

function mapGitHubCommit(row: GitHubCommitRow): NormalizedCommit {
  return {
    sha: row.sha,
    message: row.commit?.message ?? "",
    url: row.html_url,
    authorName: row.commit?.author?.name,
    authorEmail: row.commit?.author?.email,
    authorUsername: row.author?.login ?? undefined,
    committedAt: row.commit?.author?.date ? Date.parse(row.commit.author.date) : undefined,
  };
}

async function fetchGitHubBranches(connection: VcsConnection, token: string): Promise<string[]> {
  const url = `${apiBase(connection)}/repos/${connection.owner}/${connection.repo}/branches?per_page=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub branches fetch failed: ${res.status}`);
  const rows = (await res.json()) as GitHubBranchRow[];
  return rows.map((row) => row.name);
}

async function fetchGitHubCommitPage(
  connection: VcsConnection,
  token: string,
  branch: string,
  page: number,
): Promise<NormalizedCommit[]> {
  const url =
    `${apiBase(connection)}/repos/${connection.owner}/${connection.repo}/commits` +
    `?sha=${encodeURIComponent(branch)}&per_page=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub commits fetch failed: ${res.status}`);
  const rows = (await res.json()) as GitHubCommitRow[];
  return rows.map(mapGitHubCommit);
}

// --- GitLab ---------------------------------------------------------------

type GitLabBranchRow = { name: string };
type GitLabCommitRow = {
  id: string;
  message?: string;
  title?: string;
  web_url: string;
  author_name?: string;
  author_email?: string;
  committed_date?: string;
};

function mapGitLabCommit(row: GitLabCommitRow): NormalizedCommit {
  return {
    sha: row.id,
    message: row.message ?? row.title ?? "",
    url: row.web_url,
    authorName: row.author_name,
    authorEmail: row.author_email,
    authorUsername: undefined,
    committedAt: row.committed_date ? Date.parse(row.committed_date) : undefined,
  };
}

function gitlabProjectPath(connection: VcsConnection): string {
  return encodeURIComponent(`${connection.owner}/${connection.repo}`);
}

async function fetchGitLabBranches(connection: VcsConnection, token: string): Promise<string[]> {
  const url = `${apiBase(connection)}/projects/${gitlabProjectPath(connection)}/repository/branches?per_page=100`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!res.ok) throw new Error(`GitLab branches fetch failed: ${res.status}`);
  const rows = (await res.json()) as GitLabBranchRow[];
  return rows.map((row) => row.name);
}

async function fetchGitLabCommitPage(
  connection: VcsConnection,
  token: string,
  branch: string,
  page: number,
): Promise<NormalizedCommit[]> {
  const url =
    `${apiBase(connection)}/projects/${gitlabProjectPath(connection)}/repository/commits` +
    `?ref_name=${encodeURIComponent(branch)}&per_page=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!res.ok) throw new Error(`GitLab commits fetch failed: ${res.status}`);
  const rows = (await res.json()) as GitLabCommitRow[];
  return rows.map(mapGitLabCommit);
}

// --- Dispatch ---------------------------------------------------------------

async function fetchBranches(connection: VcsConnection, token: string): Promise<string[]> {
  return connection.provider === "gitlab"
    ? fetchGitLabBranches(connection, token)
    : fetchGitHubBranches(connection, token);
}

async function fetchCommitPage(
  connection: VcsConnection,
  token: string,
  branch: string,
  page: number,
): Promise<NormalizedCommit[]> {
  return connection.provider === "gitlab"
    ? fetchGitLabCommitPage(connection, token, branch, page)
    : fetchGitHubCommitPage(connection, token, branch, page);
}

async function touchBackfillCursor(
  db: DbClient,
  connection: VcsConnection,
  branchName: string,
  cursor: string,
  backfilledAt: Date,
) {
  await db
    .update(vcsRefs)
    .set({ backfillCursor: cursor, backfilledAt })
    .where(and(eq(vcsRefs.connectionId, connection.id), eq(vcsRefs.name, branchName)));
}

/** How many of `shas` are already recorded for this connection — used to
 * detect the "caught up" boundary once the initial deep walk is DONE, so a
 * page-1-forward heal pass knows where to stop without re-walking the whole
 * branch every time. */
async function countKnownShas(
  db: DbClient,
  connectionId: string,
  shas: string[],
): Promise<number> {
  if (!shas.length) return 0;
  const rows = await db
    .select({ sha: vcsCommits.sha })
    .from(vcsCommits)
    .where(and(eq(vcsCommits.connectionId, connectionId), inArray(vcsCommits.sha, shas)));
  return rows.length;
}

/**
 * Runs a bounded backfill pass for one connection. Never throws — provider
 * outages / bad tokens degrade to `{ degraded: true }` so the caller (connect
 * flow, "Sync now") can surface "history unavailable" without failing the
 * whole request; webhook-driven sync is unaffected either way.
 */
export async function backfillConnection(
  db: DbClient,
  connection: VcsConnection,
): Promise<BackfillResult> {
  if (connection.provider === "gitea") {
    // Gitea isn't offered in the connect wizard yet (spec §1.1a) and its REST
    // pagination shape isn't covered by this spec — degrade rather than guess
    // at an API contract. Webhook sync still works via the GitHub-shaped
    // adapter registered in lib/services/vcs/adapters.ts.
    return DEGRADED;
  }

  let token: string;
  try {
    token = await decryptSecret(connection.accessTokenEnc);
  } catch (error) {
    console.error("vcs backfill: failed to decrypt access token", error);
    return DEGRADED;
  }

  let branches: string[];
  try {
    branches = (await fetchBranches(connection, token)).slice(0, MAX_BRANCHES);
  } catch (error) {
    console.error("vcs backfill: failed to list branches", error);
    return DEGRADED;
  }

  let pagesFetched = 0;
  let commitsIngested = 0;
  let degraded = false;

  for (const branchName of branches) {
    if (pagesFetched >= MAX_PAGES_PER_INVOCATION) break;

    const [existingRef] = await db
      .select({ backfillCursor: vcsRefs.backfillCursor })
      .from(vcsRefs)
      .where(and(eq(vcsRefs.connectionId, connection.id), eq(vcsRefs.name, branchName)))
      .limit(1);
    const cursorValue = existingRef?.backfillCursor ?? null;
    const deepWalkDone = cursorValue === DONE_CURSOR;

    // While the initial full-history walk is still in progress, resume from
    // the stored page. Once it's DONE, always restart at page 1 (the
    // newest-first API's tip) so new commits and truncated-push gaps get
    // healed on every sync — see the DONE_CURSOR comment above.
    let page = deepWalkDone ? 1 : cursorValue ? Number(cursorValue) : 1;
    if (!Number.isFinite(page) || page < 1) page = 1;

    while (pagesFetched < MAX_PAGES_PER_INVOCATION) {
      let commits: NormalizedCommit[];
      try {
        commits = await fetchCommitPage(connection, token, branchName, page);
      } catch (error) {
        console.error(`vcs backfill: failed to fetch commits for ${branchName}`, error);
        degraded = true;
        break;
      }
      pagesFetched += 1;

      if (commits.length === 0) {
        await touchBackfillCursor(db, connection, branchName, DONE_CURSOR, new Date());
        break;
      }

      // Once caught up, stop as soon as a page is entirely shas we already
      // have — newest-first pagination means there's nothing further back
      // left to heal, and idempotent upserts make it safe to check before
      // ingesting rather than after.
      if (deepWalkDone) {
        const knownCount = await countKnownShas(
          db,
          connection.id,
          commits.map((c) => c.sha),
        );
        if (knownCount === commits.length) break;
      }

      // Provider commit-list APIs return newest-first; reverse to
      // oldest-first so ingest()'s `head = newCommits[newCommits.length -
      // 1]` convention (which matches webhook push payload ordering) picks
      // the newest commit of the page, not the oldest.
      const orderedCommits = [...commits].reverse();
      const head = orderedCommits[orderedCommits.length - 1];

      const envelope: NormalizedEnvelope = {
        provider: connection.provider,
        event: "push",
        deliveryId: `backfill:${connection.id}:${branchName}:${page}`,
        ref: branchName,
        headSha: head?.sha,
        pushTimestamp: head?.committedAt ?? Date.now(),
        commits: orderedCommits,
      };

      await ingest(
        db,
        { kind: "system", botUserId: VCS_BOT_USER_ID, projectId: connection.projectId },
        connection,
        envelope,
        { suppressNotifications: true }, // history import — don't fan out "commits pushed" to every member
      );
      commitsIngested += commits.length;

      if (commits.length < PER_PAGE) {
        // Reached the actual end of this branch's history.
        await touchBackfillCursor(db, connection, branchName, DONE_CURSOR, new Date());
        break;
      }
      if (!deepWalkDone) {
        // Only persist forward progress while still doing the initial deep
        // walk — once DONE, the cursor stays DONE and every sync restarts
        // at page 1.
        await touchBackfillCursor(db, connection, branchName, String(page + 1), new Date());
      }
      page += 1;
    }
  }

  return { branchesSeen: branches.length, pagesFetched, commitsIngested, degraded };
}
