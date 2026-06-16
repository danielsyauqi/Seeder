# Seeder MCP Server — Implementation Plan

> Goal: let AI assistants (Claude, ChatGPT, Cursor, …) **create / read / update / delete**
> tasks, projects, client requests, and daily tasks in Seeder — the way Atlassian's
> remote Jira MCP works, but adapted to Seeder's **fork-and-self-host** model.

> **Historical implementation plan.** This is the phase-by-phase build journal. The
> ✅ status notes reflect what shipped, but some original plan-stage code blocks
> below use pre-rename identifiers — e.g. the table shipped as
> `personal_access_token` (not `api_key`); token helpers live in `lib/auth-token.ts`
> (not `lib/mcp/auth.ts`); the endpoint is a single `app/api/mcp/route.ts` with no
> `[transport]` segment; and `lib/services/projects.ts` / `daily.ts` were deferred
> and not built. For the current architecture, see the [MCP docs](https://seederpm.xyz/docs/mcp).

---

## 1. Decision summary

| Decision | Choice | Why |
|---|---|---|
| Pattern | **Remote, in-app MCP** — a route inside Seeder, not a separate service | Ships with the code. Every fork gets it for free at `https://<their-domain>/api/mcp` on deploy. Same model as Atlassian's hosted endpoint, one per self-hosted instance. |
| Transport | **Streamable HTTP only**, stateless JSON mode | Fits Cloudflare Workers (no Redis, no sticky sessions, no long-lived SSE). The deprecated two-endpoint HTTP+SSE transport is **not** implemented. |
| Library | **Official `@modelcontextprotocol/sdk` (1.29.0) direct, Web-standard transport** — decided in Phase 0 ✓ | The SDK ships `WebStandardStreamableHTTPServerTransport` (`handleRequest(req: Request): Promise<Response>`) — Web-native, no Node `http` bridge, no `redis`. `mcp-handler` rejected (eager `redis`/`net` import, SDK pinned to 1.26). |
| Auth | **API tokens (PATs)** — static `seed_pat_…` bearer, `read` / `readwrite` scopes | Seeder is **session-cookie only today**; an MCP client has no cookie jar. Static bearer over HTTPS is spec-permitted for self-hosted servers. OAuth 2.1 is deferred to v2. |
| Reuse | A new `lib/services/*` layer shared by the web API **and** MCP tools | Identical validation, authz, and audit logging whether a change comes from the UI or an AI. |
| Legacy | Keep the prior standalone MCP only as an optional `stdio→remote` bridge via `mcp-remote` | Covers stdio-only/air-gapped clients. Not the primary product. |
| Spec target | **2025-11-25** (current stable). Build stateless to hedge the 2026-07-28 RC that drops session IDs. | — |

### Request flow

```
AI client ──POST /api/mcp (Authorization: Bearer seed_pat_…)──▶ Seeder Worker
                                                                  │
                          1. validate Origin (403 on mismatch)    │
                          2. getViewerFromToken() → Viewer + scope │  (401 if invalid)
                          3. build stateless McpServer for viewer  │
                          4. tool handler ─────────────────────────┘
                                   │
                                   ▼
                          lib/services/* (createTask, updateTaskStatus, …)
                                   │  ← same functions the web API calls
                                   ▼
                          canAccessProject / isAdminTier  →  D1 (Drizzle)  →  logProjectActivity
```

The MCP endpoint runs **inside the same Worker** as the app. No second deploy, same domain, same D1, same authz.

---

## 2. Constraints grounded in the codebase

- **Runtime: Cloudflare Workers** via `@opennextjs/cloudflare` (`getCloudflareContext()`, D1 binding `env.PM_DB` — see `lib/db/index.ts`). Synchronous request/response; **do not** mark the MCP route `runtime = "edge"` (OpenNext runs route handlers in the Worker with `nodejs_compat`).
- **Auth today is session-only.** `getViewer()` (`lib/auth-server.ts:43`) reads a Better-Auth cookie → `Viewer { id, email, name, role, image }`, returning `null` for `disabledAt` users. There is **no** token/PAT mechanism — Phase 1 adds it.
- **Authz seam exists and is reusable.** `canAccessProject(viewer, projectId)` and `isAdminTier(role)` (`lib/authz.ts`, `lib/auth-server.ts:99`) take a `{ id, role }` viewer — works unchanged with a token-derived viewer.
- **Mutations funnel through one dispatcher.** `app/api/workspace/route.ts` `POST` (line 370): `getViewer()` → parse a Zod `discriminatedUnion("action", …)` → `assertProjectAccess` → per-action block (`crypto.randomUUID()` ids, `formatTaskCode`, `resolveAssignee`, `resolveCategory`, `touchProject`, `logProjectActivity`, `revalidateProjectViews`) → `Response.json`. Daily-task and project mutations live as Server Actions in `lib/actions.ts` (3064 lines) + `lib/daily.ts`.
- **Migrations are hand-written SQL** in `migrations/` (`0001_…` → `0023_…`), applied with `wrangler d1 migrations apply PM_DB --local|--remote`. `drizzle.config.mjs` generates into `./drizzle`, but the **applied** migrations are the numbered files in `migrations/` (`wrangler.jsonc` → `migrations_dir: "migrations"`).
- **Modified Next.js 16.2.4.** Per `AGENTS.md`, route-handler conventions may differ from upstream — **read `node_modules/next/dist/docs/` before writing the route handler.**
- **Schema conventions** (`lib/db/schema.ts`): `text("id").primaryKey()`, `integer(col, { mode: "timestamp_ms" }).default(sql\`(unixepoch() * 1000)\`)`, FKs `references(() => user.id, { onDelete: "cascade" })`, indexes via `uniqueIndex`/`index`.

---

## Phase 0 — Transport spike (½–1 day) **[do this first]**

The framework choice depends on one fact: **does the chosen library return a Web `Response` that builds and runs cleanly under `opennextjs-cloudflare build`?** The official SDK's `StreamableHTTPServerTransport` is Node-`http`-oriented; `mcp-handler` is purpose-built to adapt the SDK to a Next.js route handler (Web `Request`→`Response`). On Workers this can flip the recommendation.

**Spike both behind a throwaway `/api/mcp` route that exposes one `ping` tool:**

- **Candidate A — `mcp-handler`** (`createMcpHandler` + `withMcpAuth`). Pros: designed for exactly this (App Router route handler, Web Response), bundles auth helpers. Cons: peer-pins `@modelcontextprotocol/sdk` to `1.26.0`; pulls `redis` into the dep tree — **verify it bundles for Workers** (redis is only *used* for SSE/resumability, but confirm an unused import doesn't break the OpenNext build).
- **Candidate B — official SDK direct** (`McpServer` + Streamable HTTP transport, stateless, `sessionIdGenerator: undefined`). Pros: latest SDK, clean per-request server instantiation → natural **per-viewer conditional tool registration**. Cons: confirm the installed version exposes a Fetch/Web-standard transport; if it only ships the Node-`http` transport, add a thin Web↔Node bridge.

**Exit criterion:** pick the candidate where `npm run preview` (`opennextjs-cloudflare build && … preview`) serves the `ping` tool to MCP Inspector with **no Redis and no bundling errors**. Record the choice and the exact SDK import paths in this file before Phase 3.

> Default bet: `mcp-handler` wins on Workers ergonomics *if* it bundles clean; otherwise SDK-direct with a fetch bridge. Gate tools inside handlers (see Phase 3) so the pattern is identical either way.

### Conclusion (decided)

**Winner: official `@modelcontextprotocol/sdk@1.29.0`, used directly with `WebStandardStreamableHTTPServerTransport`.** Evidence gathered in the spike:

- The installed SDK exposes `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` →
  `class WebStandardStreamableHTTPServerTransport` with `constructor({ sessionIdGenerator?, enableJsonResponse?, allowedHosts? })` and **`handleRequest(req: Request): Promise<Response>`**. Its own docstring shows a `fetch(request): Promise<Response>` usage → built for fetch/Web runtimes (Cloudflare/Deno/Bun). No Node `http` bridge needed.
- That transport imports **zero Node built-ins** and contains **no `ajv`/`eval`** → clean for the Workers bundle. (For raw-JSON-Schema validation the SDK even ships `@modelcontextprotocol/sdk/validation/cfworker`; we use Zod `inputSchema`, so we avoid the `ajv`/`eval` path entirely.)
- `mcp-handler@1.1.0` **rejected**: its entry eagerly does `import { createClient } from "redis"` + `import { Socket } from "net"` (not lazy), and peer-pins the SDK to `1.26.0`. On Workers that's dead weight / a bundling hazard for a feature (SSE resumability) we don't use.
- Endpoint stays a **single `app/api/mcp/route.ts`** (no `[transport]` segment — dropped; `mcp-remote` can target `/api/mcp` directly). Stateless: `sessionIdGenerator: undefined`, `enableJsonResponse: true`, fresh `McpServer`+transport per request.
- Tool registration API: `server.registerTool(name, { description, inputSchema /* Zod shape */, annotations }, cb)`.

**Spike artifact:** `app/api/mcp/route.ts` holds a minimal `ping`-tool version. It compiles against the SDK types and is expected to bundle (web transport = pure Web APIs); the full `opennextjs-cloudflare build` pass + a live `initialize`→`tools/call` round-trip is the **one remaining empirical check**, deferred to Phase 3 when the real endpoint replaces the spike. (A first build run failed only on an unrelated, now-fixed `node_modules` inconsistency in the `cloudflare` package; a clean `npm install` restored it.)

**Dependency change already applied:** `@modelcontextprotocol/sdk@^1.29.0` added to `package.json` (+ `package-lock.json` reconciled). `mcp-handler`/`redis` not present.

---

## Phase 1 — API token (PAT) layer  **[prerequisite for everything else]**

Independently useful (programmatic access, CI), and the only thing that makes an out-of-browser client authenticate.

### ✅ Status: implemented & verified — decided **HAND-ROLL** (not the Better-Auth `apiKey` plugin)

A workflow adversarially verified the design before any code was written:
- `@better-auth/api-key` is a **separate, uninstalled** package; it defaults to an `x-api-key` header (not Bearer), its "scopes" are a custom permissions map (not OAuth scopes), and resolving a key mints a *mock session* that is **not** our `Viewer` — so we'd hand-build the `Viewer` + `disabledAt` check anyway. Its hashing is plain SHA-256. → Hand-rolling is **less** security-critical code and **zero** new deps for forkers.
- ⚠️ **Do not `npm i @better-auth/api-key`.** Seeder deliberately hand-rolls PATs; adding the plugin later would double-implement this.

Product decisions (locked): any member may mint **read or readwrite** (a token never exceeds its owner's project access) · UI at **`/settings/tokens`** · **optional expiry** (1–365 days, default none).

Delivered:
- `migrations/0024_personal_access_tokens.sql` + `personalAccessToken` table & `tokenScopeValues`/`TokenScope` in `lib/db/schema.ts`
- `lib/auth-token.ts` — `generateToken()`, `hashToken()` (Web-Crypto SHA-256), `getViewerFromToken(request)` → existing `Viewer` + scope, header-only, with revoked/expiry/`disabledAt` fail-closed checks
- `lib/data-tokens.ts` — `getMyTokens()` (metadata only, never the hash; status derived server-side)
- `app/api/account/tokens/route.ts` (mint/list) + `app/api/account/tokens/[tokenId]/revoke/route.ts` (soft-revoke, 404-not-403 on non-owner)
- `app/(app)/settings/tokens/page.tsx` + `components/settings/tokens/token-manager.tsx` (create modal with one-time reveal + copy-paste MCP config snippet) + sidebar "API tokens" link
- `app/api/mcp/route.ts` now **gated** by `getViewerFromToken` (bearer-only, JSON-RPC 401), scope passed to the (stub) tool builder

Verified: `tsc --noEmit` → 0 errors · ESLint clean on all new files · `0024` migration applies to local D1 (4 commands ✅).
**Manual check still pending** (needs a browser login): mint a token in `/settings/tokens`, then call `POST /api/mcp` with `Authorization: Bearer seed_pat_…` and confirm `whoami` returns the viewer. Origin/Host validation is deferred to Phase 5.

### 1a. Schema + migration

`lib/db/schema.ts` — add after the `account` table (mirrors `session` conventions):

```ts
export const apiKeyScopeValues = ["read", "readwrite"] as const;

export const apiKey = sqliteTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),                       // user-given label
    tokenHash: text("token_hash").notNull(),            // SHA-256 hex of the full token — never store plaintext
    tokenPrefix: text("token_prefix").notNull(),        // e.g. "seed_pat_3f9b…" for the list UI
    scope: text("scope", { enum: apiKeyScopeValues }).notNull().default("read"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),   // null = no expiry
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),   // soft-revoke
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("api_key_token_hash_idx").on(table.tokenHash),
    index("api_key_user_idx").on(table.userId),
  ],
);
```

`migrations/0024_api_keys.sql`:

```sql
CREATE TABLE `api_key` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `token_hash` text NOT NULL,
  `token_prefix` text NOT NULL,
  `scope` text DEFAULT 'read' NOT NULL,
  `last_used_at` integer,
  `expires_at` integer,
  `revoked_at` integer,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_token_hash_idx` ON `api_key` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `api_key_user_idx` ON `api_key` (`user_id`);
```

Apply: `npm run db:migrate:local` (then `:remote` on deploy).

### 1b. Token mint/verify helpers — `lib/mcp/auth.ts`

```ts
// Token format: "seed_pat_" + 32 random bytes (base64url). Shown once; we store only the SHA-256 hash.
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateToken(): { token: string; prefix: string } { /* crypto.getRandomValues → base64url */ }

export type TokenViewer = { viewer: Viewer; scope: "read" | "readwrite" };

export async function getViewerFromToken(request: Request): Promise<TokenViewer | null> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token.startsWith("seed_pat_")) return null;

  const db = getDb();
  const [row] = await db
    .select({ /* apiKey fields + joined user: id,email,name,role,image,disabledAt */ })
    .from(apiKey)
    .innerJoin(user, eq(apiKey.userId, user.id))
    .where(eq(apiKey.tokenHash, await sha256Hex(token)))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  if (row.disabledAt) return null;                  // deactivated user — mirrors getViewer()

  // best-effort lastUsedAt update (don't block the request on it)
  return { viewer: { id: row.id, email: row.email, name: row.name, role: row.role, image: row.image }, scope: row.scope };
}
```

Returns the **exact `Viewer` shape** from `lib/auth-server.ts:35`, so every existing authz helper works unchanged. Centralize the `disabledAt` check here so it can't drift from `getViewer()`.

### 1c. Management API + UI

- `app/api/user/api-keys/route.ts`: `POST` (mint → return plaintext **once**), `GET` (list metadata: name, prefix, scope, lastUsedAt, createdAt, expiresAt), `DELETE` (set `revokedAt`). Cookie-session-auth'd via `requireViewer()`.
- Settings page (mirror existing settings UI): list keys, "Create token" (name + scope + optional expiry) showing the value once, revoke button.

**Checkpoint:** mint a token in the UI, `curl` the management API, confirm hash-only storage and revoke.

---

## Phase 2 — Service layer extraction (refactor)  **[behind tests]**

Pull the **pure mutation cores** out of the web handlers so MCP and the UI share one implementation. No behavior change to the web app.

### ✅ Status: workspace-route slice extracted (tasks / checklist / requests)

A read-only mapping workflow produced the exact move-map (every helper + branch body, line-by-line) and surfaced the key reality: **the test suite has essentially zero mutation coverage** (20 pure-util tests, no DB harness) — so `tsc` is the real gate and the true behavior check is a manual signed-in smoke test.

Delivered (all **moved verbatim**, not rewritten):
- `lib/services/_shared.ts` — the 14 shared helpers (`assertProjectAccess` now takes `Viewer`; uses `canAccessProject`, the member/admin model the MCP needs) + `optionalText`
- `lib/services/tasks.ts` / `checklist.ts` / `requests.ts` — the 10 mutation cores as `fn(viewer, input)` + their exported Zod input schemas
- `app/api/workspace/route.ts` — rewired to a thin dispatcher (**1014 → 222 lines**); re-composes `workspaceMutationSchema` from the service schemas (single source of truth), keeps all `revalidateProjectViews`/`Response` shaping, moves `assertProjectAccess` into each service

Invariants held: `revalidate`/`redirect`/`FormData` stayed in the caller; activity logging moved with each mutation; exact error strings + single `now` + the subtle moves (cross-project `requestId` drop, sort-order recompute) preserved; dead code dropped (`optionalHexColor`, `baseProjectSchema`).

Verified: `tsc --noEmit` → 0 errors · ESLint clean · vitest 20/20 (unchanged) · `actions.ts` untouched (diff discipline confirmed).
**Manual check still pending** (needs signed-in browser): create/move/edit/delete a task, checklist CRUD, request CRUD → confirm board + Activity feed unchanged.

**Deferred to a follow-up pass (deliberately, not overlooked):**
- `lib/services/projects.ts` — `actions.ts` projects use the *stricter* `assertProjectOwnership` (owner-scoped) model; converting to the service `canAccessProject` model is an auth-posture **decision**, not a mechanical move.
- `lib/services/daily.ts` — `createDailyTaskAction` entangles a board-task insert with the planner insert, and update/delete fire `createNotification` side-effects.
- `actions.ts` helper de-dup (it has byte-identical copies of `parseDate`/`touchProject`/etc.) — pure cleanup, skipped to keep the blast radius small without a test net.

Consequence for the MCP tool surface: task/checklist/request **write** tools can ship now (service-backed); project/daily write tools wait on the deferred services.

New `lib/services/`:

| File | Functions | Source today |
|---|---|---|
| `_shared.ts` | `assertProjectAccess`, `assertTaskInProject`, `resolveAssignee`, `resolveCategory`, `nextTaskCodeNumber`, `getProjectSlug`, `getNextTaskSortOrder`, `touchProject`, `parseDate` | helpers in `app/api/workspace/route.ts` (above line 370) |
| `tasks.ts` | `createTask`, `updateTask`, `deleteTask`, `updateTaskStatus` | `route.ts` action blocks (`create-task` @384, `update-task` @455, `delete-task` @565) |
| `checklist.ts` | `createChecklistItem`, `toggleChecklistItem`, `updateChecklistItem`, `deleteChecklistItem` | `route.ts` @603–839 |
| `requests.ts` | `createRequest`, `updateRequest`, `deleteRequest` | `route.ts` @845–1004 |
| `projects.ts` | `createProject`, `updateProject`, `archiveProject` | `lib/actions.ts` (project action cores) |
| `daily.ts` | `createDailyTask`, `updateDailyTask`, `deleteDailyTask`, `toggleDailyTaskStatus` | `lib/actions.ts` (daily fns) + `lib/daily.ts` |

**Contract:** `async function createTask(viewer: Viewer, input: CreateTaskInput): Promise<{ taskId: string; code: string }>`
- Takes a `Viewer` + typed input (reuse the existing Zod schemas — export them from a shared module).
- Does DB work + `logProjectActivity` (so the audit trail records AI-driven changes identically).
- **Does not** call `revalidatePath`/`redirect` — those stay in the callers (Server Actions can't be invoked from MCP, and `redirect()` must not leak into a service).

Rewire callers to delegate, e.g. the web route becomes:

```ts
if (payload.action === "create-task") {
  const { taskId } = await createTask(viewer, payload);
  revalidateProjectViews(payload.projectId, { projects: true, today: true, overview: true, board: true, clientBoard: true });
  return Response.json({ ok: true, taskId });
}
```

**Checkpoint:** `npm test` green; manual UI smoke test confirms identical activity logs and revalidation.

---

## Phase 3 — MCP server + endpoint

### ✅ Status: Phase 3 + Phase 4 implemented & verified live

`lib/mcp/server.ts` `buildServer({viewer, scope})` registers `whoami` + **6 read tools** always, and **11 write tools** only when `scope === "readwrite"`. Reads come from new `lib/services/reads.ts` (viewer-scoped via `getPersonalProjectIds`/`canAccessProject`, compact shapes, capped at 100, return `null`/`[]` not throw — no existence oracle). Write tools reuse the Phase-2 services via each schema's `.shape`, wrapped so a service `throw` surfaces as an MCP tool error (`isError`). Added `updateTaskStatus` to `tasks.ts` (loads the row, delegates to `updateTask` so the move is diffed + activity-logged — no second unlogged path). The route (`app/api/mcp/route.ts`) slimmed to auth + transport only and imports `buildServer`.

Verified `tsc --noEmit` → 0 errors · ESLint clean · then a **live headless smoke** against `next dev` + local D1 with a real token row:
- `whoami` resolved the token → `admin@admin.com` / owner / `readwrite` ✓
- `tools/list`: readwrite token = **18 tools**; read token = **7 read tools, zero writes** ✓
- read token → `create-task` ⇒ **`-32602 Tool create-task not found`** (scope gate holds) ✓
- `create-task` wrote a real row (`LFMS-2`) → `read-task` confirmed → `delete-task` removed it ✓
- `project_activity` recorded **created + deleted** ⇒ MCP writes produce identical audit entries to the web UI ✓
- stateless `tools/call` accepted **without a prior `initialize`** — exactly as the SDK source predicted ✓

**Tool surface shipped:** read — `whoami`, `list-projects`, `list-tasks`, `read-task`, `list-requests`, `read-request`, `search`; write (readwrite) — `create/update/delete-task`, `update-task-status`, the 4 checklist ops, `create/update/delete-request`. All write tools carry `destructiveHint`/`idempotentHint` annotations + "CONFIRM with the user" descriptions. **Deferred** (need the Phase-2 follow-up services): project & daily-task write tools.

### `lib/mcp/server.ts` — register tools, gate by scope/role

```ts
export function buildSeederMcpServer({ viewer, scope }: TokenViewer) {
  const server = new McpServer({ name: "seeder", version: APP_VERSION });

  // READ tools — always available
  registerReadTools(server, viewer);

  // WRITE tools — only with a readwrite token
  if (scope === "readwrite") registerWriteTools(server, viewer);

  // ADMIN-tier tools (create/archive project) — gate inside the handler too
  return server;
}
```

Each write tool:
- input schema = the matching exported Zod schema from Phase 2;
- handler calls the corresponding `lib/services` function with `viewer`;
- carries `annotations` (`destructiveHint: true` on deletes/creates, `idempotentHint` where applicable);
- description instructs the agent to **confirm the exact change with the user before calling** (carry over the prior standalone MCP safety convention);
- admin-only tools re-check `isAdminTier(viewer.role)` and return an MCP error otherwise (defense in depth, since registration-time gating may not exist with `mcp-handler`).

### `app/api/mcp/[transport]/route.ts` — the endpoint

Pattern (final form set by Phase 0). Portable skeleton:

```ts
// Do NOT set runtime = "edge" — OpenNext runs this in the Worker with nodejs_compat.
export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return new Response("Forbidden", { status: 403 });  // DNS-rebinding guard
  const auth = await getViewerFromToken(request);
  if (!auth) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const server = buildSeederMcpServer(auth);
  // stateless: fresh server + transport per request, no session id, JSON response
  return handleStreamableHttp(server, request);   // mcp-handler call OR SDK transport + Web bridge
}

