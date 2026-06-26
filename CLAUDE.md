# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Local development (Cloudflare target, Miniflare simulates D1/R2)
npm run dev

# One-time setup wizard (generates .dev.vars, migration, and seed)
npm run setup

# Apply D1 migrations
npm run db:migrate:local        # local Miniflare
npm run db:migrate:remote       # production Cloudflare D1

# Seed initial admin user
npm run db:seed:local
npm run db:seed:demo:local      # includes sample data

# Pre-PR checks (run all before opening a PR)
npm run lint                    # ESLint
npx tsc --noEmit                # type-check
npm test                        # Vitest unit tests
npm run build                   # production build

# Run a single test file
npx vitest run tests/codes.test.ts

# Deploy to Cloudflare
npm run deploy

# Node VM target (self-hosted, RUNTIME=node)
npm run build:node
npm run start:node
npm run db:migrate:node
```

Copy `.dev.vars.example` → `.dev.vars` for local dev. Required vars: `OWNER_EMAIL`, `BETTER_AUTH_SECRET`. `BETTER_AUTH_URL` is required in production only.

## Architecture

### Dual runtimes

The app targets two deployment modes, selected by `RUNTIME`:
- **Cloudflare Workers** (default/unset): `getDb()` uses `drizzle-orm/d1` via `getCloudflareContext()`. File storage goes to R2 (`lib/storage/r2.ts`).
- **Node VM** (`RUNTIME=node`): `getDb()` uses `drizzle-orm/libsql` against a local SQLite file (`SQLITE_DB_PATH`, default `./data/seeder.db`). File storage uses the local filesystem (`lib/storage/local.ts`).

Both modes share the same Drizzle schema and all `lib/services/*` — only the driver changes. `lib/db/index.ts` handles the switch.

### App Router layout

```
app/
  (app)/          ← authenticated workspace (layout enforces session)
    admin/        ← owner/admin-only pages
    projects/[projectId]/   ← board, requests, history, notes, settings
    dashboard/, daily/, today/, settings/
  (auth)/sign-in/
  api/
    mcp/          ← MCP endpoint at /api/mcp (PAT bearer auth)
    workspace/    ← legacy mutation route (being superseded by Server Actions)
    auth/         ← Better Auth handler
    uploads/      ← R2/local file serving
    client/[token]/  ← public client board uploads (unauthenticated)
  client/[token]/ ← public read-only client board (token-gated)
```

### Data flow

Pages and layouts call functions in **`lib/data.ts`** (read) and **`lib/actions.ts`** (write, all Server Actions). Both use `getDb()` directly and call `lib/services/*` for shared business logic.

The **MCP server** (`lib/mcp/server.ts`, mounted at `/api/mcp/route.ts`) calls the same `lib/services/*` functions as the web app — identical validation, authz, and activity logging. Write tools are only registered when the PAT scope is `readwrite`.

### Auth & authorization

- **Session auth**: `getViewer()` in `lib/auth-server.ts` returns a `Viewer` (id, email, name, role, image) or null for disabled users. Use `requireViewer()` / `requireSession()` to gate server code.
- **Token auth**: `lib/auth-token.ts` resolves PATs for `/api/mcp`. Derives the same `Viewer` shape so all authz code is reused unchanged.
- **Workspace roles** (`lib/db/schema.ts`): `owner` > `admin` > `member`. `isAdminTier(role)` is true for owner/admin.
- **Project roles** (`lib/authz.ts`): `owner` (project creator or workspace admin) > `leader` (project_members row) > `member`. Space membership does NOT grant project access — only explicit project membership does.
- **Per-project capability toggles** (`lib/project-capabilities.ts`): configure what the `member` project role may do; owners/leaders are never gated. Stored as a JSON map on `projects.memberPermissions`; `resolveMemberPermissions()` merges overrides onto code defaults.

### Database

Schema lives in **`lib/db/schema.ts`** (Drizzle). When you change the schema, add a hand-authored numbered SQL file to `migrations/` — never use `drizzle-kit push`. The `migrations/` directory is both the drizzle-kit output and wrangler's `migrations_dir`.

Key invariants baked into the schema:
- `taskStatuses` are per-project custom board columns (replaced fixed `todo/doing/done`). `isTerminal` replaces the old `status === "done"` check everywhere. `isInitial` is the default column for new tasks.
- `tasks.statusName`, `tasks.statusColor`, `tasks.isTerminal` are **denormalized** off the status row to avoid joins on every read surface. The status service resyncs them on every rename/recolor.
- `task_categories` → one category per task (nullable FK + denormalized name/color). `task_labels` → many-to-many via `task_task_labels`.
- `branches` — git-like workstreams per project. Every project has exactly one default ("Main") branch. Tasks and requests are scoped to a branch.
- `spaces` — organizational groupings. `personal` (one per user, auto-created) or `company` (admin-managed). Space membership does not widen project access.
- `personalAccessToken` — only a SHA-256 hash is stored; the raw token is returned once at creation.
- `systemSettings` — singleton row (id=1), used for white-labeling.

### Activity logging

Every mutation (from the UI or MCP) calls `logProjectActivity()` (`lib/activity.ts`). The `project_activity` table stores before→after field diffs as a JSON `ActivityChange[]` array, shown in the History tab.

### Storage

`lib/storage/index.ts` exports a unified `StorageDriver` interface. The active driver is resolved once at module load: R2 on Cloudflare Workers, local filesystem on Node. Upload routes serve files from whichever backend is configured.

## Security-sensitive areas

Per `CONTRIBUTING.md`, pay extra attention when modifying:
- **Authorization / multi-tenant scoping** — every data read/write must pass through `canAccessProject` / `getProjectRole` / `isAdminTier`
- **Invite flow** — only valid invite tokens may bootstrap new accounts
- **Uploads** — authenticated routes must not serve another project's files; the public client board route (`/api/client/[token]/uploads/`) is unauthenticated and must only serve assets for the matching share token
- **Public client board** — reached via a rotatable share token, not the project ID

## Testing

Tests live in `tests/` and are pure-unit: they must not import Next.js server-only modules, `getDb()`, or runtime-specific code. The `@/` alias maps to the project root. Run a single file with `npx vitest run tests/<file>.test.ts`.
