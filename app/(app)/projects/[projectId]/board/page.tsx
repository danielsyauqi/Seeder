import { notFound, redirect } from "next/navigation";

import { BoardAutoRefresh } from "@/components/projects/board-auto-refresh";
import {
  ProjectBoardSurface,
  ProjectMetricsStrip,
} from "@/components/projects/project-workspace";
import { ProjectWorkspaceClientShell } from "@/components/projects/project-workspace-ui";
import { requireViewer } from "@/lib/auth-server";
import { getProjectWorkspace, getTaskBranchId } from "@/lib/data";
import { branchPath } from "@/lib/branch-path";
import { withSearchParams } from "@/lib/utils";

type ProjectBoardPageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ branch?: string; modal?: string; task?: string }>;
};

const TASK_MODALS = new Set(["task", "status-update", "delete-task"]);

export default async function ProjectBoardPage({
  params,
  searchParams,
}: ProjectBoardPageProps) {
  const viewer = await requireViewer();
  const { projectId } = await params;
  const { branch, modal, task } = await searchParams;
  const workspace = await getProjectWorkspace(projectId, viewer, branch);

  if (!workspace) {
    notFound();
  }

  // A task deep-link (notification, search, activity) may target a task on a
  // different branch than the one resolved here. If the modal task isn't on the
  // current branch, redirect to the branch that actually holds it so the modal
  // resolves. (getTaskBranchId returns null for a deleted task → no redirect.)
  if (
    task &&
    modal &&
    TASK_MODALS.has(modal) &&
    !workspace.tasks.some((t) => t.id === task)
  ) {
    const taskBranchId = await getTaskBranchId(projectId, task, viewer);
    if (taskBranchId && taskBranchId !== workspace.currentBranchId) {
      const taskBranch = workspace.branches.find((b) => b.id === taskBranchId);
      redirect(
        withSearchParams(`/projects/${projectId}/board`, {
          branch: taskBranch?.isDefault ? null : taskBranchId,
          modal,
          task,
        }),
      );
    }
  }

  const currentPath = branchPath(
    `/projects/${projectId}/board`,
    workspace.branches,
    workspace.currentBranchId,
  );

  return (
    <ProjectWorkspaceClientShell
      workspace={workspace}
      currentPath={currentPath}
      viewer={{ id: viewer.id, role: viewer.role }}
    >
      <BoardAutoRefresh
        projectId={workspace.project.id}
        initialVersion={workspace.project.updatedAt?.getTime() ?? 0}
      />
      <ProjectMetricsStrip workspace={workspace} />
      <ProjectBoardSurface workspace={workspace} currentPath={currentPath} />
    </ProjectWorkspaceClientShell>
  );
}
