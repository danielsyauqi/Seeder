// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import type { NormalizedCommit, NormalizedEnvelope } from "@/lib/services/vcs/types";

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies a GitHub/Gitea-style webhook signature: HMAC-SHA256 over the raw
 * request body bytes, hex-encoded, delivered in a header of the shape
 * `sha256=<hex>` (the `sha256=` prefix is optional here — callers may pass
 * the header value as-is). Uses `crypto.subtle.verify` for a constant-time
 * comparison; never re-derive the HMAC and compare with `===`, which leaks
 * timing information on attacker-controlled input.
 */
export async function verifyHmacSha256(
  rawBody: string,
  secret: string,
  hexSig: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = hexToBytes(hexSig.replace(/^sha256=/, ""));
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(rawBody));
}

/**
 * Decodes a hex string into bytes. Returns `null` (never throws) on
 * malformed input — empty, odd length, or containing non-hex characters —
 * so callers can treat it as "verification fails" rather than a crash.
 */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Payload shapes (only the fields we read — GitHub/Gitea payloads carry a lot
// more than this)
// ---------------------------------------------------------------------------

type GitHubCommitAuthor = {
  name?: string;
  email?: string;
  username?: string;
};

type GitHubCommit = {
  id: string;
  message: string;
  url: string;
  timestamp?: string;
  author?: GitHubCommitAuthor;
};

type GitHubPushPayload = {
  ref: string;
  after: string;
  deleted?: boolean;
  commits?: GitHubCommit[];
  head_commit?: GitHubCommit | null;
  repository?: { html_url?: string };
};

// GitHub sends a `push` event (deleted: true, after: 40 zeros, head_commit:
// null) ALONGSIDE a separate `delete` event when a branch is removed — a
// distinct delivery with its own delivery id, so the route's dedup-by-
// delivery-id doesn't stop it. Without handling it here, that push would be
// parsed as a normal push carrying a 40-zero head sha (see ZERO_SHA below,
// matching gitlab.ts's constant of the same name/purpose).
const ZERO_SHA = "0000000000000000000000000000000000000000";

type GitHubCreateDeletePayload = {
  ref: string;
  ref_type: "branch" | "tag";
  repository?: { html_url?: string };
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** `refs/heads/main` -> `main`; leaves already-bare names (create/delete payloads) untouched. */
function normalizeRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function mapCommit(commit: GitHubCommit): NormalizedCommit {
  return {
    sha: commit.id,
    message: commit.message,
    url: commit.url,
    authorName: commit.author?.name,
    authorEmail: commit.author?.email,
    authorUsername: commit.author?.username,
    committedAt: commit.timestamp ? new Date(commit.timestamp).getTime() : undefined,
  };
}

function parsePush(
  payload: GitHubPushPayload,
  provider: "github" | "gitea",
  deliveryId: string,
): NormalizedEnvelope | null {
  const ref = normalizeRef(payload.ref);

  // Branch-deletion push: GitHub also sends a `delete` event for this same
  // branch removal (handled below in parseGitHubShapedPayload), so let that
  // event own the lifecycle transition here rather than double-processing —
  // returning null skips ingest() for this delivery, exactly like a
  // non-branch create/delete or an unrecognized event.
  if (payload.deleted === true || payload.after === ZERO_SHA) {
    return null;
  }

  return {
    provider,
    event: "push",
    deliveryId,
    ref,
    headSha: payload.after,
    // GitHub caps `commits[]` at 20; head_commit.timestamp (falling back to
    // now) is still a faithful "when did this push land" signal for the
    // monotonic ref guard even when commits were truncated.
    pushTimestamp: payload.head_commit?.timestamp
      ? new Date(payload.head_commit.timestamp).getTime()
      : Date.now(),
    commits: (payload.commits ?? []).map(mapCommit),
    refUrl: payload.repository?.html_url ? `${payload.repository.html_url}/tree/${ref}` : undefined,
  };
}

/**
 * Shared parse logic for GitHub and Gitea (Gitea's push/create/delete
 * payloads and event header are GitHub-shaped — see `giteaAdapter` below).
 *
 * Contract: returns `NormalizedEnvelope | null`. `null` means "this delivery
 * has nothing for Seeder to ingest" — non-branch `create`/`delete` (i.e. tag
 * events, which carry `ref_type: "tag"`) and any event other than
 * `push`/`create`/`delete` (e.g. `ping`, `star`, `issues`, ...). The webhook
 * route (spec §1.4) must treat `null` as "skip `ingest()`, still ack 202" —
 * it is not an error.
 */
function parseGitHubShapedPayload(
  headers: Headers,
  rawBody: string,
  provider: "github" | "gitea",
  deliveryHeaderName: string,
): NormalizedEnvelope | null {
  const eventName = headers.get("x-github-event");
  const deliveryId = headers.get(deliveryHeaderName) ?? "";

  switch (eventName) {
    case "push": {
      const payload = JSON.parse(rawBody) as GitHubPushPayload;
      return parsePush(payload, provider, deliveryId);
    }
    case "create":
    case "delete": {
      const payload = JSON.parse(rawBody) as GitHubCreateDeletePayload;
      if (payload.ref_type !== "branch") return null; // tag create/delete — not ingested
      const ref = normalizeRef(payload.ref);
      return {
        provider,
        event: eventName === "create" ? "branch_create" : "branch_delete",
        deliveryId,
        ref,
        // create/delete payloads carry no timestamp of their own.
        pushTimestamp: Date.now(),
        commits: [],
        refUrl: payload.repository?.html_url ? `${payload.repository.html_url}/tree/${ref}` : undefined,
      };
    }
    default:
      return null; // unrecognized/irrelevant event — caller skips
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * Structurally compatible with `ProviderAdapter` (lib/services/vcs/types.ts)
 * except that `parse` is deliberately widened to `NormalizedEnvelope | null`
 * — see the doc comment on `parseGitHubShapedPayload` for the contract. Kept
 * as a factory so `githubAdapter` and `giteaAdapter` below share the exact
 * same `verify`/`parse` implementation and differ only in the headers they
 * read, matching how the two providers actually diverge on the wire.
 */
function makeGitHubShapedAdapter(provider: "github" | "gitea", deliveryHeaderName: string) {
  return {
    sigHeader: "x-hub-signature-256",
    deliveryHeader: deliveryHeaderName,
    verify: verifyHmacSha256,
    parse(headers: Headers, rawBody: string): NormalizedEnvelope | null {
      return parseGitHubShapedPayload(headers, rawBody, provider, deliveryHeaderName);
    },
  };
}

export const githubAdapter = makeGitHubShapedAdapter("github", "x-github-delivery");

/**
 * Gitea adapter — not yet exposed in the connection wizard (spec §1.1a); the
 * DB CHECK and ADAPTERS map already accommodate `'gitea'` so wiring it up
 * later is a wizard-list change, not an adapter change.
 */
export const giteaAdapter = makeGitHubShapedAdapter("gitea", "x-gitea-delivery");