export async function GET() { return new Response("Method Not Allowed", { status: 405 }); } // no server-initiated stream in stateless mode
```

- `isAllowedOrigin` reads `MCP_ALLOWED_ORIGINS` (comma-separated) — required in prod.
- `[transport]` segment leaves room to also answer the legacy bridge path if ever needed.

---

## Phase 4 — Tool surface

Mirrors what the prior standalone MCP proved, mapped onto Seeder entities.

**Read:** `whoami`, `list-projects`, `list-tasks` (filter status/priority/assignee), `read-task`, `list-requests`, `read-request`, `search` (cross-entity, scoped to `visibleProjectIds`).

**Write (`readwrite` scope):** `create-task`, `update-task`, `delete-task`, `update-task-status` (narrow `todo|doing|done` convenience — the most common Jira-style action), `create-request`, `update-request`, `delete-request`, `add-checklist-item`, `toggle-checklist-item`, `create-daily-task`, `update-daily-task`, `delete-daily-task`, `toggle-daily-task-status`.

**Admin-tier write:** `create-project`, `update-project`, `archive-project`.

Notes:
- **Bound result sets** (`list-*`, `search` cap ~50–100 rows) — Workers CPU/subrequest limits.
- **Daily tasks**: `plannedDate` is an **owner-timezone day-key** — the tool must require an explicit date and document the TZ semantics, or a client in another TZ plans on the wrong day.
- **Deletes are permanent** (no soft-delete on tasks/requests). Strongly consider porting the prior standalone MCP's self-contained **undo token** + `revert-write` tool.

---

## Phase 5 — Safety, env, docs, per-fork connection

### ✅ Status: implemented

- **Origin / DNS-rebinding validation** in `app/api/mcp/route.ts`: a present `Origin` must be allow-listed (403 otherwise); an absent `Origin` passes (non-browser MCP clients send none); a no-op when unconfigured (token auth still gates every request). Config via `serverEnv.mcpAllowedOrigins` (`lib/env.ts`, reads `MCP_ALLOWED_ORIGINS`, `process.env` per house convention) — chose an explicit route check over the SDK transport's `allowedOrigins` option (which is `@deprecated`).
- **`.dev.vars.example`** documents `MCP_ALLOWED_ORIGINS`.
- **`README.md`** has an `## MCP server` section: what it is, mint-a-token + connection JSON snippet, scope/authz model, tool list, and the `MCP_ALLOWED_ORIGINS` / `mcp-remote` notes.
- Verified: full-project `tsc --noEmit` 0 errors · ESLint clean · `vitest` 20/20.

