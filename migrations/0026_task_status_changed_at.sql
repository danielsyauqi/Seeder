ALTER TABLE "tasks" ADD COLUMN "status_changed_at" INTEGER;
UPDATE "tasks" SET "status_changed_at" = "updated_at";
CREATE INDEX "tasks_status_changed_at_idx" ON "tasks" ("status_changed_at");
