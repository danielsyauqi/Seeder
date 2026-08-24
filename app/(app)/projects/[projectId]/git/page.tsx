import { notFound } from "next/navigation";

import { ProjectGitPanel } from "@/components/projects/project-git-panel";
import { requireViewer } from "@/lib/auth-server";
import { canAdministerProject } from "@/lib/authz";
import { getProjectForUser } from "@/lib/data";
import { listCommits, listConnections } from "@/lib/services/vcs";

// Lighter page pattern (no ProjectWorkspaceClientShell) — matches
// branches/page.tsx. The Git tab has no task-modal deep-linking of its own
// (the task Development panel lives inside the existing task modal, not
// here), so it doesn't need the workspace payload or branch-scoped state.
type ProjectGitPageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectGitPage({ params }: ProjectGitPageProps) {
  const viewer = await requireViewer();
  const { projectId } = await params;
  const project = await getProjectForUser(projectId, viewer);

  if (!project) {
    notFound();
  }

  const [canAdminister, connections, commits] = await Promise.all([
    canAdministerProject(viewer, projectId),
    listConnections(viewer, projectId),
    listCommits(viewer, projectId, { limit: 50 }),
  ]);

  return (
    <ProjectGitPanel
      projectId={projectId}
      canAdminister={canAdminister}
      connections={connections}
      commits={commits}
    />
  );
}