### ✅ Workers build + workerd runtime verified

- `opennextjs-cloudflare build` **passes** (`Worker saved in .open-next/worker.js`). This first required fixing a **pre-existing build blocker** unrelated to the MCP: **6 routes** declared `export const runtime = "edge"` (`app/api/branding/[...path]`, `admin/system`, `admin/system/branding`, `uploads/image`, `uploads/[...path]`, `client/[token]/uploads/[...path]`) — but they all use `getCloudflareContext()`/`env.UPLOADS` (Worker APIs), and OpenNext can't bundle edge-runtime routes in its default function, so this broke **every `npm run deploy`**. Removed the `runtime = "edge"` line from all 6 (they now run in the Worker like the rest of the app). Likely introduced by the recent "public image serving" commit.
- Ran the real Worker locally via `opennextjs-cloudflare preview` (workerd + Wrangler on `:8787`, local D1/R2) and re-ran the MCP smoke against it: `whoami` (proves Web-Crypto SHA-256 token hashing works on workerd), 18 tools, `create-task` wrote a real row, Zod input validation rejected a bad call. Cleaned up after.

Both prior verification gaps are now closed; the only thing not re-checked here is the web-app board UI smoke (your call).



- **Env:** `MCP_ALLOWED_ORIGINS` (document in `wrangler.jsonc`, `cloudflare-env.d.ts` via `npm run cf-typegen`, and `.dev.vars`/README).
- **Docs (the self-host hook):** README section with a per-fork connection snippet using the fork's own domain —
  ```json
  { "mcpServers": { "seeder": { "url": "https://pm.yourfork.com/api/mcp", "headers": { "Authorization": "Bearer seed_pat_…" } } } }
  ```
  plus "mint a token in Settings → API tokens". This is the analogue of the prior standalone MCP's `PM_BASE_URL`.
