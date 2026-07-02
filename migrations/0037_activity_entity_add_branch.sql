-- Add 'branch' to the project_activity.entity_type CHECK constraint.
--
-- Migration 0030 introduced git-like branches and the app writes branch
-- lifecycle events to the activity feed with entity_type = 'branch' (see
-- lib/services/branches.ts and the activityEntityValues enum in
-- lib/db/schema.ts). But the CHECK constraint from migration 0003 still only
-- allowed ('project','request','task','note'), so every createBranch /
-- renameBranch / deleteBranch / moveTaskToBranch failed at the DB with
-- "CHECK constraint failed: entity_type". This realigns the constraint with
-- the application enum.
--
-- SQLite can't ALTER a CHECK constraint, so we rebuild the table. It is a leaf
-- audit table (only outbound FKs to user/projects; nothing references it), so
-- dropping and recreating is safe and cascades nothing. The new definition
-- reproduces the live schema exactly (0003 + the "changes" column added by
-- 0018), changing only the entity_type CHECK to include 'branch'.

CREATE TABLE "project_activity_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "owner_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "entity_type" TEXT NOT NULL CHECK ("entity_type" IN ('project', 'request', 'task', 'note', 'branch')),
  "entity_id" TEXT NOT NULL,
  "action" TEXT NOT NULL CHECK ("action" IN ('created', 'updated', 'deleted', 'archived', 'restored', 'duplicated', 'converted', 'moved')),
  "label" TEXT NOT NULL,
  "detail" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "changes" TEXT
);

INSERT INTO "project_activity_new"
  ("id", "owner_id", "project_id", "entity_type", "entity_id", "action", "label", "detail", "created_at", "changes")
SELECT
  "id", "owner_id", "project_id", "entity_type", "entity_id", "action", "label", "detail", "created_at", "changes"
FROM "project_activity";

DROP TABLE "project_activity";

ALTER TABLE "project_activity_new" RENAME TO "project_activity";

CREATE INDEX "project_activity_owner_idx" ON "project_activity" ("owner_id");
CREATE INDEX "project_activity_project_idx" ON "project_activity" ("project_id");
CREATE INDEX "project_activity_created_idx" ON "project_activity" ("created_at");
