# VCS webhook fixtures

Canonical webhook **payload bodies** for the VCS Sync integration tests (see
`docs/vcs-sync-phase-0-1-spec.md`, §1.9). Field names/shapes are based on the official GitHub and
GitLab webhook documentation (verified via Context7 / WebFetch against the live docs on
2026-07-10) — nothing here is invented. Values (IDs, SHAs, emails, org/repo names) are synthetic.

These files are **request bodies only**. A real delivery also carries the HTTP headers documented
below, which are not part of the JSON — integration tests must set them explicitly (and, for
GitHub, compute a real HMAC over the exact raw bytes of the fixture file — do not re-serialize the
parsed JSON, or the signature will be computed over different bytes than what was verified).

## Files

| File | Provider | Event | Notes |
|---|---|---|---|
| `github-push.json` | GitHub | `push` | 3 commits: `SEEDER-123: fix login` (task), `SEEDER-CR-45 adjust copy` (request), `wip` (uncoded). `ref` is `refs/heads/feature/seeder-123-login` — exercises branch-name linking (case-insensitive slug match) alongside commit-message linking. |
| `github-create-branch.json` | GitHub | `create` (`ref_type: "branch"`) | New branch `feature/seeder-210-signup`. No commit list — `create` events don't carry one. |
| `github-delete-branch.json` | GitHub | `delete` (`ref_type: "branch"`) | Deletes `feature/seeder-150-old` — exercises `vcs_refs.state='deleted'`. |
| `gitlab-push.json` | GitLab | Push Hook (`object_kind: "push"`) | 4 commits: `SEEDER-123: fix login`, `SEEDER-CR-45 adjust copy`, `wip`, and one mentioning `OTHER-9` (wrong project slug — must be rejected by `parseTicketRefs`, since the fixture's project slug is `SEEDER`). `before`/`after` are both real SHAs (ordinary push, not a branch lifecycle event). |
| `gitlab-branch-create.json` | GitLab | Push Hook | `before` is 40 zeros (`0000…0000`) — GitLab's signal for "this push created the ref" per the branch-lifecycle rule in §1.1b. Carries 1 commit. |
| `gitlab-branch-delete.json` | GitLab | Push Hook | `after` is 40 zeros — GitLab's signal for "this push deleted the ref". `commits: []`, `total_commits_count: 0`. |

All fixtures use project slug `SEEDER` (matches `lib/codes.ts` `SLUG_PATTERN` and the spec's own
examples), so `parseTicketRefs(text, "SEEDER")` is the function under test against every commit
message here.

## Headers a real delivery carries

Only the request **body** is captured in these fixtures. Reconstruct headers per provider as
follows when POSTing a fixture to the webhook route in tests.

### GitHub

Source: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
and [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

| Header | Value | Notes |
|---|---|---|
| `X-Hub-Signature-256` | `sha256=<hex>` | HMAC-SHA256 hex digest of the **raw request body bytes**, keyed with the webhook secret. "The hash signature always starts with `sha256=`." Compare with a timing-safe comparison (`crypto.subtle.verify`, `crypto.timingSafeEqual`), never `==`/`===`. |
| `X-GitHub-Delivery` | GUID | "A globally unique identifier (GUID) to identify the event." Used for delivery dedup (`vcs_deliveries.delivery_id`). |
| `X-GitHub-Event` | `push` / `create` / `delete` | Matches the fixture filename's event: `github-push.json` → `push`, `github-create-branch.json` → `create`, `github-delete-branch.json` → `delete`. |
| `X-GitHub-Hook-ID` | numeric string | Identifies the webhook config; not used by the ingest path. |
| `Content-Type` | `application/json` | Required so the raw body is exactly the fixture's bytes. |

### GitLab

Source: [Webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/) and
[Webhooks — secret token](https://docs.gitlab.com/user/project/integrations/webhooks/).

| Header | Value | Notes |
|---|---|---|
| `X-Gitlab-Token` | plaintext secret | GitLab's (legacy) secret-token scheme echoes the configured secret **verbatim** in this header — no HMAC. Per the docs: "The secret token only provides a plain-text value in a header, which offers weaker security guarantees." Compare via constant-time digest comparison (`crypto.subtle.digest` both sides), never a raw `===` on attacker-controlled-length strings. |
| `X-Gitlab-Event-UUID` | UUID | "Unique ID for non-recursive webhooks." Used for delivery dedup, same role as GitHub's `X-GitHub-Delivery`. |
| `X-Gitlab-Event` | `Push Hook` | Literal string `"Push Hook"` (not `"push"` — that's the *body's* `event_name`/`object_kind` field). All six GitLab-relevant scenarios here (ordinary push, branch create, branch delete) arrive as this same event; the lifecycle is inferred from `before`/`after` being all-zeros, per §1.1b. |
| `Content-Type` | `application/json` | |

## Regenerating / extending

If new fixtures are added, keep field names byte-for-byte matched to the official docs above —
re-verify with Context7 (`/octokit/webhooks`, `/github/docs`) or WebFetch against
`docs.github.com`/`docs.gitlab.com` rather than relying on memory, since both providers evolve
these payloads.