- **Legacy bridge:** keep/republish the prior standalone MCP (rename → `seeder-mcp`) as an **optional** `stdio→remote` shim documented via `mcp-remote`, for clients that can't do remote MCP.
- Update `AGENTS.md`/`CLAUDE.md` with the MCP endpoint and token model.

---

## Testing strategy

- **Unit (Vitest, already configured):** each `lib/services/*` function — happy path + authz denial (`canAccessProject` false) + validation errors.
- **Auth:** `getViewerFromToken` — valid, revoked, expired, disabled-user, wrong-prefix, missing-header.
- **End-to-end:** MCP Inspector (or Claude Code) against `npm run preview` (local `wrangler`) with a real PAT. Verify read tools work with a `read` token and write tools return an error with a `read` token; write tools succeed with `readwrite`.
- **Regression:** existing web app behaves identically after the Phase 2 refactor (activity logs + revalidation unchanged).

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Workers transport compat** (SDK is Node-`http`-based) | Phase 0 spike with a hard build/run exit criterion before committing the framework. |
| **Refactor regressions** (lifting cores out of 1014- and 3064-line files) | Land Phase 2 behind unit tests; keep `revalidatePath`/`redirect` in callers; smoke-test the UI. |
| **Token leak** | Hash-only storage (SHA-256), show-once, `read`/`readwrite` scopes, expiry + revoke, `lastUsedAt` for anomaly spotting. |
| **Over-broad AI writes / permanent deletes** | `destructiveHint` annotations, "confirm before calling" descriptions, optional undo-token tool. |
| **Workers CPU/subrequest limits** | Cap `list`/`search` results; avoid fan-out queries. |
| **DNS-rebinding** | Mandatory Origin validation (403), `MCP_ALLOWED_ORIGINS` required in prod. |
| **Deactivated user still mutating** | Centralized `disabledAt` check in `getViewerFromToken` (single source with `getViewer`). |
| **Spec churn (2026-07-28 RC drops session IDs)** | Build stateless now; pin SDK stable (avoid v2 alpha); plan an RC re-test. |
| **Daily-task TZ mismatch** | Require explicit `plannedDate`; document owner-TZ semantics in the tool. |

