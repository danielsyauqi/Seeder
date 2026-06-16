-- Allow many notes per project. The original table declared project_id UNIQUE
-- inline, and SQLite can't drop an inline constraint, so rebuild the table.
ALTER TABLE "project_notes" RENAME TO "project_notes_old";

CREATE TABLE "project_notes" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "owner_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "content" TEXT NOT NULL DEFAULT '',
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO "project_notes" ("id", "owner_id", "project_id", "content", "created_at", "updated_at")
  SELECT "id", "owner_id", "project_id", "content", "created_at", "updated_at"
  FROM "project_notes_old";

DROP TABLE "project_notes_old";

CREATE INDEX "project_notes_project_idx" ON "project_notes" ("project_id");
CREATE INDEX "project_notes_owner_idx" ON "project_notes" ("owner_id");
CREATE INDEX "project_notes_created_idx" ON "project_notes" ("created_at");
