![Seeder](docs/images/seeder-banner.png)

# Seeder: Your Personal Project Manager

[![CI](https://github.com/danielsyauqi/Seeder/actions/workflows/ci.yml/badge.svg)](https://github.com/danielsyauqi/Seeder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-seederpm.xyz-2ea043.svg)](https://seederpm.xyz/docs)

A foundational project manager for small teams — simple to run, and yours to
fork. Runs on **Cloudflare Workers** (D1 + R2) or a single **Node VM**, built
with Next.js, Drizzle ORM, Better Auth, and Tailwind.

📖 **Full documentation: [seederpm.xyz/docs](https://seederpm.xyz/docs)**

## Philosophy

Project tools tend toward two extremes: the heavyweight complexity of Jira, or
lightweight boards small teams outgrow in a month. Seeder takes the opposite
stance:

- **Foundational, not heavy.** The essentials a small team needs to run
  projects, client requests, and day-to-day execution — productive immediately.
- **Yours to fork.** It's open source. Customization is a change to your own
  copy — add the field, view, or workflow you need without waiting on a roadmap,
  a plan upgrade, or any lock-in.
- **A small core, on purpose.** Keep the core minimal and solid; the rest is
  yours to build on.

## Features

- **Projects & Kanban** — tasks with categories, multi-tag labels, phases,
  priorities, assignees, due dates, and per-project code numbers.
- **Client requests** — a separate inbound queue (new → reviewed → converted →
  closed) that converts into tasks.
- **Public client board** — an opt-in, token-gated read-only view to share
  progress with clients without giving them an account.
- **Daily planner** — an adhoc/project daily task queue with drag-to-reorder.
- **Rich text & comments** — TipTap-powered descriptions, notes, and comments
  (Markdown-aware) with images and tables.
- **Activity feed** — every change is logged with before→after diffs, whether it
  comes from the UI or an AI assistant.
- **Roles, invites & notifications** — owner/admin/member roles, invite-only
  onboarding with a first-owner bootstrap, and in-app notifications.
- **White-labeling** — customizable system name, logo, favicon, and accent color.
- **Built-in MCP server** — let AI assistants read and edit your data over the
  Model Context Protocol ([docs](https://seederpm.xyz/docs/mcp)).

## Quick start

```bash
npm install
npm run setup   # interactive wizard: dev / production (node) / production (cloudflare)
npm run dev     # local dev — Miniflare simulates D1 + R2, no Cloudflare account
```

`npm run setup` generates the env + config (and, for the node target, the
PM2/systemd/Docker + reverse-proxy artifacts). On first run, create the owner
account at `/sign-in` — sign-up is permitted only for the configured
`OWNER_EMAIL` and only while the instance has no users; after that, onboarding is
invite-only.

Prefer to wire it up by hand? See the
[manual setup](https://seederpm.xyz/docs/getting-started/manual-setup) guide.

## Documentation

Everything lives at **[seederpm.xyz/docs](https://seederpm.xyz/docs)**:

- [Quickstart](https://seederpm.xyz/docs/getting-started/quickstart) — running locally in under a minute
- [Choosing a target](https://seederpm.xyz/docs/self-hosting/choosing-a-target) · [Deploy to Cloudflare](https://seederpm.xyz/docs/self-hosting/cloudflare) · [Self-host on a Node VM](https://seederpm.xyz/docs/self-hosting/node-vm)
- [Configuration](https://seederpm.xyz/docs/configuration/environment) — every environment variable and binding
- [MCP server](https://seederpm.xyz/docs/mcp) — connect Claude, Cursor, or ChatGPT to your workspace
- [Operations](https://seederpm.xyz/docs/operations/backup-restore) — backup/restore, upgrading, troubleshooting
- [Architecture](https://seederpm.xyz/docs/architecture) — how it's built, end to end

All documentation lives on the docs site — this README stays intentionally short.

## MCP server

Seeder ships a built-in [Model Context Protocol](https://modelcontextprotocol.io)
server at **`/api/mcp`**, so AI assistants can read and edit your projects,
tasks, requests, comments, and settings — it deploys with the app, so every
instance gets it for free. Mint a token at **Settings → API tokens** (read, or
read & write), then point your client at `https://<your-domain>/api/mcp` with the
token as a `Bearer` header. A token can never do more than the user who created
it, and every change shows in the Activity feed. Full tool list and setup:
[seederpm.xyz/docs/mcp](https://seederpm.xyz/docs/mcp).

## Support

Hit a bug or have an idea? Open an issue on
[GitHub](https://github.com/danielsyauqi/Seeder/issues), or email
[seeder.admin@gmail.com](mailto:seeder.admin@gmail.com).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for local
setup, the pre-PR checks (lint, type-check, tests, build), and conventions — CI
runs the same gates on every pull request.

## Security

Please report vulnerabilities privately via the process in
[SECURITY.md](SECURITY.md). Don't open public issues for security problems.

## Acknowledgements

A massive thank you to **Thaqif Rosdi ([@takippu](https://github.com/takippu))** —
Seeder grew out of his original idea, first built as **northstar-pm**, and it
wouldn't exist without it. 🙏

## License

[MIT](LICENSE) © 2026 Daniel Syauqi ([@danielsyauqi](https://github.com/danielsyauqi)) and Thaqif Rosdi ([@takippu](https://github.com/takippu))

The code is free to use, fork, and modify under MIT — just keep the copyright
notice and license intact (see [NOTICE](NOTICE)). The **Seeder name and logo**
are trademarks and are not covered by the MIT License: you can fork the code, but
not the brand. See [TRADEMARK.md](TRADEMARK.md).

---

Made by [@danielsyauqi](https://github.com/danielsyauqi) and [@takippu](https://github.com/takippu).