---

## Out of scope (v2)

- **OAuth 2.1** (browser-consent flow, RFC 9728 Protected Resource Metadata at `.well-known/oauth-protected-resource`, RFC 8707 audience validation) — add when forks want consent-based access instead of pre-minted tokens.
- Resources/prompts (MCP primitives beyond tools).
- Webhooks / server-initiated notifications (needs stateful transport — avoid until the spec settles).

---

## File manifest

**New**
- `migrations/0024_api_keys.sql`
- `lib/mcp/auth.ts` — token gen + `getViewerFromToken`
- `lib/mcp/server.ts` — tool registration + scope/role gating
- `app/api/mcp/[transport]/route.ts` — the endpoint
- `app/api/user/api-keys/route.ts` — mint/list/revoke
- `lib/services/{_shared,tasks,checklist,requests,projects,daily}.ts`
- settings UI page for API tokens

**Edited**
- `lib/db/schema.ts` — `apiKey` table
- `app/api/workspace/route.ts` — delegate action blocks to `lib/services`
- `lib/actions.ts`, `lib/daily.ts` — lift mutation cores into `lib/services`
- `wrangler.jsonc` / `cloudflare-env.d.ts` — `MCP_ALLOWED_ORIGINS`
- `README.md`, `AGENTS.md`/`CLAUDE.md` — connection docs

---

## Suggested sequence

```
Phase 0 (spike)  →  Phase 1 (tokens)  →  Phase 2 (services, tested)  →  Phase 3 (endpoint)
                                                                            →  Phase 4 (tools)  →  Phase 5 (safety/docs)
```

Phase 1 is independently shippable (PATs are useful on their own). Phase 2 is the largest/riskiest — do it behind tests before any MCP wiring. Start the build with the **token layer** unless Phase 0 surfaces a transport blocker.
