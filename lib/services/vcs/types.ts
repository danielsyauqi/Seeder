// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import type { Viewer } from "@/lib/auth-server";

export type NormalizedCommit = {
  sha: string;
  message: string;
  url: string;
  authorName?: string;
  authorEmail?: string;
  authorUsername?: string;
  committedAt?: number;
};

export type NormalizedEnvelope = {
  provider: "gitea" | "github" | "gitlab";
  event: "push" | "branch_create" | "branch_delete";
  deliveryId: string;
  ref: string; // branch name (refs/heads/x normalized to x)
  headSha?: string;
  pushTimestamp: number; // for the monotonic ref guard
  commits: NormalizedCommit[];
  refUrl?: string;
};

export interface ProviderAdapter {
  sigHeader: string; // e.g. "x-gitea-signature"
  deliveryHeader: string; // e.g. "x-gitea-delivery"
  verify(rawBody: string, secret: string, headerSig: string): Promise<boolean>;
  parse(headers: Headers, rawBody: string): NormalizedEnvelope;
}

// Actor context — discriminated union. The service branches on `kind`. The
// "viewer" arm carries the repo's real Viewer type (lib/auth-server.ts), the
// shape server actions get via `requireViewer()`. Capability gates (e.g.
// canAdministerProject) run against `viewer.id`/`viewer.role`.
export type VcsActor =
  | { kind: "viewer"; viewer: Viewer } // gated
  | { kind: "system"; botUserId: string; projectId: string }; // webhook only
