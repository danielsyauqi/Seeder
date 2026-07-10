// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Provider-adapter registry (spec §1.3/§1.4). Keyed by the `provider` route
// param (app/api/integrations/[provider]/webhook/[connectionId]/route.ts) AND
// by `vcs_connections.provider`, so both must agree with `vcsProviderValues`
// in lib/db/schema.ts. 'gitea' is registered against the GitHub-shaped
// adapter (Gitea's push/create/delete payloads and X-Hub-Signature-256 scheme
// are GitHub-compatible — see lib/services/vcs/github.ts) even though it is
// not yet offered in the connection wizard (spec §1.1a) — wiring it up later
// is a wizard-list change, not an adapter change.
import type { VcsProvider } from "@/lib/db/schema";
import { giteaAdapter, githubAdapter } from "@/lib/services/vcs/github";
import { gitlabAdapter } from "@/lib/services/vcs/gitlab";
import type { ProviderAdapter } from "@/lib/services/vcs/types";

export const ADAPTERS: Record<VcsProvider, ProviderAdapter> = {
  github: githubAdapter,
  gitlab: gitlabAdapter,
  gitea: giteaAdapter,
};
