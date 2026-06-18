import { notFound } from "next/navigation";
import { GitBranch } from "@phosphor-icons/react/dist/ssr";

import { BranchIndexList } from "@/components/projects/branch-index-list";
import { CreateBranchModal } from "@/components/projects/create-branch-modal";
import { requireViewer } from "@/lib/auth-server";
import { canManageProject } from "@/lib/authz";
import { getProjectForUser } from "@/lib/data";
import { listBranches } from "@/lib/services/branches";

type ProjectBranchesPageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectBranchesPage({
  params,
}: ProjectBranchesPageProps) {
  const viewer = await requireViewer();
  const { projectId } = await params;
  const project = await getProjectForUser(projectId, viewer);

  if (!project) {
    notFound();
  }

  const [branches, canManage] = await Promise.all([
    listBranches(viewer, { projectId }),
    canManageProject(viewer, projectId),
  ]);

  return (
    <section className="ui-panel p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-foreground">
            <GitBranch className="size-4" />
            Branches
          </div>
          <p className="max-w-2xl text-[13px] leading-6 text-muted">
            Each branch is its own set of tasks and requirements. Pick one to
            open its board, or split a feature off Main into a new branch. All
            branches are visible to every project member.
          </p>
        </div>
        <CreateBranchModal projectId={projectId} />
      </div>

      <BranchIndexList
        projectId={projectId}
        branches={branches}
        viewerId={viewer.id}
        canManage={canManage}
      />
    </section>
  );
}
