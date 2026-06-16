# Seeder MCP — Architecture & Guide

Reference for the built-in [Model Context Protocol](https://modelcontextprotocol.io)
server that lets AI assistants read and edit Seeder data. This is the internal
architecture/engineering reference; [PLAN.md](PLAN.md) is the phase-by-phase build
journal, and the root `README.md` "MCP server" section is the short user-facing
version.

---

## 1. What it is

A **remote MCP server bundled into the Seeder app**, served at **`/api/mcp`**.
Because it ships *inside* the app, every self-hosted fork exposes it automatically
at `https://<their-domain>/api/mcp` — no separate service to deploy. This mirrors
how Atlassian ships its hosted Jira/Confluence MCP, adapted to a
self-hosted-per-fork topology.

An AI client authenticates with a **personal access token (PAT)** and acts **as
that user**, bounded by exactly the project access the user already has. Every
change flows through the same code the web UI uses, so it lands in the project
Activity feed identically.

Tool surface today: **projects / tasks / task categories / client requests /
task checklists / project members / workspace invites** (reads + writes).
Daily-task *writes* are the only remaining piece deferred (see §11).

---

## 2. Key decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| Topology | **Remote, in-app** (a route), not a local stdio npm package | Ships with the code → every fork gets it for free, always version-matched to its own schema. A separate package re-introduces the version-drift problem (which the prior standalone MCP hit). Also: ChatGPT only supports *remote* MCP. |
| Transport | **Streamable HTTP**, stateless JSON, official `@modelcontextprotocol/sdk` `WebStandardStreamableHTTPServerTransport` | Web `Request`→`Response` native → fits Next.js route handlers + Cloudflare **workerd**. No Node `http` bridge, no Redis. Rejected `mcp-handler` (eager `redis`/`net` imports, pins SDK to 1.26). |
| Statelessness | `sessionIdGenerator: undefined`, `enableJsonResponse: true`; fresh server+transport per request | No session store / Redis / sticky routing — any Worker isolate serves any request. Also hedges the 2026-07-28 MCP RC, which drops `Mcp-Session-Id`. |
| Auth | **Hand-rolled PATs** (bearer), not Better-Auth's `apiKey` plugin | The plugin is a separate uninstalled package, defaults to `x-api-key` (not Bearer), its "scopes" are a custom permissions map, and resolving a key yields a *mock session* (not our `Viewer`) — so we'd hand-build the Viewer + `disabledAt` check anyway. Hand-rolling is less security-critical code and zero new deps. |
| Authz model | **Per-domain, mirroring each web gate**: task/request/checklist tools use member-aware `canAccessProject`; project-settings tools are **owner-only** (`assertProjectManage`, same as the web `assertProjectOwnership`); member tools use `canManageProjectMembers` (owner-or-admin); invite tools use `isAdminTier` (owner/admin, owner-only for admin invites) | Each MCP tool enforces exactly the gate its web counterpart does, so a token never exceeds its user's own access — including the asymmetry that admins manage members on any project but only owners edit project settings. |
| Code sharing | Extract mutation cores into `lib/services/*` shared by **both** the web route and the MCP server | Identical validation, authz, and activity logging whether a change comes from the UI or an AI. Single Zod schema source of truth. |

---

## 3. Request flow

```
AI client ──POST /api/mcp──▶  app/api/mcp/route.ts
  Authorization: Bearer seed_pat_…           │
  Accept: application/json, text/event-stream │
  MCP-Protocol-Version: 2025-06-18            │
                                              ▼
        1. originAllowed(request)   → 403 if MCP_ALLOWED_ORIGINS set & Origin present-but-unlisted
        2. getViewerFromToken(req)  → { viewer, scope }  | 401 (JSON-RPC -32001) if invalid
        3. buildServer({viewer, scope})   (lib/mcp/server.ts)
              · whoami + 11 read tools                (always)
              · 30 write / management tools           (only if scope === "readwrite")
        4. new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        5. server.connect(transport); return transport.handleRequest(request)
                                              │
        tool handler ─────────────────────────┘
              · read  → lib/services/reads.ts   (viewer-scoped)
              · write → lib/services/{tasks,checklist,categories,requests,projects,members}.ts (viewer, input)
                              │
                              ▼
              canAccessProject / getPersonalProjectIds  →  D1 (Drizzle)  →  logProjectActivity
```

The route owns auth + transport + the per-request lifecycle. `lib/mcp/server.ts`
owns only tool registration. Services own the data logic (no HTTP/Next concerns).

---

## 4. File map

```
app/api/mcp/route.ts                         endpoint: Origin check, bearer auth, stateless transport
lib/mcp/server.ts                            buildServer({viewer,scope}); registers read + (scoped) write tools

lib/auth-token.ts                            TOKEN_PREFIX, generateToken, hashToken, getViewerFromToken, TokenAuth
lib/data-tokens.ts                           getMyTokens (metadata only), TokenListItem, TokenStatus
app/api/account/tokens/route.ts              POST mint / GET list (cookie-session auth via requireViewer)
app/api/account/tokens/[tokenId]/revoke/route.ts   POST soft-revoke
app/(app)/settings/tokens/page.tsx           Settings → API tokens page (server component)
components/settings/tokens/token-manager.tsx UI: list + create modal w/ one-time reveal + copy
components/app/app-sidebar.tsx               "API tokens" nav link (personal section)

lib/services/_shared.ts                      shared mutation helpers + optionalText (NO "use server")
lib/services/tasks.ts                        create/update/delete Task, updateTaskStatus + Zod input schemas
lib/services/checklist.ts                    create/toggle/update/delete ChecklistItem + schemas
lib/services/categories.ts                   list/create/update/delete TaskCategory + schemas (owner-only writes)
lib/services/requests.ts                     create/update/delete Request + schemas
lib/services/reads.ts                        listProjects/listTasks/readTask/listRequests/readRequest/search

app/api/workspace/route.ts                   web route: thin dispatcher; re-composes workspaceMutationSchema from the service schemas
lib/db/schema.ts                             personalAccessToken table + tokenScopeValues / TokenScope
migrations/0024_personal_access_tokens.sql   the PAT table
lib/env.ts                                   serverEnv.mcpAllowedOrigins (reads MCP_ALLOWED_ORIGINS)
```

`lib/actions.ts` (Server Actions) is intentionally **untouched** — see §11.

---

## 5. Token model

### Storage (`personal_access_token`, migration `0024`)

| column | notes |
|---|---|
| `id` | uuid |
| `user_id` | FK → `user(id)` ON DELETE CASCADE (deleting a user purges their tokens) |
| `name` | user label |
| `token_hash` | **SHA-256 hex of the full raw token** — the only stored form; **unique index** (verify-time lookup key) |
| `token_prefix` | leading ~15 chars (`seed_pat_AbC123`) for the list UI; not secret, not recoverable |
| `scope` | `'read' | 'readwrite'`, `CHECK` constraint mirrors the TS union |
| `last_used_at` | advisory, best-effort |
| `expires_at` | null = never |
| `revoked_at` | null = active (soft-revoke; keeps `last_used_at` for the user's audit) |
| `created_at` / `updated_at` | `unixepoch()*1000` defaults |

Index: `unique(token_hash)`, `index(user_id, created_at)`.

### Token format & hashing (`lib/auth-token.ts`)

- Format: **`seed_pat_` + base64url(32 random bytes)** = 256 bits of entropy
  (`crypto.getRandomValues` + `Buffer.from(bytes).toString("base64url")`, the
  repo's existing high-entropy recipe).
- Hash: **Web Crypto** `crypto.subtle.digest("SHA-256", utf8(raw))` → hex.
  Plain SHA-256, no salt — correct here because the input is a uniformly-random
  256-bit secret (not a low-entropy password), and a salt would break the
  by-hash unique-index lookup. Works on workerd.
- Stored: **hash + prefix only**. The raw token is returned **exactly once** at
  creation and never persisted (the UI shows a one-time "copy now" reveal).

### Resolution — `getViewerFromToken(request): Promise<{ viewer: Viewer; scope } | null>`

The token-world analogue of `getViewer()`. Returns the **same `Viewer` shape**
(`{ id, email, name, role, image }`) so every existing authz helper works
unchanged. Flow:

1. Read `Authorization` header; require `Bearer ` (case-insensitive) + `seed_pat_` prefix.
2. SHA-256 the raw token; **look up by `token_hash`** (unique index) joined to `user`.
3. Fail closed (return `null`) on: no row · `revoked_at` set · `expires_at <= now` ·
   user `disabled_at` set (replicates `getViewer`'s deactivation rule — the
   cookie path enforces it via the session, the token path must do it itself).
4. Best-effort `last_used_at` touch (non-fatal; never blocks/fails the request).

**Header-only by design** — it never reads the session cookie, so a browser
cookie can't silently authorize a token call. Conversely, web routes never call
`getViewerFromToken`. The two auth worlds are kept strictly separate.

### Management API + UI

- `POST /api/account/tokens` — mint. Body: `{ name, scope, expiresInDays? (1–365) }`.
  Returns the raw token **once**. (`requireViewer`, any member.)
- `GET /api/account/tokens` — list the viewer's own tokens (metadata only, never the hash).
- `POST /api/account/tokens/[tokenId]/revoke` — soft-revoke; **404 (not 403)** if
  the token isn't the viewer's (don't reveal existence).
- UI at `/settings/tokens` (`components/settings/tokens/token-manager.tsx`): list,
  create modal with scope + expiry, one-time reveal + copy-paste MCP config snippet.

---

## 6. Scope & authorization model

Two layers, independent:

- **Scope gates the verb.** `read` tokens get only read tools — write tools are
  **never registered** for them, so they don't even appear in `tools/list` and a
  call returns `-32602 Tool not found`. `readwrite` gets all tools.
- **Existing authz gates the resource.** Every tool runs under the token's
  `Viewer`, so it can never exceed what that user can do in the UI:
  - List reads (`list-projects`/`list-tasks`/`list-requests`) → scoped by
    `getPersonalProjectIds(viewer.id)` (projects owned **or** member of).
  - Project-filtered reads & single-entity reads (`read-task`/`read-request`/
    `read-project-notes`/`list-task-categories`) → gated by
    `canAccessProject(viewer, projectId)`; return `null`/`[]` on a miss (never
    throw → no existence oracle).
  - `list-daily-tasks` is **personal-only** — always scoped to `viewer.id`, so a
    token can never read another user's day plan.
  - Writes → each service calls `assertProjectAccess(viewer, projectId)` first
    (`canAccessProject`).

`whoami` returns the resolved user + scope (handy for the agent to self-orient).

---

## 7. Tool surface (42 tools)

**Read (always):**

| tool | input | returns |
|---|---|---|
| `whoami` | — | `{ id, name, email, role, scope }` |
| `list-projects` | `{ includeArchived?, onlyArchived? }` | project summaries (≤100) |
| `list-tasks` | `{ projectId?, status?, assignedToMe? }` | task summaries (≤100; use filters) |
| `read-task` | `{ projectId, taskId }` | task detail + checklist, or `null` |
| `list-requests` | `{ projectId?, status? }` | request summaries (≤100) |
| `read-request` | `{ projectId, requestId }` | request detail, or `null` |
| `list-task-categories` | `{ projectId }` | a project's categories w/ task counts, or `[]` |
| `search` | `{ query, limit? }` | cross-entity hits (≤50, max 100) |
| `list-daily-tasks` | `{ date?, from?, to? }` | the viewer's own daily-plan items (≤100) |
| `read-project-notes` | `{ projectId }` | project notes scratchpad, or `null` |
| `list-project-activity` | `{ projectId?, limit? }` | project history w/ before→after diffs (≤100) |
| `list-status-updates` | `{ projectId? }` | published client-facing status updates (≤100) |

**Write / management (only with a `readwrite` token):**

- **Tasks** — `create-task`, `update-task`, `update-task-status`, `delete-task`,
  `create-checklist-item`, `toggle-checklist-item`, `update-checklist-item`,
  `delete-checklist-item`.
- **Task categories** — `create-task-category`, `update-task-category`,
  `delete-task-category` (listing is the read-tool `list-task-categories`).
- **Requests** — `create-request`, `update-request`, `delete-request`.
- **Projects** — `create-project`, `update-project`, `set-project-key`,
  `set-project-color`, `archive-project`, `restore-project`, `duplicate-project`,
  `delete-project`, `set-client-board`, `rotate-client-board-link`.
- **Members** — `list-project-members`, `add-project-member`,
  `remove-project-member`.
- **Workspace invites** — `create-invite`, `list-invites`, `revoke-invite`.

(`list-project-members` and `list-invites` are read-only operations but sit behind
the `readwrite` scope as part of the management surface, so a plain `read` token
doesn't see them.)

Conventions:
- Write tools reuse the **service Zod schema** as `inputSchema: <schema>.shape`
  (single source of truth with the web route's parser).
- **Authz is per-domain, matching the web app**: task/request/checklist tools use
  member-aware `canAccessProject`; project-settings tools are owner-only
  (`assertProjectManage`); **category writes are owner-only too** (only
  `list-task-categories` is member-aware); member tools use
  `canManageProjectMembers` (owner-or-admin); invite tools use `isAdminTier`
  (owner/admin, owner-only for admin invites).
- **`update-task-category` is a partial update** (unlike the full-replace task /
  request / project updates): only the `name`/`color` you pass change, so a
  rename can't silently recolor. A rename/recolor cascades to the denormalized
  `categoryName`/`categoryColor` on every task already tagged with it.
- Annotations: `destructiveHint: true` on deletes + `rotate-client-board-link`,
  `idempotentHint` where apt.
- Descriptions instruct the agent to **confirm the change with the user before
  calling**.
- `update-task` / `update-request` / `update-project` are **full-replace** — the
  description tells the agent to read first and pass the whole field set, or
  omitted optional fields clear.
- `update-task-status` is a status-only convenience: it loads the row and
  delegates to `updateTask` so the move is diffed + activity-logged (no separate,
  unlogged path).
- `add-project-member` adds an **existing** workspace user (by email or id); a
  brand-new person is brought in with `create-invite` first (returns a token +
  `acceptPath` to share as `<your-domain><acceptPath>`).
- Service throws (`"Project not found."` etc.) surface as MCP tool errors
  (`isError: true`) via the `runWrite` wrapper — not 500s.

---

## 8. The shared service layer

The core architectural rule: **the web route and the MCP tools call the same
service functions**, so there is one implementation of each mutation.

- Signature: `fn(viewer: Viewer, input: T): Promise<R>` — takes a `Viewer` +
  typed input, returns a plain object.
- A service **does**: DB mutation + `logProjectActivity` (+ code formatting,
  assignee/category resolution, etc.).
- A service **never** does: `revalidatePath`, `redirect`, `FormData`,
  `getViewer`/`getSession` (the caller supplies the viewer). Those stay in the
  callers — that split is the whole point.
- Plain modules — **no `"use server"`** (they're called from a route handler and
  the MCP server, not as form actions).
- **Zod single source:** each variant schema is defined+exported in its service
  file; `app/api/workspace/route.ts` re-composes `workspaceMutationSchema =
  z.discriminatedUnion("action", [createTaskInputSchema.extend({action…}), …])`,
  and the MCP tools reuse the same schemas via `.shape`. So the web parsed-payload
  type **equals** the service input type — no drift.

`app/api/workspace/route.ts` is now a thin dispatcher: `getViewer()` → parse →
`service(viewer, payload)` → `revalidateProjectViews(...)` → `Response.json`.
(It shrank 1014 → 222 lines during the extraction; `lib/actions.ts` untouched.)

---

## 9. Local dev, runtime & testing

Two "local" runtimes — know which you're on:

| command | runtime | bindings | use |
|---|---|---|---|
| `npm run dev` | **Node.js** (`next dev`) | real D1/R2 via `initOpenNextCloudflareForDev()` (miniflare) | fast iteration; real DB, *not* the Worker runtime |
| `npm run preview` | **workerd** (Wrangler, `:8787`) | real D1/R2 (local) | the **actual** Cloudflare runtime locally |
| `npx opennextjs-cloudflare build` | — | — | bundles the Worker → `.open-next/worker.js` |
| `npm run deploy` | workerd (Cloudflare) | real | ship it |

`/api/mcp` is `export const dynamic = "force-dynamic"` and must **not** set
`runtime = "edge"` (OpenNext runs route handlers in the Worker with
`nodejs_compat`, where Web Crypto + Buffer are available).

### Headless smoke (curl)

Stateless mode accepts a `tools/call` **without a prior `initialize`** (verified
against the SDK source — `validateSession` short-circuits when `sessionIdGenerator`
is undefined). Required headers: `Authorization`, `Content-Type`,
`Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2025-06-18`.

```bash
# 1. Mint a test token straight into local D1 (or use the UI):
node -e 'const c=require("crypto"),f=require("fs");const raw="seed_pat_"+c.randomBytes(32).toString("base64url");
f.writeFileSync("/tmp/tok",raw);console.log("INSERT INTO personal_access_token (id,user_id,name,token_hash,token_prefix,scope) VALUES (\x27"+c.randomUUID()+"\x27,\x27<USER_ID>\x27,\x27smoke\x27,\x27"+c.createHash("sha256").update(raw).digest("hex")+"\x27,\x27"+raw.slice(0,15)+"\x27,\x27readwrite\x27);")' 
# pipe that INSERT into:  npx wrangler d1 execute PM_DB --local --command "<INSERT>"

# 2. Call a tool (against next dev :3000 or preview :8787):
TOKEN=$(cat /tmp/tok)
curl -sS http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

For an interactive client, `npx @modelcontextprotocol/inspector` pointed at the
URL with the Bearer token exercises the full handshake with a UI.

### Verification status at ship time
`tsc --noEmit` 0 errors · ESLint clean · `vitest` 20/20 · OpenNext Workers build
passes · live MCP smoke on **workerd** (auth, scope gating, create→read→delete,
matching Activity-feed entries). Note: the app has **no automated mutation-test
coverage**, so `tsc` is the real gate and a signed-in board smoke is the only true
behavior check for the web side of the Phase-2 refactor.

---

## 10. Connecting a client & deployment

**Client config** (Claude, Cursor, …):

```json
{
  "mcpServers": {
    "seeder": {
      "url": "https://<your-domain>/api/mcp",
      "headers": { "Authorization": "Bearer seed_pat_…" }
    }
  }
}
```

A user mints the token at **Settings → API tokens**. Clients that can't speak
remote MCP can bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote).

**Env / hardening:**
- `MCP_ALLOWED_ORIGINS` (comma-separated, optional) — DNS-rebinding protection.
  A *present* `Origin` must be allow-listed (else 403); an *absent* `Origin`
  (typical for non-browser MCP clients) passes; unset = no-op (token auth still
  required). Read via `serverEnv.mcpAllowedOrigins` (`lib/env.ts`, `process.env`).
- Migrations: `npm run db:migrate:local` / `npm run db:migrate:remote`
  (`wrangler d1 migrations apply PM_DB`). `0024` adds the PAT table.

---

## 11. Deferred / roadmap

- **Daily-task write tools** — need `lib/services/daily.ts`. Daily-plan items
  still live in `lib/actions.ts` as Server Actions with their own reorder/board
  side-effects; extracting them is the remaining piece of the services migration.
  (Project writes, members, and invites shipped — extracted to
  `lib/services/{projects,members}.ts`, gated owner-only / owner-or-admin to match
  the web; see §7.)
- **`lib/actions.ts` helper de-dup** — it has byte-identical copies of
  `parseDate` / `touchProject` / `nextTaskCodeNumber` / etc. now in
  `lib/services/_shared.ts`; importing the shared ones is pure cleanup.
- **OAuth 2.1** (v2) — browser-consent flow + RFC 9728 Protected Resource Metadata
  at `.well-known/oauth-protected-resource`, for when forks want consent-based
  access instead of pre-minted tokens. Static bearer PATs are the v1 choice.
- **Undo / `revert-write` tool** — deletes are permanent (no soft-delete on
  tasks/requests); a self-contained undo token (like the prior standalone MCP)
  would pair well with an agent that can delete fast.
- **Throttle `last_used_at`** — currently one D1 write per request; could throttle
  to ~once/N minutes.
- **Resources / prompts** — only tools are exposed today.

---

## 12. MCP spec notes (as of build)

- **Current stable revision: 2025-11-25.** A **2026-07-28** RC is locked that
  removes the `initialize` handshake and `Mcp-Session-Id` — building **stateless**
  now minimizes exposure to that churn.
- **Transports:** `stdio` (local) and **Streamable HTTP** (remote). The old
  two-endpoint HTTP+SSE transport is **deprecated** — we don't implement it.
  (SSE still exists *inside* Streamable HTTP as an optional response mode we don't
  use, since `enableJsonResponse: true`.)
- **Auth** is OPTIONAL in the spec and transport-scoped: HTTP transports *should*
  use the OAuth 2.1 profile, but a static bearer secret over HTTPS is a permitted,
  common pattern for self-hosted servers (what we do).
- **SDK:** `@modelcontextprotocol/sdk@^1.29.0`. Server built with `McpServer` +
  `WebStandardStreamableHTTPServerTransport` (`server/webStandardStreamableHttp.js`).
  Tool registration via `server.registerTool(name, { description, inputSchema, annotations }, cb)`.
  (`@modelcontextprotocol/sdk/validation/cfworker` exists for raw-JSON-Schema
  validation on Workers; we use Zod `inputSchema`, so we avoid the `ajv`/eval path.)
