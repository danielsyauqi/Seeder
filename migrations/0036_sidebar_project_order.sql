-- Per-user sidebar project order. A JSON array of project ids the user has
-- arranged by drag-and-drop in the sidebar Project List. Nullable: a null/absent
-- value means "use the default order". Ids for projects the user can no longer
-- see are ignored on read; projects not listed fall to the end.
ALTER TABLE "user" ADD COLUMN "sidebar_project_order" TEXT;
