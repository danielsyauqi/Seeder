# Changelog

## 2.1.0 — 2026-09-14

### Git integration

- Connect GitHub or GitLab repositories with a repository URL and read-only token.
- Link commits and branches to tasks and client requests by ticket code. Choose
  branch-based linking or codes in individual commit messages.
- Backfill recent commits on connect and receive new activity through webhooks.
- View project Git activity, task development details, and branch/latest-commit
  badges on task cards. Linking does not automatically change task statuses.

### MCP and workspace improvements

- Add client-specific token setup guides for Claude, Codex, Cursor, and Gemini.
- Add the read-only `list-commits` MCP tool for project and task commit history.
- Reduce MCP read-response size and bound workspace reads.
- Add navigation progress and immediate sidebar feedback.
- Fix responsive Kanban flicker, scrolling, empty-column drops, and project loading.
- Improve Enter-key support and add admin user search and deactivated-user deletion.
- Publish official amd64/arm64 Docker images on GHCR and Docker Hub.

### Upgrade requirements

- Back up the database and uploads before upgrading.
- Set `VCS_ENCRYPTION_KEY` before starting 2.1 wherever `BETTER_AUTH_URL` is set,
  even if no Git repository is connected. Generate a separate key with
  `openssl rand -base64 32`, then store it in Worker secrets or the Node/Docker
  environment. Preserve an existing key from development builds; replacing it
  makes stored provider tokens and webhook secrets unreadable.
- Apply all pending migrations before serving the new code, including
  `0038_vcs_core.sql` and `0039_activity_entity_add_commit.sql`. Official Docker
  images apply migrations on startup.
- Source installations use Node 24 and npm 11.
- See the [upgrade guide](https://seederpm.xyz/docs/operations/upgrading).

### Contributors

Thanks to Timothy Duong for Docker support and Manuele J. Sarfatti for the
responsive board fix and navigation progress experience.
