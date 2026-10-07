# Contributing to Seeder

Thanks for your interest in contributing!

## Getting started

```bash
npm install
cp .dev.vars.example .dev.vars   # then edit as needed
npm run db:migrate:local         # apply D1 migrations locally
npm run db:seed:local            # optional: seed a local admin + sample data
npm run dev
```

See the [README](README.md) for full local D1/R2 setup and deployment steps.

## Before you open a PR

```bash
npm run lint        # ESLint
npx tsc --noEmit    # type-check
npm test            # unit tests (Vitest)
npm run build:node  # self-hosted Node build
npx opennextjs-cloudflare build  # Cloudflare Worker build
```

Please keep PRs focused, and add or update tests when you change behaviour —
especially anything touching **authorization / multi-tenant scoping**, the
**invite flow**, **uploads**, or the **public client board**, which are the
most security-sensitive areas of the app.

## A note on the framework

This project runs on a customized build of **Next.js** on Cloudflare Workers
(see [AGENTS.md](AGENTS.md)). APIs, conventions, and file structure may differ
from a stock Next.js app — when in doubt, check the version-specific docs under
`node_modules/next/dist/docs/` and heed any deprecation notices rather than
relying on general Next.js knowledge.

## Database changes

The live schema is built from the SQL files in `migrations/` (applied via
`wrangler d1 migrations apply`), which are the source of truth. If you change
`lib/db/schema.ts`, add a matching numbered migration — don't rely on
`drizzle-kit push`.

## Reporting security issues

Please **don't** file security vulnerabilities as public issues — see
[SECURITY.md](SECURITY.md) for private reporting.
