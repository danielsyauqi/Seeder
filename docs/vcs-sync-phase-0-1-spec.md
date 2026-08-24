# VCS Sync — Phase 0 + Phase 1 Build Spec (GitHub/GitLab MVP)

**Audience:** the implementing session (Sonnet). Execute this in order; do not re-architect.
Where this spec gives code, use it. Where it says "match `<file>`", read that file and copy its
conventions exactly. Ask only if a step contradicts the actual code.

**Goal:** sync Git commits & branches from a GitHub or GitLab repo into a Seeder project, link them to
tasks/requests by ticket code (`SEEDER-123` / `SEEDER-CR-45`), and show them in the activity feed, a task
Development panel, and a new project **Git** tab. Link-only (no status changes yet). Must run on Cloudflare
Workers **and** `RUNTIME=node`.

> **Rev 2 (2026-07-10).** Changes from rev 1: (a) MVP providers are **GitHub + GitLab** instead of
> Gitea-first — the GitHub adapter is webhook-compatible with Gitea, so Gitea slots in later by adding it
> to the wizard's provider list; (b) the connect form is now a 3-step **setup wizard**; (c) new
> per-connection **link mode** chosen in the wizard: `branch` (branch-name linking — a branch whose name
> carries a ticket code links itself *and* every commit pushed to it) vs `ticket` (purely ticket ID —
> commits link only via codes in their own messages). Everything else from rev 1 stands.

---

## 0. Locked decisions (do not revisit)

- **Providers (MVP):** **GitHub + GitLab**, both selectable in the wizard. Everything goes through the
  provider-adapter seam. Gitea is NOT in the wizard yet, but keep `'gitea'` in the DB CHECK and the
  `ADAPTERS` map pointing at the GitHub-compatible verifier — Gitea sends `X-Hub-Signature-256` and a
  GitHub-shaped push payload, so enabling it later is a wizard-list change, not an adapter.
