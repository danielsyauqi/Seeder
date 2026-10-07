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
npx opennextjs-cloudflare build  # Cloudflare Worker build
npm run build:node  # self-hosted Node build
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

## Publishing a public release

1. Merge a PR to public `main` that updates the version in `package.json` and
   `package-lock.json`, and adds the release entry to `CHANGELOG.md`.
2. In the public repository, open **Actions → Create release from main → Run
   workflow**, select `main`, and start the run.

The workflow checks the version and both deployment builds, tags the current
`main` commit as `vX.Y.Z`, publishes the versioned amd64/arm64 images to GHCR
and Docker Hub, then creates a GitHub release with GitHub's PR/contributor
summary plus every commit and commit author since the previous tag. It then
waits for the static landing page to rebuild and deploy with the new version
and changelog. It refuses to release a version that already has a GitHub
release. If image publishing fails, rerun the workflow after fixing the failure;
it accepts an existing tag only when it points to the same commit. If the site
deployment fails after the GitHub release exists, rerun the failed site job or
run **Deploy Seeder release site** in `seeder-web` with the new tag.

The repository needs `DOCKER_USERNAME` as an Actions variable and
`DOCKER_PASSWORD` as an Actions secret for Docker Hub. GitHub provides
`GITHUB_TOKEN` for the tag, GHCR image, and release. Also set
`SEEDER_WEB_REPO` to the landing page repository's `owner/repo` as an Actions
variable and `SEEDER_WEB_DISPATCH_TOKEN` as an Actions secret with **Actions:
write** access to that repository. Configure the landing page's Cloudflare
deploy token and account variable before releasing. The separate **Publish
container image** workflow remains available for image-only rebuilds.

## Reporting security issues

Please **don't** file security vulnerabilities as public issues — see
[SECURITY.md](SECURITY.md) for private reporting.
