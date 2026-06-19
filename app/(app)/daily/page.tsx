import { DailyPlanner } from "@/components/daily/daily-planner";
import type {
  PlannerItem,
  PlannerProject,
} from "@/components/daily/daily-item-modal";
import { requireViewer } from "@/lib/auth-server";
import {
  formatDateKey,
  getWeekDays,
  parseDateKey,
  startOfDay,
} from "@/lib/daily";
import { getDailyPlannerProjects, getDailyTasksForUser } from "@/lib/data";

export const dynamic = "force-dynamic";

type DailyPageProps = {
  searchParams: Promise<{ date?: string | string[] }>;
};

function toSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DailyPage({ searchParams }: DailyPageProps) {
  const viewer = await requireViewer();
  const resolved = await searchParams;
  const anchor = parseDateKey(toSingleParam(resolved.date));
  const anchorKey = formatDateKey(anchor);

  const weekDays = getWeekDays(anchor);
  const today = startOfDay(new Date());

  // For the week that contains today, start the view at today (you plan
  // forward, not into past days). Other weeks show the full Mon–Sun.
  const todayInWeek =
    today.getTime() >= weekDays[0].getTime() &&
    today.getTime() <= weekDays[6].getTime();
  const visibleDays = todayInWeek
    ? weekDays.filter((day) => day.getTime() >= today.getTime())
    : weekDays;

  const rangeStart = visibleDays[0];
  const lastDay = visibleDays[visibleDays.length - 1];
  const rangeEndExclusive = new Date(
    lastDay.getFullYear(),
    lastDay.getMonth(),
    lastDay.getDate() + 1,
  );
  const dayKeys = visibleDays.map(formatDateKey);

  const [rows, projects] = await Promise.all([
    getDailyTasksForUser(viewer.id, rangeStart, rangeEndExclusive),
    getDailyPlannerProjects(viewer.id),
  ]);

  const items: PlannerItem[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    kind: row.kind,
    projectId: row.projectId,
    projectName: row.projectName,
    projectColor: row.projectColor,
    projectCode: row.projectCode,
    linkedTaskId: row.linkedTaskId,
    linkedStatus: row.linkedStatus,
    linkedStatusColor: row.linkedStatusColor,
    boardHref: row.boardHref,
    dateKey: row.dateKey,
  }));

  const plannerProjects: PlannerProject[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    tasks: project.tasks,
  }));

  return (
    <DailyPlanner
      anchorKey={anchorKey}
      dayKeys={dayKeys}
      items={items}
      projects={plannerProjects}
    />
  );
}
