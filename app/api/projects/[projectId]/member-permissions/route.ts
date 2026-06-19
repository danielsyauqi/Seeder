import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireViewer } from "@/lib/auth-server";
import { canManageProject } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
  isProjectCapability,
  packMemberPermissions,
  resolveMemberPermissions,
} from "@/lib/project-capabilities";

// Save the per-project "Member Access" toggles. Editing them is Leader-level
// (canManageProject = owner / leader / workspace admin) — a Member can never
// widen their own access. Only known capability keys are accepted; the stored
// value keeps just the toggles that differ from the code defaults (null when
// none), so future default changes still reach untouched projects.
const bodySchema = z.object({
  permissions: z.record(z.string(), z.boolean()),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const viewer = await requireViewer();
  const { projectId } = await params;

  if (!(await canManageProject(viewer, projectId))) {
    return NextResponse.json(
      { error: "Only the project owner, a leader, or an admin can change Member Access." },
      { status: 403 },
    );
  }

  const db = getDb();
  // Existence check: canManageProject short-circuits to true for workspace
  // admins without confirming the project exists, so guard against a no-op
  // update + misleading {ok:true} on a bogus id.
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  // Reject unknown/misspelled capability keys instead of silently dropping them
  // (which would report success while changing nothing).
  const unknown = Object.keys(body.permissions).filter(
    (key) => !isProjectCapability(key),
  );
  if (unknown.length) {
    return NextResponse.json(
      { error: `Unknown capability: ${unknown.join(", ")}` },
      { status: 400 },
    );
  }

  const resolved = resolveMemberPermissions(JSON.stringify(body.permissions));
  await db
    .update(projects)
    .set({ memberPermissions: packMemberPermissions(resolved) })
    .where(eq(projects.id, projectId));

  revalidatePath(`/projects/${projectId}/settings/members`);
  return NextResponse.json({ ok: true });
}
