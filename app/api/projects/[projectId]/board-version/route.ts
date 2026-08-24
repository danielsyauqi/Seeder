import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getViewer } from "@/lib/auth-server";
import { canAccessProject } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";

// Cheap change-detection poll for the project board. Returns a monotonically
// increasing `version` (projects.updatedAt in epoch ms) that bumps on every
// task/request/branch mutation — from the web route OR the MCP server, which run
// the same service code and touch projects.updatedAt in the same atomic batch as
// the write (see lib/services/{tasks,requests,branches}.ts). The board client
// polls this and calls router.refresh() when the version advances, so an
// MCP-created (or teammate-created) task appears without a manual reload.
//
// It is a single-row primary-key lookup, so it stays cheap at a few-seconds
// cadence — deliberately lighter than re-rendering the whole force-dynamic board
// on every tick. Not branch-scoped: a write on any branch bumps the signal, and
// a refresh that finds no change to the current branch is a no-op (the board is
// keyed on task data, so it only remounts when something actually changed).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId } = await params;
  if (!(await canAccessProject(viewer, projectId))) {
    // Don't distinguish "no access" from "missing" — same opaque 404.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getDb();
  const [project] = await db
    .select({ updatedAt: projects.updatedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const version = project.updatedAt ? project.updatedAt.getTime() : 0;
  return NextResponse.json(
    { version },
    { headers: { "cache-control": "no-store" } },
  );
}
