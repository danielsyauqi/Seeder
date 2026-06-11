import { AdminProjectsList } from "@/components/admin/admin-projects-list";
import { requireRole } from "@/lib/auth-server";
import { listAllProjects } from "@/lib/data-admin";

export const dynamic = "force-dynamic";

export default async function AdminProjectsPage() {
  await requireRole(["owner", "admin"]);
  const projects = await listAllProjects();

  return (
    <div className="space-y-6">
      <section className="ui-panel ui-header p-5 sm:p-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
          Admin · Projects
        </p>
        <h1 className="mt-2 text-[24px] font-medium tracking-[-0.022em] text-foreground">
          All projects
        </h1>
        <p className="mt-1 max-w-prose text-[13px] leading-6 text-muted">
          Every project across all users, newest activity first. Search by
          project, client, owner, or summary, and open any workspace directly.
        </p>
      </section>

      <AdminProjectsList projects={projects} />
    </div>
  );
}