- **Auth:** read-scope **PAT** per provider, entered by the user. GitHub: fine-grained PAT with
  Contents:read + Metadata:read (or classic `repo` read). GitLab: PAT with `read_api`. **Manual** webhook
  registration (Seeder shows the receiver URL + secret; user pastes into the repo's webhook settings).
  No auto-registration, no OAuth apps in MVP.
- **Connection scope:** **per-project** (FK `projectId`, gated `canAdministerProject`).
- **Encryption:** single global `VCS_ENCRYPTION_KEY`, AES-GCM, fresh IV per record, `keyVersion` column reserved
  for rotation. Fail-closed like `BETTER_AUTH_SECRET`.
- **Linking:** parse ticket codes from commit messages **and** branch names. Link **both** tasks and requests.
  **No status automation** in MVP (that's Phase 3, and task-only when it lands).
- **Link mode (per connection, chosen in the wizard):**
  - `branch` — branch-name linking. A branch named e.g. `feature/SEEDER-123-login` links the ref to
    SEEDER-123 **and** every commit pushed to that branch inherits the link (`link_source='branch_name'`),
    even when the commit message carries no code. Commit-message codes still link on top.
  - `ticket` — purely ticket ID. Commits link **only** via codes in their own messages; a coded branch name
    still links the ref itself, but commits do not inherit it.
  Both modes use the same parser (§1.2); the mode only changes what `ingest` attaches (§1.3 step 3).
  This is about `vcs_refs` linking ONLY — never Seeder's internal board `branches` entity.
- **Async:** synchronous in-request path only. No Queues/DO/Cron (Phase 4, Workers-only).

---

## 1. Repo conventions (verified — follow exactly)

- IDs: `TEXT` UUID. Timestamps: `INTEGER` ms, default `(unixepoch() * 1000)`. Booleans: `INTEGER`.
- Migrations: `migrations/NNNN_name.sql`, sequential. **Latest is `0037`**, so ours are `0038`, `0039`.
  Apply with `npm run db:migrate:local` (wrangler `--local`), `db:migrate:remote`, and node via
  `scripts/migrate-node.ts`. SQLite can't ALTER a CHECK → rebuild-table pattern (see `0037`).
- Drizzle schema: `lib/db/schema.ts`. Enum-ish app lists live here (e.g. `activityEntityValues`).
- DB access: `lib/db/index.ts` → `getDb()` (returns drizzle). Batch writes: `db.batch([...])`.
- Services: `lib/services/*.ts` (business logic + authz). Reads: `lib/data.ts`. Server Actions: `lib/actions.ts`.
- Activity: `lib/activity.ts` — `toActivityRow(input)`, `logProjectActivity(db, input)`,
  `logProjectActivities(db, inputs[])`. `ActivityInput` shape is defined at the top of that file — match it.
- Codes: `lib/codes.ts` — `SLUG_PATTERN = /^[A-Z0-9]{2,10}$/`, `formatTaskCode(...)`, `formatRequestCode(...)`.
- Env: `lib/env.ts` → `serverEnv` object; fail-closed throw pattern at lines 49-59.
- Authz: `lib/authz.ts` — `assertProjectCapability` / capability checks. Route session-less pattern:
  `export const dynamic = "force-dynamic"` (see `app/api/mcp/route.ts`). Route params are **async**:
  `type Ctx = { params: Promise<{...}> }` then `const {...} = await context.params` (see
  `app/api/client/[token]/uploads/[...path]/route.ts`).
- Tests: **vitest** (`npm test`). Gates before done: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.

---

## PHASE 0 — Foundations (~3–4 days)

### 0.1 Encryption helper — `lib/crypto/secrets.ts` (NEW)

Web Crypto is portable across Workers and Node 24. Store as `v<ver>:<ivB64>:<ctB64>`.

```ts
import { serverEnv } from "@/lib/env";

const KEY_VERSION = 1;
let keyPromise: Promise<CryptoKey> | null = null;

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const raw = fromB64(serverEnv.vcsEncryptionKey); // add to serverEnv (0.2)
    if (raw.length !== 32) throw new Error("VCS_ENCRYPTION_KEY must decode to 32 bytes");
    keyPromise = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return keyPromise;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh per record
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `v${KEY_VERSION}:${b64(iv)}:${b64(ct)}`;
}

export async function decryptSecret(stored: string): Promise<string> {
  const [, ivB64, ctB64] = stored.split(":"); // keyVersion routing when >1 key exists
  const key = await getKey();
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, fromB64(ctB64));
  return new TextDecoder().decode(pt);
}
```

Unit test: round-trip; wrong-key/tampered ciphertext throws; two encrypts of the same input differ (IV).

### 0.2 Env — `lib/env.ts`

Add `VCS_ENCRYPTION_KEY` (base64 of 32 random bytes). Fail-closed **only in production** (mirror the
`betterAuthUrl && secret === DEFAULT` guard): if `betterAuthUrl` is set (real deployment) and
`VCS_ENCRYPTION_KEY` is missing, throw. Locally it may be unset until the feature is used — but the crypto
helper throws on use, which is the safety net. Export as `serverEnv.vcsEncryptionKey`. Document in
`.dev.vars.example` and `.env.example`: generate with `openssl rand -base64 32`, set via
`wrangler secret put VCS_ENCRYPTION_KEY`.

### 0.3 Migration `0038_vcs_core.sql` (NEW) — five tables

Follow the id/timestamp/boolean conventions. FKs cascade on `projects`/`vcs_connections` delete.
**`vcs_refs` is deliberately separate from the internal `branches` table** — a deleted remote branch sets
`state='deleted'`, never cascades to tasks.

```sql
CREATE TABLE "vcs_connections" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL CHECK ("provider" IN ('gitea','github','gitlab')),
  "base_url" TEXT,                      -- e.g. https://gitlab.com, GHE/self-managed base, https://git.alphv.com
  "owner" TEXT NOT NULL,
  "repo" TEXT NOT NULL,
  "remote_repo_id" TEXT,
  "default_branch" TEXT,
  "auth_type" TEXT NOT NULL DEFAULT 'pat' CHECK ("auth_type" IN ('pat','oauth','github_app')),
  "access_token_enc" TEXT NOT NULL,
  "refresh_token_enc" TEXT,
  "access_token_expires_at" INTEGER,
  "webhook_secret_enc" TEXT NOT NULL,
  "key_version" INTEGER NOT NULL DEFAULT 1,
  "link_mode" TEXT NOT NULL DEFAULT 'ticket' CHECK ("link_mode" IN ('branch','ticket')),
  "sync_mode" TEXT NOT NULL DEFAULT 'webhook' CHECK ("sync_mode" IN ('webhook','poll')),
  "last_reconciled_at" INTEGER,
  "created_by" TEXT REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX "vcs_connections_project_idx" ON "vcs_connections" ("project_id");

CREATE TABLE "vcs_deliveries" (
  "delivery_id" TEXT PRIMARY KEY NOT NULL,          -- provider header value
  "connection_id" TEXT NOT NULL REFERENCES "vcs_connections"("id") ON DELETE CASCADE,
  "received_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE "vcs_commits" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "connection_id" TEXT NOT NULL REFERENCES "vcs_connections"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "sha" TEXT NOT NULL,
  "message" TEXT,
  "author_name" TEXT,
  "author_email" TEXT,
  "author_username" TEXT,
  "author_user_id" TEXT REFERENCES "user"("id") ON DELETE SET NULL,
  "url" TEXT,
  "ref_name" TEXT,
  "committed_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX "vcs_commits_conn_sha_idx" ON "vcs_commits" ("connection_id","sha");
CREATE INDEX "vcs_commits_project_time_idx" ON "vcs_commits" ("project_id","committed_at");

CREATE TABLE "vcs_refs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "connection_id" TEXT NOT NULL REFERENCES "vcs_connections"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "ref_type" TEXT NOT NULL DEFAULT 'branch' CHECK ("ref_type" IN ('branch','tag')),
  "head_sha" TEXT,
  "last_event_at" INTEGER,               -- monotonic guard: only advance head when newer
  "backfill_cursor" TEXT,
  "backfilled_at" INTEGER,
  "state" TEXT NOT NULL DEFAULT 'open' CHECK ("state" IN ('open','merged','deleted')),
  "url" TEXT,
  "seeder_branch_id" TEXT REFERENCES "branches"("id") ON DELETE SET NULL, -- optional, non-destructive
  "deleted_at" INTEGER,
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX "vcs_refs_conn_name_idx" ON "vcs_refs" ("connection_id","name");

CREATE TABLE "vcs_work_links" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "connection_id" TEXT NOT NULL REFERENCES "vcs_connections"("id") ON DELETE CASCADE,
  "target_type" TEXT NOT NULL CHECK ("target_type" IN ('task','request')),
  "target_id" TEXT NOT NULL,
  "git_entity_type" TEXT NOT NULL CHECK ("git_entity_type" IN ('commit','ref')),
  "git_entity_id" TEXT NOT NULL,
  "link_source" TEXT NOT NULL CHECK ("link_source" IN ('commit_msg','branch_name','manual')),
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX "vcs_work_links_uniq_idx"
  ON "vcs_work_links" ("git_entity_type","git_entity_id","target_type","target_id");
CREATE INDEX "vcs_work_links_target_idx" ON "vcs_work_links" ("target_type","target_id");
```

> Do **not** FK `target_id` onto tasks/requests (no cascade) — links are soft. Prune on entity delete later.

### 0.4 Migration `0039_activity_entity_add_commit.sql` (NEW)

**Clone `0037` verbatim** (create `_new`, `INSERT..SELECT`, `DROP`, `RENAME`, recreate the 3 indexes),
changing only the CHECK to add `'commit'`:
`CHECK ("entity_type" IN ('project','request','task','note','branch','commit'))`.
Then add `"commit"` to `activityEntityValues` in `lib/db/schema.ts` (~line 34).

### 0.5 Drizzle schema — `lib/db/schema.ts`

Add table definitions for the five tables above (match the column names/types; the repo uses snake_case DB
columns with camelCase TS fields — copy an existing table's style, e.g. the `branches` table from 0030).

### 0.6 "Git integration" bot user

`project_activity.owner_id` is `NOT NULL REFERENCES user(id) ON DELETE CASCADE`. Commits from authors who
aren't Seeder members must attribute to a permanent bot user.
- Insert one `user` row in `0038` with a **fixed sentinel id** `"vcs-bot"` (or a UUID constant exported from
  `lib/services/vcs/constants.ts`), email `git-integration@seeder.local`, name `"Git integration"`,
  `email_verified` true, matching the `user` table columns. **No `account` row** → it can never sign in.
- **Guard deletion:** in the admin user-delete path (search "delete" in `lib/actions.ts` / the admin user
  management added recently), refuse to delete this id.
- Export `VCS_BOT_USER_ID` for the service to use as the activity `ownerId` fallback.

### 0.7 Provider-adapter seam + actor context — `lib/services/vcs/types.ts` (NEW)

```ts
export type NormalizedCommit = {
  sha: string; message: string; url: string;
  authorName?: string; authorEmail?: string; authorUsername?: string; committedAt?: number;
};
export type NormalizedEnvelope = {
  provider: "gitea" | "github" | "gitlab";
  event: "push" | "branch_create" | "branch_delete";
  deliveryId: string;
  ref: string;              // branch name (refs/heads/x normalized to x)
  headSha?: string;
  pushTimestamp: number;    // for the monotonic ref guard
  commits: NormalizedCommit[];
  refUrl?: string;
};

export interface ProviderAdapter {
  sigHeader: string;                 // e.g. "x-gitea-signature"
  deliveryHeader: string;            // e.g. "x-gitea-delivery"
  verify(rawBody: string, secret: string, headerSig: string): Promise<boolean>;
  parse(headers: Headers, rawBody: string): NormalizedEnvelope;
}

// Actor context — discriminated union. The service branches on `kind`.
export type VcsActor =
  | { kind: "viewer"; viewer: /* the repo's Viewer type from lib/authz */ unknown } // gated
  | { kind: "system"; botUserId: string; projectId: string };                       // webhook only
```

**Phase 0 checkpoint:** migrations apply clean (`db:migrate:local`), `tsc`/`lint` pass, secrets round-trip test green.

---

## PHASE 1 — GitHub + GitLab MVP (~3–3.5 weeks)

### 1.1a GitHub adapter — `lib/services/vcs/github.ts` (NEW)

Headers: `sigHeader = "x-hub-signature-256"` (`sha256=<hex>`, HMAC-SHA256 over the raw body),
`deliveryHeader = "x-github-delivery"`, event name in `x-github-event`. Verify with constant-time
`crypto.subtle.verify`:

```ts
export async function verifyHmacSha256(rawBody: string, secret: string, hexSig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const sig = hexToBytes(hexSig.replace(/^sha256=/, ""));
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(rawBody));
}
```

`parse()`: normalize `refs/heads/main` → `main`; map `push` payloads to `NormalizedEnvelope`
(`commits[]`, `after` → headSha, `head_commit.timestamp` or now → pushTimestamp); `create`/`delete` events
(`ref_type: "branch"`) → `branch_create`/`branch_delete`. Note: GitHub caps push `commits[]` at 20 — MVP
tolerates it (idempotent upserts + backfill fill gaps).

Register the same adapter under `'gitea'` in the `ADAPTERS` map with `sigHeader = "x-hub-signature-256"`
(Gitea sends it too) and `deliveryHeader = "x-gitea-delivery"` — Gitea's push payload is GitHub-shaped.
Not exposed in the wizard yet.

### 1.1b GitLab adapter — `lib/services/vcs/gitlab.ts` (NEW)

GitLab is the outlier: **no HMAC**. It echoes the secret verbatim in `X-Gitlab-Token`, so
`sigHeader = "x-gitlab-token"` and `verify()` is a **constant-time string compare** of the header against
the stored secret (compare fixed-length SHA-256 digests of both via `crypto.subtle.digest`, never `===` on
raw strings of attacker-controlled length). `deliveryHeader = "x-gitlab-event-uuid"`.

`parse()` differences from GitHub:
- Only **Push Hook** events matter (`object_kind: "push"`); there are no separate create/delete events.
  Branch lifecycle is encoded in the SHAs: `before` all-zeros → `branch_create` (with commits),
  `after` all-zeros → `branch_delete`.
- `ref` is `refs/heads/x` (normalize the same way); `commits[]` caps at 20 with the real count in
  `total_commits_count` — tolerate, backfill fills gaps.
- Commit shape: `{ id, message, url, author: { name, email }, timestamp }` → map to `NormalizedCommit`.

### 1.2 Ticket parsing — `lib/services/vcs/parse.ts` (NEW)

```ts
const CODE_RE = /\b([A-Z0-9]{2,10})-(CR-)?(\d+)\b/gi;
export function parseTicketRefs(text: string, projectSlug: string) {
  const slug = projectSlug.toUpperCase();
  const seen = new Set<string>();
  const out: { kind: "task" | "request"; number: number }[] = [];
  for (const m of (text ?? "").matchAll(CODE_RE)) {
    if (m[1].toUpperCase() !== slug) continue;         // never cross-project
    const kind = m[2] ? "request" : "task";            // CR- parsed first
    const key = `${kind}:${m[3]}`;
    if (!seen.has(key)) { seen.add(key); out.push({ kind, number: Number(m[3]) }); }
  }
  return out;
}
```

Tests: matches `SEEDER-123` and `feature/seeder-123-x` (case-insensitive); `SEEDER-CR-45` → request;
`OTHER-9` (wrong slug) rejected; dedupes repeats.

### 1.3 Service — `lib/services/vcs.ts` (NEW)

Central logic, shared by actions/MCP/webhook. **Never import `getCloudflareContext` here** (keep it portable
— the caller passes `db`). Functions:
- `createConnection(viewerCtx, input)` — gate `canAdministerProject`; validate slug/owner/repo and
  `input.linkMode` (`'branch' | 'ticket'`, from the wizard); generate a webhook secret
  (`crypto.getRandomValues` → hex); `encryptSecret` both token + secret; insert row; return the connection
  **and** the receiver URL + plaintext secret **once** (for display).
- `ingest(db, systemCtx, connection, envelope)` — the webhook worker:
  1. upsert commits (`INSERT ... ON CONFLICT(connection_id,sha) DO NOTHING`), resolving `authorEmail → user.id`.
  2. upsert ref; advance `head_sha` **only if** `envelope.pushTimestamp > last_event_at` (monotonic guard);
     `branch_delete` → `state='deleted'`.
  3. linking, honoring `connection.linkMode`:
     - Parse the branch name with `parseTicketRefs(envelope.ref, project.slug)` → link the **ref** to those
       targets (`link_source='branch_name'`). Both modes do this.
     - Parse each commit message → link that **commit** (`link_source='commit_msg'`). Both modes.
     - **`linkMode='branch'` only:** every commit in the envelope ALSO inherits the branch's targets —
       insert a commit→target link with `link_source='branch_name'` for each. The unique index dedupes
       overlap with commit-message links, so use `ON CONFLICT DO NOTHING`.
     Resolve task/request ids via `lib/data.ts` lookups by project + number.
  4. emit **one** collapsed activity row: `logProjectActivities(db, [...])` with `entityType:'commit'`,
     `action:'created'`, label like `"3 commits pushed to main"`, `ownerId = resolvedAuthorUserId ?? VCS_BOT_USER_ID`.
     Batch commit+ref+link+activity writes in one `db.batch([...])`.
  5. `createNotifications(...)` "N new commits pushed" (idempotent because delivery dedup already gated us).
- `listCommits(viewerCtx, projectId, opts)` / `listCommitsForTask(viewerCtx, taskId)` — reads (or put reads in
  `lib/data.ts`, matching where task/branch reads live).
- `syncNow(viewerCtx, connectionId)` — triggers the bounded backfill (1.5).

The `system` actor **skips** capability gates but is constructed **only** inside the webhook route after HMAC
verification + connection→project resolution. No user-facing surface can pass a `system` context.

### 1.4 Webhook route — `app/api/integrations/[provider]/webhook/[connectionId]/route.ts` (NEW)

```ts
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ provider: string; connectionId: string }> };

export async function POST(request: Request, context: Ctx) {
  const { provider, connectionId } = await context.params;
  const adapter = ADAPTERS[provider];
  if (!adapter || !isUuid(connectionId)) return new Response(null, { status: 404 });

  const headerSig = request.headers.get(adapter.sigHeader);
  const deliveryId = request.headers.get(adapter.deliveryHeader);
  if (!headerSig || !deliveryId) return new Response(null, { status: 400 });

  const raw = await request.text();                       // BEFORE any parse
  const db = getDb();
  const conn = await loadConnectionById(db, connectionId); // + provider match
  if (!conn || conn.provider !== provider) return new Response(null, { status: 404 });

  const secret = await decryptSecret(conn.webhookSecretEnc);
  if (!(await adapter.verify(raw, secret, headerSig))) return new Response(null, { status: 401 });

  const fresh = await insertDeliveryOrIgnore(db, deliveryId, connectionId); // INSERT OR IGNORE
  if (!fresh) return new Response("duplicate", { status: 202 });

  try {
    const envelope = adapter.parse(request.headers, raw);
    await ingest(db, { kind: "system", botUserId: VCS_BOT_USER_ID, projectId: conn.projectId }, conn, envelope);
  } catch (e) {
    console.error("vcs ingest failed", e);               // don't 500 the forge into disabling us
  }
  return new Response("ok", { status: 202 });             // ack fast
}
```

Order is load-bearing: cheap header/id checks → raw body → verify → dedup → ingest → 202.

### 1.5 Bounded backfill

On connect and on "Sync now", page the provider REST API using the stored PAT (decrypt):
- **GitHub:** `GET /repos/{owner}/{repo}/branches`, then `GET /repos/{owner}/{repo}/commits?sha={branch}&per_page=…&page=…`
  (api.github.com, or `{base_url}/api/v3` for GHE; `Authorization: Bearer <pat>`).
- **GitLab:** `GET /projects/{id}/repository/branches`, then `GET /projects/{id}/repository/commits?ref_name={branch}&per_page=…&page=…`
  where `{id}` is URL-encoded `owner%2Frepo` (`{base_url}/api/v4`, default `https://gitlab.com`;
  `PRIVATE-TOKEN: <pat>`).

**Cap the page count** so one invocation stays under `cpu_ms: 30000` / subrequest budget; store
`backfill_cursor` + `backfilled_at` per ref so "Sync now" resumes. Reuse `ingest`'s upsert+link path
(including link-mode inheritance). If the provider API is unreachable, degrade to webhook-only (log it;
surface "history unavailable" in the UI).

### 1.6 Activity deep-links — `lib/data.ts`

Extend the `entityType → href` switch in **both** `listProjectActivity` (~line 2352) and
`buildRecentActivity` (~line 786): for `'commit'`, link to the stored `vcs_commits.url` (external absolute)
instead of an internal route. Add a color for the commit action in
`components/projects/activity-action-badge.tsx` (unknown actions currently render grey).

### 1.7 UI

- **Setup wizard** — under project settings (route segment `settings`), gated `canAdministerProject`.
  Three steps, one server action at the end (`createConnection` in `lib/actions.ts`):
  1. **Provider + repo:** provider picker (**GitHub | GitLab** — two cards/radio, no Gitea yet), base URL
     (prefilled `https://github.com` / `https://gitlab.com`, editable for GHE/self-managed), owner/repo, PAT
     (with a per-provider hint: GitHub fine-grained PAT Contents:read + Metadata:read; GitLab `read_api`).
  2. **Link mode:** the ONLY option in this step — two radio cards:
     - **"Use real branches"** (`branch`) — "A branch named `feature/{SLUG}-123-…` links itself and every
       commit on it to task {SLUG}-123, even without codes in commit messages."
     - **"Ticket ID only"** (`ticket`) — "Only commits that mention a ticket code (e.g. `{SLUG}-123: fix …`)
       get linked. Branch names still link the branch itself."
     Render the examples with the project's real slug. No other settings in the wizard.
  3. **Webhook:** after submit, show the **receiver URL**
     (`{BETTER_AUTH_URL}/api/integrations/{provider}/webhook/{id}`) + the generated **secret** with copy
     buttons and per-provider paste instructions — GitHub: Settings → Webhooks, content type
     `application/json`, secret, events **Push + Create + Delete**; GitLab: Settings → Webhooks, Secret
     token, trigger **Push events**.
  Link mode is editable later from the connection's settings row (plain `updateConnection` path, no wizard re-run).
- **Project Git tab** — new segment `app/(app)/projects/[projectId]/git/page.tsx` (siblings today:
  `board branches history notes requests settings`). List recent commits (sha, message, author, time, link)
  and connection status. Add the nav entry wherever those tabs/quick-links are defined
  (`components/projects/project-workspace.tsx` `ProjectOverviewQuickLinks`, and the project nav component).
  **Name it "Git" / "Code", not "Commits"** (the client board already renders a fake "commits" metaphor).
- **Task Development section** — on the task detail, a read-only list of linked commits/refs (query
  `vcs_work_links` by `('task', taskId)`).

### 1.8 MCP + notifications

- `lib/mcp/server.ts`: register a **read-only** `list-commits` tool (project + optional task filter). Connect/
  write tools are deferred.
- `lib/notifications.ts`: `createNotifications` "N new commits pushed" to project members (respect existing
  notification prefs); idempotency comes free from the delivery dedup.

### 1.9 Tests (vitest)

- Unit: `parse.ts` (cases in 1.2); `secrets.ts` round-trip; `verifyHmacSha256` against a known vector;
  `github.parse` + `gitlab.parse` envelope normalization (incl. GitLab zero-SHA create/delete); GitLab
  token compare rejects wrong/empty token; upsert idempotency (same sha twice → one row); monotonic guard
  (stale push doesn't regress head); link-mode inheritance (`branch` mode: uncoded commit on coded branch
  → linked with `link_source='branch_name'`; `ticket` mode: same push → ref linked, commit NOT linked).
- Integration: POST captured GitHub and GitLab push payloads to the route with valid auth →
  commits+links+activity written; invalid signature/token → 401; replayed delivery id → 202 + no duplicate
  side effects.

---

## Definition of done (Phase 1)

- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` all green.
- [ ] `db:migrate:local` applies 0038+0039; app boots on both default dev and `RUNTIME=node`.
- [ ] Live check: connect a real GitHub repo via the wizard, push a commit `SEEDER-<n> ...` → it appears on
      the task Development panel, the project Git tab, and the activity feed with an external deep-link.
- [ ] Live check (branch mode): push an **uncoded** commit to a branch named `feature/SEEDER-<n>-x` on a
      `branch`-mode connection → commit shows on the task; repeat on a `ticket`-mode connection → it doesn't.
- [ ] Deleting a remote branch flips `vcs_refs.state='deleted'` and touches **no** tasks.
- [ ] Verify with the `/verify` skill (drive the real flow, not just tests).

## Handoff guardrails for the implementer

- Keep `lib/services/vcs.ts` free of `getCloudflareContext` — portability depends on it.
- Don't reuse `create-branch` / `move-task-to-branch` semantics; real refs live only in `vcs_refs`.
- Verify HMAC over **raw bytes**, never re-serialized JSON.
- Match existing file style (naming, zod input validation, `db.batch`) — read the cited files first.
- Work phase-by-phase; pause at the Phase 0 checkpoint for review before Phase 1.
