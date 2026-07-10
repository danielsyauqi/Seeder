-- VCS Sync Phase 0: core tables for connecting a GitHub/GitLab (Gitea later)
-- repo to a project, receiving webhook pushes, and linking commits/branches to
-- tasks/requests by ticket code. See docs/vcs-sync-phase-0-1-spec.md.
--
-- vcs_refs is deliberately separate from the existing "branches" table
-- (git-like workstreams inside a project, migration 0030) -- a remote branch
-- is tracked metadata only; deleting it flips state='deleted' and never
-- cascades to tasks or the internal branches entity.

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

-- "Git integration" bot user (0.6): a permanent sentinel used to attribute
-- project_activity rows for commits whose author isn't a Seeder member
-- (project_activity.owner_id is NOT NULL REFERENCES user(id) ON DELETE
-- CASCADE, so every activity row needs a real user id). Fixed id 'vcs-bot',
-- exported as VCS_BOT_USER_ID from lib/services/vcs/constants.ts. No
-- "account" row is inserted, so it can never sign in regardless of role.
INSERT INTO "user" ("id", "name", "email", "email_verified")
VALUES ('vcs-bot', 'Git integration', 'git-integration@seeder.local', 1);
