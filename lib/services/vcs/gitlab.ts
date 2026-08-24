// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// GitLab provider adapter (spec §1.1b). GitLab is the outlier among VCS
// providers we support: it has no HMAC signature scheme. It echoes the
// configured webhook secret verbatim in the `X-Gitlab-Token` header, so
// `verify()` is a constant-time comparison rather than an HMAC check.
//
// Branch lifecycle isn't a separate event type like GitHub's create/delete —
// it's encoded in the push payload's before/after SHAs: 40 zeros means "this
// ref didn't exist before" (create) or "this ref doesn't exist after"
// (delete).

import type { NormalizedCommit, NormalizedEnvelope } from "@/lib/services/vcs/types";

const ZERO_SHA = "0000000000000000000000000000000000000000";

type GitLabCommit = {
  id: string;
  message: string;
  url: string;
  timestamp?: string;
  author?: {
    name?: string;
    email?: string;
  };
};

type GitLabPushHookPayload = {
  object_kind?: string;
  before?: string;
  after?: string;
  ref?: string;
  commits?: GitLabCommit[];
};

function normalizeRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function toNormalizedCommit(commit: GitLabCommit): NormalizedCommit {
  const committedAt = commit.timestamp ? Date.parse(commit.timestamp) : NaN;
  return {
    sha: commit.id,
    message: commit.message,
    url: commit.url,
    authorName: commit.author?.name,
    authorEmail: commit.author?.email,
    // GitLab's push payload commit objects carry no username field.
    authorUsername: undefined,
    committedAt: Number.isFinite(committedAt) ? committedAt : undefined,
  };
}

/**
 * Constant-time secret comparison for GitLab's `X-Gitlab-Token` scheme.
 *
 * GitLab has no HMAC — it just echoes the configured secret back verbatim.
 * Comparing the raw strings directly (`===`) would leak timing information
 * proportional to how many leading characters match, and would also leak
 * whether the lengths differ. To avoid both, we hash *both* the header value
 * and the stored secret with SHA-256 first (producing two fixed-length, 32
 * byte digests regardless of input length) and then compare those digests
 * byte-by-byte in constant time.
 */
async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function verify(
  _rawBody: string,
  secret: string,
  headerSig: string,
): Promise<boolean> {
  if (!headerSig) return false;
  const [headerDigest, secretDigest] = await Promise.all([sha256(headerSig), sha256(secret)]);
  return constantTimeEqual(headerDigest, secretDigest);
}

/**
 * Parses a GitLab webhook delivery body into a NormalizedEnvelope.
 *
 * Only Push Hook events (`object_kind: "push"`) are meaningful here — GitLab
 * doesn't send separate create/delete ref events the way GitHub does; branch
 * lifecycle is inferred from the before/after SHAs instead. Any other
 * `object_kind` is out of scope for VCS Sync and is skipped by returning
 * `null`.
 *
 * NOTE: this deviates from the `ProviderAdapter["parse"]` signature in
 * lib/services/vcs/types.ts, which currently declares a non-nullable
 * `NormalizedEnvelope` return. lib/services/vcs/github.ts (the sibling
 * adapter) is being written in parallel and wasn't present at the time this
 * file was written, so there was no established null/skip contract to match.
 * See the concerns note returned alongside this task for reconciliation
 * (likely: widen the interface to `NormalizedEnvelope | null`, or push the
 * "non-push event" filtering up into the webhook route so adapters only ever
 * see relevant deliveries).
 */
export function parse(headers: Headers, rawBody: string): NormalizedEnvelope | null {
  const payload = JSON.parse(rawBody) as GitLabPushHookPayload;

  if (payload.object_kind !== "push") return null;

  const before = payload.before ?? "";
  const after = payload.after ?? "";
  const ref = normalizeRef(payload.ref ?? "");
  const commits = (payload.commits ?? []).map(toNormalizedCommit);
  const deliveryId = headers.get("x-gitlab-event-uuid") ?? "";

  const isCreate = before === ZERO_SHA;
  const isDelete = after === ZERO_SHA;

  const latestCommitTimestamp = commits.reduce<number | undefined>((latest, commit) => {
    if (commit.committedAt === undefined) return latest;
    return latest === undefined ? commit.committedAt : Math.max(latest, commit.committedAt);
  }, undefined);
  const pushTimestamp = latestCommitTimestamp ?? Date.now();

  if (isDelete) {
    return {
      provider: "gitlab",
      event: "branch_delete",
      deliveryId,
      ref,
      headSha: undefined,
      pushTimestamp,
      commits: [],
    };
  }

  return {
    provider: "gitlab",
    event: isCreate ? "branch_create" : "push",
    deliveryId,
    ref,
    headSha: after,
    pushTimestamp,
    commits,
  };
}

export const gitlabAdapter = {
  sigHeader: "x-gitlab-token",
  deliveryHeader: "x-gitlab-event-uuid",
  verify,
  parse,
};
