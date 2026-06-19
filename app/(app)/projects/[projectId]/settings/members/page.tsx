import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { MemberAccessControl } from "@/components/projects/member-access-control";
import { MembersManager } from "@/components/projects/members-manager";
import { requireViewer } from "@/lib/auth-server";
import {
  canAccessProject,
  canAdministerProject,
  canManageProjectMembers,
  PROJECT_CAPABILITIES,
  resolveMemberPermissions,
} from "@/lib/authz";
import { getDb } from "@/lib/db";
import { projectMembers, projects, user } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectMembersPage({ params }: PageProps) {
  const viewer = await requireViewer();
  const { projectId } = await params;

  if (!(await canAccessProject(viewer, projectId))) {
    notFound();
  }

  const [canManage, canAdminister] = await Promise.all([
    canManageProjectMembers(viewer, projectId),
    canAdministerProject(viewer, projectId),
  ]);

  const db = getDb();
  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      ownerId: projects.ownerId,
      memberPermissions: projects.memberPermissions,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) notFound();

  const [ownerRow, members] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        image: user.image,
      })
      .from(user)
      .where(eq(user.id, project.ownerId))
      .limit(1),
    db
      .select({
        membershipId: projectMembers.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        projectRole: projectMembers.role,
        image: user.image,
        addedAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(user, eq(user.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(desc(projectMembers.createdAt)),
  ]);

  const owner = ownerRow[0]
    ? {
        userId: ownerRow[0].id,
        name: ownerRow[0].name,
        email: ownerRow[0].email,
        role: ownerRow[0].role,
        image: ownerRow[0].image,
      }
    : null;

  const memberPermissions = resolveMemberPermissions(project.memberPermissions);

  return (
    <div className="space-y-6">
      <MembersManager
        projectId={project.id}
        owner={owner}
        canManage={canManage}
        canAdminister={canAdminister}
        members={members.map((m) => ({
          membershipId: m.membershipId,
          userId: m.userId,
          name: m.name,
          email: m.email,
          role: m.role,
          projectRole: m.projectRole,
          image: m.image,
          addedAt: m.addedAt,
        }))}
      />

      {canManage ? (
        <MemberAccessControl
          projectId={project.id}
          capabilities={PROJECT_CAPABILITIES.map((c) => ({
            key: c.key,
            label: c.label,
            description: c.description,
            group: c.group,
            defaultForMember: c.defaultForMember,
          }))}
          permissions={memberPermissions}
          canManage={canManage}
        />
      ) : null}
    </div>
  );
}
