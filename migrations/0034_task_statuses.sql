-- Custom task statuses (Jira-style per-project board columns) replace the fixed
-- todo/doing/done enum on tasks.
--
-- The tasks.status column was created in 0001 with a live CHECK constraint
-- (status IN ('todo','doing','done')) and has never been rebuilt, so it actively
-- rejects any custom value. We therefore:
--   1. create the task_statuses config table (per-project name/color/order +
--      isInitial / isTerminal flags),
--   2. seed Todo/Doing/Done for every existing project,
--   3. rebuild tasks 0012-style to drop the CHECK and replace `status` with a
--      `status_id` FK plus denormalized status_name / status_color / is_terminal,
--      mapping each existing task onto its project's seeded status.
--
-- defer_foreign_keys: the rebuild DROPs and RENAMEs tasks while daily_tasks
-- references tasks(id) and the new status_id FK references task_statuses(id);
-- deferring checks to COMMIT keeps the swap valid (matches 0001 / 0012).
PRAGMA defer_foreign_keys = true;

-- 1. Config table -----------------------------------------------------------
CREATE TABLE "task_statuses" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_terminal" INTEGER NOT NULL DEFAULT 0,
  "is_initial" INTEGER NOT NULL DEFAULT 0,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "task_statuses_project_name_idx"
  ON "task_statuses" ("project_id", "name");
CREATE INDEX "task_statuses_project_idx"
  ON "task_statuses" ("project_id");
CREATE INDEX "task_statuses_project_sort_idx"
  ON "task_statuses" ("project_id", "sort_order");

-- 2. Seed the legacy three statuses for every existing project. Names match the
-- CASE remap below; Todo is the initial column, Done is terminal.
INSERT INTO "task_statuses"
  (id, project_id, name, color, sort_order, is_terminal, is_initial, created_at, updated_at)
-- Colors are real PROJECT_SWATCHES values (lib/swatches.ts) so the seeded
-- statuses match what the swatch picker offers: Storm / Aether / Emerald.
SELECT lower(hex(randomblob(16))), p.id, 'Todo',  '#8a8f98', 0, 0, 1, unixepoch() * 1000, unixepoch() * 1000 FROM projects p
UNION ALL
SELECT lower(hex(randomblob(16))), p.id, 'Doing', '#5e6ad2', 1, 0, 0, unixepoch() * 1000, unixepoch() * 1000 FROM projects p
UNION ALL
SELECT lower(hex(randomblob(16))), p.id, 'Done',  '#27a644', 2, 1, 0, unixepoch() * 1000, unixepoch() * 1000 FROM projects p;

-- 3. Rebuild tasks without the CHECK, status -> status_id FK + denormalized
-- status fields. Column set mirrors lib/db/schema.ts exactly (priority keeps its
-- own CHECK from 0001).
CREATE TABLE "tasks_new" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "owner_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "branch_id" TEXT,
  "request_id" TEXT,
  "assignee_id" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "code_number" INTEGER,
  "category_id" TEXT,
  "category_name" TEXT,
  "category_color" TEXT,
  "phase" TEXT,
  "status_id" TEXT NOT NULL,
  "status_name" TEXT NOT NULL,
  "status_color" TEXT NOT NULL,
  "is_terminal" INTEGER NOT NULL DEFAULT 0,
  "priority" TEXT NOT NULL DEFAULT 'medium' CHECK ("priority" IN ('low', 'medium', 'high')),
  "due_date" INTEGER,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "status_changed_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY ("owner_id")    REFERENCES "user"("id")            ON DELETE CASCADE,
  FOREIGN KEY ("project_id")  REFERENCES "projects"("id")        ON DELETE CASCADE,
  FOREIGN KEY ("branch_id")   REFERENCES "branches"("id")        ON DELETE CASCADE,
  FOREIGN KEY ("request_id")  REFERENCES "client_requests"("id") ON DELETE SET NULL,
  FOREIGN KEY ("assignee_id") REFERENCES "user"("id")            ON DELETE SET NULL,
  FOREIGN KEY ("category_id") REFERENCES "task_categories"("id") ON DELETE SET NULL,
  FOREIGN KEY ("status_id")   REFERENCES "task_statuses"("id")
);

-- LEFT JOIN (not INNER): every task should match its project's seeded status, so
-- a null status_id would violate NOT NULL and abort the whole migration rather
-- than silently drop a row.
INSERT INTO "tasks_new" (
  id, owner_id, project_id, branch_id, request_id, assignee_id,
  title, description, code_number, category_id, category_name, category_color,
  phase, status_id, status_name, status_color, is_terminal,
  priority, due_date, sort_order, status_changed_at, created_at, updated_at
)
SELECT
  t.id, t.owner_id, t.project_id, t.branch_id, t.request_id, t.assignee_id,
  t.title, t.description, t.code_number, t.category_id, t.category_name, t.category_color,
  t.phase, ts.id, ts.name, ts.color, ts.is_terminal,
  t.priority, t.due_date, t.sort_order, t.status_changed_at, t.created_at, t.updated_at
FROM tasks t
LEFT JOIN task_statuses ts
  ON ts.project_id = t.project_id
  AND ts.name = CASE t.status
    WHEN 'todo'  THEN 'Todo'
    WHEN 'doing' THEN 'Doing'
    WHEN 'done'  THEN 'Done'
    ELSE 'Todo'
  END;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- Recreate every tasks index (status indexes now key on status_id).
CREATE INDEX "tasks_project_idx"            ON "tasks" ("project_id");
CREATE INDEX "tasks_branch_idx"             ON "tasks" ("branch_id");
CREATE INDEX "tasks_owner_idx"              ON "tasks" ("owner_id");
CREATE INDEX "tasks_assignee_idx"           ON "tasks" ("assignee_id");
CREATE INDEX "tasks_status_sort_idx"        ON "tasks" ("status_id", "sort_order");
CREATE INDEX "tasks_branch_status_sort_idx" ON "tasks" ("branch_id", "status_id", "sort_order");
CREATE INDEX "tasks_status_changed_at_idx"  ON "tasks" ("status_changed_at");
CREATE INDEX "tasks_request_idx"            ON "tasks" ("request_id");
CREATE INDEX "tasks_category_idx"           ON "tasks" ("category_id");
CREATE UNIQUE INDEX "tasks_project_code_idx"
  ON "tasks" ("project_id", "code_number") WHERE "code_number" IS NOT NULL;
