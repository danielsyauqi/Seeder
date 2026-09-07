import { notFound } from "next/navigation";

import { ActivityFeed } from "@/components/projects/activity-feed";
import {
  ProjectBoardSurface,
  ProjectMetricsStrip,
  ProjectNotesSurface,
  ProjectOverviewQuickLinks,
} from "@/components/projects/project-workspace";
import { ProjectWorkspaceClientShell } from "@/components/projects/project-workspace-ui";
import { requireViewer } from "@/lib/auth-server";
import { getProjectWorkspace } from "@/lib/data";
import { branchPath } from "@/lib/branch-path";

type ProjectOverviewPageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ branch?: string }>;
};

export default async function ProjectOverviewPage({
  params,
  searchParams,
}: ProjectOverviewPageProps) {
  const viewer = await requireViewer();
  const { projectId } = await params;
  const { branch } = await searchParams;
  const workspace = await getProjectWorkspace(projectId, viewer, branch);

  if (!workspace) {
    notFound();
  }

  const currentPath = branchPath(
    `/projects/${projectId}`,
    workspace.branches,
    workspace.currentBranchId,
  );

  return (
    <ProjectWorkspaceClientShell
      workspace={workspace}
      currentPath={currentPath}
      viewer={{ id: viewer.id, role: viewer.role }}
    >
      <ProjectMetricsStrip workspace={workspace} />

      {/* minmax(0,…) is required at every breakpoint: the board's flex track
          uses a percent-based flex-basis on shrink-0 columns. An implicit `auto`
          track or a bare `fr` track gives the grid item `min-width:auto`, which
          pins the item to the board's 872px min-content and lets that percentage
          run away. minmax(0,…) holds the min at 0 and breaks the loop. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,0.55fr)]">
        <ProjectBoardSurface workspace={workspace} currentPath={currentPath} preview />
        <ProjectNotesSurface workspace={workspace} currentPath={currentPath} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <ProjectOverviewQuickLinks projectId={projectId} />
        <ActivityFeed
          title="Recent activity"
          description="Small timeline of the latest changes inside this workspace."
          items={workspace.activity}
        />
      </div>
    </ProjectWorkspaceClientShell>
  );
}
