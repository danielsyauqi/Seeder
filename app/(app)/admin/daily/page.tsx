import { AdminDailyOps } from "@/components/daily/admin-daily-ops";
import type { PlannerProject } from "@/components/daily/daily-item-modal";
import { requireRole } from "@/lib/auth-server";
import { formatDateKey, parseDateKey } from "@/lib/daily";
import { getDailyPlannerProjects } from "@/lib/data";
import { getDailyOpsForDate, listUsersBrief } from "@/lib/data-admin";
import { VCS_BOT_USER_ID } from "@/lib/services/vcs/constants";

export const dynamic = "force-dynamic";

type AdminDailyPageProps = {
  searchParams: Promise<{ date?: string | string[]; view?: string | string[] }>;
};

function toSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminDailyPage({
  searchParams,
}: AdminDailyPageProps) {
  const viewer = await requireRole(["owner", "admin"]);
  const resolved = await searchParams;
  const anchor = parseDateKey(toSingleParam(resolved.date));
  const dateKey = formatDateKey(anchor);
  const view = toSingleParam(resolved.view) === "table" ? "table" : "board";

  const [rows, workspaceUsers, projects] = await Promise.all([
    getDailyOpsForDate(anchor),
    listUsersBrief(),
    getDailyPlannerProjects(viewer.id),
  ]);
  const users = workspaceUsers.filter((user) => user.id !== VCS_BOT_USER_ID);

  const items = rows.map((row) => ({
    id: row.id,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    createdById: row.createdById,
    createdByName: row.createdByName,
    title: row.title,
    status: row.status,
    priority: row.priority,
    kind: row.kind,
    projectName: row.projectName,
    projectColor: row.projectColor,
    linkedTaskId: row.linkedTaskId,
    linkedStatus: row.linkedStatus,
    linkedStatusColor: row.linkedStatusColor,
    batchId: row.batchId,
  }));

  const plannerProjects: PlannerProject[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    tasks: project.tasks,
  }));

  return (
    <AdminDailyOps
      dateKey={dateKey}
      view={view}
      users={users}
      items={items}
      projects={plannerProjects}
    />
  );
}
