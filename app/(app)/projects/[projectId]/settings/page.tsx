import { notFound } from "next/navigation";

import {
  ProjectSettingsSurface,
} from "@/components/projects/project-workspace";
import { ProjectWorkspaceClientShell } from "@/components/projects/project-workspace-ui";
import { requireViewer } from "@/lib/auth-server";
import { canAdministerProject } from "@/lib/authz";
import { getProjectWorkspace } from "@/lib/data";
import { listConnections } from "@/lib/services/vcs";

type ProjectSettingsPageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectSettingsPage({
  params,
}: ProjectSettingsPageProps) {
  const viewer = await requireViewer();
  const { projectId } = await params;
  const workspace = await getProjectWorkspace(projectId, viewer);

  if (!workspace) {
    notFound();
  }

  const [canAdminister, vcsConnections] = await Promise.all([
    canAdministerProject(viewer, projectId),
    listConnections(viewer, projectId),
  ]);

  const currentPath = `/projects/${projectId}/settings`;

  return (
    <ProjectWorkspaceClientShell
      workspace={workspace}
      currentPath={currentPath}
      viewer={{ id: viewer.id, role: viewer.role }}
    >
      <ProjectSettingsSurface
        workspace={workspace}
        currentPath={currentPath}
        canAdminister={canAdminister}
        vcsConnections={vcsConnections}
      />
    </ProjectWorkspaceClientShell>
  );
}
