ALTER TABLE "projects" ADD COLUMN "client_share_show_board" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "projects" ADD COLUMN "client_share_show_description" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "projects" ADD COLUMN "client_share_show_commits" INTEGER NOT NULL DEFAULT 1;
