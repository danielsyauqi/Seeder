// Seed a realistic demo workspace into the database, for development and docs.
//
// Usage:  npm run db:seed:demo:local   (local Miniflare D1)
//         npm run db:seed:demo:node    (node-mode SQLite file at SQLITE_DB_PATH)
//
// Populates a focused DevFest showcase workspace on top of the owner account:
// exactly 2 demo projects, one internal feature branch, tasks spread across
// every board column, and a complete seven-day plan for the owner and every
// teammate. Git-provider connections and commit metadata are intentionally not
// seeded so the VCS flow can be connected live during the demo.
//
// Idempotent: every row has a stable id and is inserted with INSERT OR IGNORE, so
// re-running adds nothing new. Timestamps are computed relative to now, so the
// Today / Daily / Dashboard views look fresh whenever you run it.
//
// The owner is resolved by email (OWNER_EMAIL, default admin@admin.com) rather
// than a hard-coded id, so it works on any machine. Create the owner first with
// `npm run db:seed:local` (or the one-time /sign-in bootstrap form).

import { createHash } from "node:crypto";

import { execSql, queryRows } from "./seed-db";

const OWNER_EMAIL = (
  process.env.SEED_EMAIL ??
  process.env.OWNER_EMAIL ??
  "admin@admin.com"
).toLowerCase();

// ---------- SQL value helpers ----------
type Raw = { __raw: string };
const raw = (sql: string): Raw => ({ __raw: sql });
const isRaw = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && "__raw" in v;

const esc = (value: string) => value.replace(/'/g, "''");
function q(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (isRaw(value)) return value.__raw;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${esc(String(value))}'`;
}

// Owner id resolved at query time — portable across machines.
const OWNER = raw(`(SELECT id FROM user WHERE email = '${esc(OWNER_EMAIL)}')`);

// ---------- relative timestamps (ms) ----------
const NOW = Date.now();
const DAY = 86_400_000;
const ms = (days = 0) => Math.round(NOW + days * DAY);
const _t = new Date();
const SOD = new Date(_t.getFullYear(), _t.getMonth(), _t.getDate()).getTime();
const day = (off = 0) => SOD + off * DAY; // start-of-day, offset in days

// ---------- TipTap (ProseMirror) rich-text helpers ----------
type Node = Record<string, unknown>;
const txt = (text: string, marks?: Node[]): Node =>
  marks ? { type: "text", text, marks } : { type: "text", text };
const para = (...kids: Node[]): Node => ({ type: "paragraph", content: kids });
const heading = (level: number, ...kids: Node[]): Node => ({
  type: "heading",
  attrs: { level },
  content: kids,
});
const bullet = (...items: string[]): Node => ({
  type: "bulletList",
  content: items.map((i) => ({
    type: "listItem",
    content: [para(txt(i))],
  })),
});
const cell = (header: boolean, text: string): Node => ({
  type: header ? "tableHeader" : "tableCell",
  content: [para(txt(text))],
});
const table = (head: string[], ...rows: string[][]): Node => ({
  type: "table",
  content: [
    { type: "tableRow", content: head.map((h) => cell(true, h)) },
    ...rows.map((r) => ({
      type: "tableRow",
      content: r.map((c) => cell(false, c)),
    })),
  ],
});
const doc = (...nodes: Node[]) =>
  JSON.stringify({ type: "doc", content: nodes });
const BOLD = [{ type: "bold" }];
const ITALIC = [{ type: "italic" }];
const link = (href: string) => [{ type: "link", attrs: { href } }];
// A doc of plain paragraphs split on newlines.
const simple = (text: string) =>
  doc(...text.split("\n").map((line) => para(txt(line))));

// ---------- INSERT builder ----------
const statements: string[] = [];
function insert(
  table: string,
  cols: string[],
  rows: Record<string, unknown>[],
  // "ignore" (default) keeps existing rows untouched on a re-run. "replace"
  // re-writes rows by id — use it for date-sensitive data (e.g. the daily plan)
  // so re-seeding refreshes planned_date/status to land on the current week.
  conflict: "ignore" | "replace" = "ignore",
) {
  if (!rows.length) return;
  const values = rows
    .map((r) => `  (${cols.map((c) => q(r[c])).join(", ")})`)
    .join(",\n");
  const verb = conflict === "replace" ? "REPLACE" : "IGNORE";
  statements.push(
    `INSERT OR ${verb} INTO ${table} (${cols.join(", ")}) VALUES\n${values};`,
  );
}

// ===================== USERS (teammates) =====================
const users = [
  { id: "demo-user-maya", name: "Maya Lawson", email: "maya@seeder.dev", role: "admin", created_at: ms(-120) },
  { id: "demo-user-arjun", name: "Arjun Patel", email: "arjun@seeder.dev", role: "member", created_at: ms(-95) },
  { id: "demo-user-lena", name: "Lena Fischer", email: "lena@seeder.dev", role: "member", created_at: ms(-60) },
  { id: "demo-user-tomas", name: "Tomas Rivera", email: "tomas@seeder.dev", role: "member", created_at: ms(-30) },
];
insert(
  "user",
  ["id", "name", "email", "email_verified", "image", "role", "disabled_at", "created_at", "updated_at"],
  users.map((u) => ({ ...u, email_verified: 1, image: null, disabled_at: null, updated_at: u.created_at })),
);

// ===================== SPACES =====================
// The owner's Personal space is provisioned at signup / by migration 0032. Give
// the teammates a Personal space too, plus a shared ALPHV Company space led by
// Maya. Both showcase projects live there so team access is immediately visible.
const ALPHV_SPACE = "demo-space-alphv";
const ADMIN_PERSONAL = raw(
  `(SELECT id FROM spaces WHERE kind = 'personal' AND owner_id = ${OWNER.__raw})`,
);
insert(
  "spaces",
  ["id", "kind", "name", "owner_id", "lead_id", "created_by", "created_at", "updated_at"],
  [
    { id: "demo-space-maya-personal", kind: "personal", name: "Personal", owner_id: "demo-user-maya", lead_id: null, created_by: "demo-user-maya", created_at: ms(-120), updated_at: ms(-120) },
    { id: "demo-space-arjun-personal", kind: "personal", name: "Personal", owner_id: "demo-user-arjun", lead_id: null, created_by: "demo-user-arjun", created_at: ms(-95), updated_at: ms(-95) },
    { id: "demo-space-lena-personal", kind: "personal", name: "Personal", owner_id: "demo-user-lena", lead_id: null, created_by: "demo-user-lena", created_at: ms(-60), updated_at: ms(-60) },
    { id: "demo-space-tomas-personal", kind: "personal", name: "Personal", owner_id: "demo-user-tomas", lead_id: null, created_by: "demo-user-tomas", created_at: ms(-30), updated_at: ms(-30) },
    { id: ALPHV_SPACE, kind: "company", name: "ALPHV", owner_id: null, lead_id: "demo-user-maya", created_by: OWNER, created_at: ms(-110), updated_at: ms(-2) },
  ],
);
insert(
  "space_members",
  ["id", "space_id", "user_id", "added_by_id", "created_at"],
  [
    { id: "demo-sm-alphv-maya", space_id: ALPHV_SPACE, user_id: "demo-user-maya", added_by_id: OWNER, created_at: ms(-110) },
    { id: "demo-sm-alphv-arjun", space_id: ALPHV_SPACE, user_id: "demo-user-arjun", added_by_id: "demo-user-maya", created_at: ms(-100) },
    { id: "demo-sm-alphv-lena", space_id: ALPHV_SPACE, user_id: "demo-user-lena", added_by_id: "demo-user-maya", created_at: ms(-90) },
    { id: "demo-sm-alphv-tomas", space_id: ALPHV_SPACE, user_id: "demo-user-tomas", added_by_id: "demo-user-maya", created_at: ms(-80) },
  ],
);

// ===================== PROJECTS =====================
const AURORA = "demo-proj-aurora";
const ATLAS = "demo-proj-atlas";
const AURORA_TOKEN = "showcaseBoard_3kP9xZ2mQ7wL5vN8rT6yH1";
const projects = [
  { id: AURORA, name: "Seeder DevFest Showcase", slug: "SHOWCASE", client_name: "GDG Kuala Lumpur", summary: "Prepare and present Seeder's Google sign-in, Gemini MCP, internal branches, and Git-linked project workflow for DevFest KL 2026.", status: "development", color: "#6366f1", deadline: day(7), client_share_enabled: 1, client_share_token: AURORA_TOKEN, created_at: ms(-30) },
  { id: ATLAS, name: "ALPHV Client Portal", slug: "CLIENT", client_name: "ALPHV Delivery", summary: "Production client workspace for delivery tracking, weekly reporting, support handoff, and operational follow-through.", status: "production", color: "#0ea5e9", deadline: day(14), client_share_enabled: 0, client_share_token: null, created_at: ms(-80) },
];
insert(
  "projects",
  ["id", "owner_id", "space_id", "name", "slug", "client_name", "summary", "status", "deadline", "color", "archived_at", "client_share_enabled", "client_share_token", "created_at", "updated_at"],
  // Default every project into the owner's Personal space on a fresh insert; the
  // explicit UPDATEs below then place them authoritatively (also fixes an
  // already-seeded DB where INSERT OR IGNORE skips the rows).
  projects.map((p) => ({ ...p, owner_id: OWNER, space_id: ADMIN_PERSONAL, archived_at: null, updated_at: ms(-2) })),
);
statements.push(
  `UPDATE projects SET space_id = '${ALPHV_SPACE}' WHERE id IN ('${AURORA}', '${ATLAS}');`,
);

// ===================== TASK CATEGORIES =====================
const cats = [
  { id: "cat-a-design", project_id: AURORA, name: "Story & Design", color: "#ec4899" },
  { id: "cat-a-front", project_id: AURORA, name: "Product Demo", color: "#6366f1" },
  { id: "cat-a-back", project_id: AURORA, name: "Integrations", color: "#10b981" },
  { id: "cat-b-data", project_id: ATLAS, name: "Client Delivery", color: "#0ea5e9" },
  { id: "cat-b-infra", project_id: ATLAS, name: "Platform Ops", color: "#64748b" },
];
const CAT = Object.fromEntries(cats.map((c) => [c.id, c]));
insert(
  "task_categories",
  ["id", "project_id", "name", "color", "created_at", "updated_at"],
  cats.map((c) => ({ ...c, created_at: ms(-100), updated_at: ms(-100) })),
);

// ===================== BRANCHES =====================
// Demo projects are inserted directly (bypassing createProject), so seed their
// Main branch here — plus one feature branch on Aurora so Main vs feature show
// a different set of work, all on STABLE ids that the demo tasks/requests below
// reference.
const AURORA_MAIN = "demo-branch-aurora-main";
const ATLAS_MAIN = "demo-branch-atlas-main";
const AURORA_FEATURE = "demo-branch-showcase-devfest";
const MAIN: Record<string, string> = {
  [AURORA]: AURORA_MAIN,
  [ATLAS]: ATLAS_MAIN,
};
// If a demo project was seeded BEFORE this script grew branch support, migration
// 0030 backfilled its Main with a RANDOM id. That random Main occupies the
// one-default-per-project slot (partial-unique branches_project_default_idx), so
// our stable-id Main below would be silently dropped by INSERT OR IGNORE,
// orphaning every demo task/request behind a dangling branch_id. Delete any such
// non-stable default first (cascading its rows, which the INSERT OR IGNOREs
// below re-create on the stable Main) so our deterministic ids always win. No-op
// on a fresh DB and on a clean re-run.
statements.push(
  `DELETE FROM branches WHERE is_default = 1 AND project_id IN ('${AURORA}', '${ATLAS}') AND id NOT IN ('${AURORA_MAIN}', '${ATLAS_MAIN}');`,
);
insert(
  "branches",
  ["id", "project_id", "name", "description", "created_by", "is_default", "created_at", "updated_at"],
  [
    { id: AURORA_MAIN, project_id: AURORA, name: "Main", description: null, created_by: OWNER, is_default: 1, created_at: ms(-110), updated_at: ms(-2) },
    { id: ATLAS_MAIN, project_id: ATLAS, name: "Main", description: null, created_by: OWNER, is_default: 1, created_at: ms(-80), updated_at: ms(-2) },
    { id: AURORA_FEATURE, project_id: AURORA, name: "showcase/devfest-demo", description: "Branch-scoped work for rehearsing the DevFest demo without mixing it into the Main showcase plan.", created_by: "demo-user-arjun", is_default: 0, created_at: ms(-7), updated_at: ms(-1) },
  ],
);

// ===================== PROJECT MEMBERS =====================
// The owner stays implicit through projects.owner_id. Maya leads both projects;
// every other teammate is present so Admin Daily Ops and project assignment
// views tell a complete team story.
insert(
  "project_members",
  ["id", "project_id", "user_id", "role", "added_by_id", "created_at"],
  [
    { id: "demo-pm-aurora-maya", project_id: AURORA, user_id: "demo-user-maya", role: "leader", added_by_id: OWNER, created_at: ms(-100) },
    { id: "demo-pm-aurora-arjun", project_id: AURORA, user_id: "demo-user-arjun", role: "member", added_by_id: OWNER, created_at: ms(-90) },
    { id: "demo-pm-aurora-lena", project_id: AURORA, user_id: "demo-user-lena", role: "member", added_by_id: OWNER, created_at: ms(-80) },
    { id: "demo-pm-aurora-tomas", project_id: AURORA, user_id: "demo-user-tomas", role: "member", added_by_id: OWNER, created_at: ms(-70) },
    { id: "demo-pm-atlas-maya", project_id: ATLAS, user_id: "demo-user-maya", role: "leader", added_by_id: OWNER, created_at: ms(-75) },
    { id: "demo-pm-atlas-arjun", project_id: ATLAS, user_id: "demo-user-arjun", role: "member", added_by_id: OWNER, created_at: ms(-70) },
    { id: "demo-pm-atlas-lena", project_id: ATLAS, user_id: "demo-user-lena", role: "member", added_by_id: OWNER, created_at: ms(-65) },
    { id: "demo-pm-atlas-tomas", project_id: ATLAS, user_id: "demo-user-tomas", role: "member", added_by_id: OWNER, created_at: ms(-60) },
  ],
);

// ===================== TASKS =====================
const HERO = "demo-task-a1";
const heroDesc = doc(
  heading(2, txt("Goal")),
  para(
    txt("Record a "),
    txt("clear 90-second demo", BOLD),
    txt(" that proves Seeder connects team planning, internal branches, Git activity, and Gemini through MCP. Keep the story "),
    txt("concrete and credible", ITALIC),
    txt("."),
  ),
  heading(3, txt("Scope")),
  bullet(
    "Open with the disconnected-work problem",
    "Show the team week and Main vs showcase/devfest-demo",
    "End with Gemini reading or updating Seeder through MCP",
  ),
  para(
    txt("Reference: "),
    txt("the DevFest KL 2026 Project Showcase post", link("https://www.instagram.com/p/DcYz83NgeiL/")),
    txt(" and the rehearsed shot list."),
  ),
  heading(3, txt("Recording status")),
  table(
    ["Segment", "Status", "Owner"],
    ["Problem + board", "Ready", "Maya"],
    ["Branches + Git", "In progress", "Arjun"],
    ["Gemini MCP + close", "Queued", "Tomas"],
  ),
);

type TaskOpts = {
  id: string; project: string; code: number; title: string;
  status: string; priority: string; assignee: unknown; cat?: string;
  phase?: string; due?: number | null; desc?: string | null;
  created?: number; updated?: number; sort?: number; branch?: string;
};
// Per-project board columns. The showcase gets an extra "In Review" column to
// show custom statuses; the client project uses the default three. Mirrors how the 0034
// migration seeds Todo/Doing/Done for real projects.
type StatusCol = {
  key: string;
  name: string;
  color: string;
  initial?: boolean;
  terminal?: boolean;
};
const DEFAULT_COLS: StatusCol[] = [
  { key: "todo", name: "Todo", color: "#8a8f98", initial: true },
  { key: "doing", name: "Doing", color: "#5e6ad2" },
  { key: "done", name: "Done", color: "#27a644", terminal: true },
];
const STATUS_COLS: Record<string, StatusCol[]> = {
  [AURORA]: [
    { key: "todo", name: "Todo", color: "#8a8f98", initial: true },
    { key: "doing", name: "Doing", color: "#5e6ad2" },
    { key: "review", name: "In Review", color: "#d99e25" },
    { key: "done", name: "Done", color: "#27a644", terminal: true },
  ],
  [ATLAS]: DEFAULT_COLS,
};
const STATUS_ID: Record<string, Record<string, string>> = {};
const STATUS_META: Record<string, StatusCol> = {};
const statusRows = Object.entries(STATUS_COLS).flatMap(([proj, cols]) => {
  STATUS_ID[proj] = {};
  return cols.map((c, i) => {
    const id = `st-${proj}-${c.key}`;
    STATUS_ID[proj][c.key] = id;
    STATUS_META[id] = c;
    return {
      id,
      project_id: proj,
      name: c.name,
      color: c.color,
      sort_order: i,
      is_terminal: c.terminal ? 1 : 0,
      is_initial: c.initial ? 1 : 0,
      created_at: ms(-110),
      updated_at: ms(-110),
    };
  });
});
insert(
  "task_statuses",
  ["id", "project_id", "name", "color", "sort_order", "is_terminal", "is_initial", "created_at", "updated_at"],
  statusRows,
);

function task(o: TaskOpts) {
  const c = o.cat ? CAT[o.cat] : undefined;
  const statusId = STATUS_ID[o.project]?.[o.status] ?? STATUS_ID[o.project]?.todo;
  const meta = statusId ? STATUS_META[statusId] : undefined;
  return {
    id: o.id, owner_id: OWNER, project_id: o.project,
    branch_id: o.branch ?? MAIN[o.project] ?? null, request_id: null,
    assignee_id: o.assignee, title: o.title, description: o.desc ?? null,
    code_number: o.code, category_id: o.cat ?? null,
    category_name: c?.name ?? null, category_color: c?.color ?? null,
    phase: o.phase ?? null,
    status_id: statusId, status_name: meta?.name ?? "Todo",
    status_color: meta?.color ?? "#8a8f98", is_terminal: meta?.terminal ? 1 : 0,
    priority: o.priority,
    due_date: o.due ?? null, sort_order: o.sort ?? 0,
    created_at: o.created ?? ms(-40), updated_at: o.updated ?? ms(-3),
  };
}
const M = "demo-user-maya", A = "demo-user-arjun", L = "demo-user-lena", T = "demo-user-tomas";
const tasks = [
  task({ id: HERO, project: AURORA, code: 1, title: "Record the 90-second showcase demo", status: "doing", priority: "high", assignee: T, cat: "cat-a-front", phase: "Showcase", due: day(3), desc: heroDesc, created: ms(-8), updated: ms(-1), sort: 0 }),
  task({ id: "demo-task-a2", project: AURORA, code: 2, title: "Finalize the submission story", status: "doing", priority: "high", assignee: M, cat: "cat-a-design", phase: "Showcase", due: day(0), created: ms(-7), updated: ms(-1), sort: 1 }),
  task({ id: "demo-task-a3", project: AURORA, code: 3, title: "Connect Gemini CLI through Seeder MCP", status: "doing", priority: "high", assignee: OWNER, cat: "cat-a-back", phase: "Integration", due: day(1), created: ms(-7), updated: ms(-1), sort: 2, desc: simple("Connect Gemini CLI to Seeder's authenticated Streamable HTTP MCP endpoint.\nRehearse one read and one write action against demo-only data.") }),
  task({ id: "demo-task-a4", project: AURORA, code: 4, title: "Verify the Google sign-in flow", status: "review", priority: "medium", assignee: A, cat: "cat-a-back", phase: "Integration", due: day(1), created: ms(-6), updated: ms(-1), sort: 0 }),
  task({ id: "demo-task-a5", project: AURORA, code: 5, title: "Run accessibility and mobile layout pass", status: "todo", priority: "medium", assignee: L, cat: "cat-a-front", phase: "QA", due: day(2), created: ms(-5), updated: ms(-2), sort: 0 }),
  task({ id: "demo-task-a6", project: AURORA, code: 6, title: "Prepare focused two-project demo workspace", status: "done", priority: "high", assignee: OWNER, cat: "cat-a-front", phase: "Showcase", created: ms(-10), updated: ms(-1), sort: 0 }),
  task({ id: "demo-task-a7", project: AURORA, code: 7, title: "Create booth walkthrough talking points", status: "todo", priority: "medium", assignee: M, cat: "cat-a-design", phase: "Showcase", due: day(4), created: ms(-4), updated: ms(-2), sort: 1 }),
  task({ id: "demo-task-a8", project: AURORA, code: 8, title: "Submit the DevFest showcase application", status: "todo", priority: "high", assignee: OWNER, cat: "cat-a-design", phase: "Showcase", due: day(5), created: ms(-4), updated: ms(-1), sort: 2 }),

  task({ id: "demo-task-b1", project: ATLAS, code: 1, title: "Run client dashboard regression QA", status: "doing", priority: "high", assignee: L, cat: "cat-b-data", phase: "Delivery", due: day(1), created: ms(-12), updated: ms(-1), sort: 0 }),
  task({ id: "demo-task-b2", project: ATLAS, code: 2, title: "Reduce API latency on the activity feed", status: "doing", priority: "high", assignee: A, cat: "cat-b-infra", phase: "Build", due: day(2), created: ms(-11), updated: ms(-1), sort: 1 }),
  task({ id: "demo-task-b3", project: ATLAS, code: 3, title: "Send the weekly stakeholder update", status: "todo", priority: "medium", assignee: M, cat: "cat-b-data", phase: "Delivery", due: day(3), created: ms(-8), updated: ms(-2), sort: 0 }),
  task({ id: "demo-task-b4", project: ATLAS, code: 4, title: "Review production health and backups", status: "todo", priority: "high", assignee: OWNER, cat: "cat-b-infra", phase: "Operations", due: day(4), created: ms(-7), updated: ms(-2), sort: 1 }),
  task({ id: "demo-task-b5", project: ATLAS, code: 5, title: "Refresh the support handoff guide", status: "todo", priority: "medium", assignee: T, cat: "cat-b-data", phase: "Delivery", due: day(5), created: ms(-6), updated: ms(-2), sort: 2 }),
  task({ id: "demo-task-b6", project: ATLAS, code: 6, title: "Resolve member permission regression", status: "done", priority: "high", assignee: A, cat: "cat-b-infra", phase: "Build", created: ms(-24), updated: ms(-5), sort: 0 }),
  task({ id: "demo-task-b7", project: ATLAS, code: 7, title: "Publish the previous release notes", status: "done", priority: "low", assignee: M, cat: "cat-b-data", phase: "Delivery", created: ms(-20), updated: ms(-8), sort: 1 }),
  task({ id: "demo-task-b8", project: ATLAS, code: 8, title: "Triage new client feedback", status: "todo", priority: "medium", assignee: L, cat: "cat-b-data", phase: "Discovery", due: day(6), created: ms(-3), updated: ms(-1), sort: 3 }),

  // These cards only appear on showcase/devfest-demo, proving work isolation.
  task({ id: "demo-task-feat-1", project: AURORA, branch: AURORA_FEATURE, code: 9, title: "Build the branch-specific workstream demo", status: "doing", priority: "high", assignee: A, cat: "cat-a-front", phase: "Showcase", due: day(2), created: ms(-6), updated: ms(-1), sort: 0, desc: simple("Prepare branch-only tasks and requirements so switching from Main visibly changes the project scope.") }),
  task({ id: "demo-task-feat-2", project: AURORA, branch: AURORA_FEATURE, code: 10, title: "Verify Main vs branch request isolation", status: "todo", priority: "high", assignee: L, cat: "cat-a-front", phase: "QA", due: day(3), created: ms(-5), updated: ms(-2), sort: 0 }),
  task({ id: "demo-task-feat-3", project: AURORA, branch: AURORA_FEATURE, code: 11, title: "Capture backup demo footage", status: "todo", priority: "medium", assignee: T, cat: "cat-a-design", phase: "Showcase", due: day(4), created: ms(-4), updated: ms(-2), sort: 1 }),
];
insert(
  "tasks",
  ["id", "owner_id", "project_id", "branch_id", "request_id", "assignee_id", "title", "description", "code_number", "category_id", "category_name", "category_color", "phase", "status_id", "status_name", "status_color", "is_terminal", "priority", "due_date", "sort_order", "created_at", "updated_at"],
  tasks,
);

// ===================== CHECKLIST (hero task) =====================
const checklist = [
  { id: "ck-1", content: "Lock the 90-second shot list", done: 1, sort: 0, created: ms(-6) },
  { id: "ck-2", content: "Seed privacy-safe team data", done: 1, sort: 1, created: ms(-5) },
  { id: "ck-3", content: "Record the primary take", done: 0, sort: 2, created: ms(-2) },
  { id: "ck-4", content: "Capture a backup take with captions", done: 0, sort: 3, created: ms(-1) },
];
insert(
  "task_checklist_items",
  ["id", "owner_id", "project_id", "task_id", "content", "is_completed", "completed_at", "sort_order", "created_at", "updated_at"],
  checklist.map((c) => ({
    id: c.id, owner_id: OWNER, project_id: AURORA, task_id: HERO, content: c.content,
    is_completed: c.done, completed_at: c.done ? ms(-12) : null,
    sort_order: c.sort, created_at: c.created, updated_at: c.created,
  })),
);

// ===================== TASK COMMENTS (hero task) =====================
const comments = [
  { id: "tc-1", author: M, text: "The story is strongest when we open with the disconnected-work problem.", at: ms(-3) },
  { id: "tc-2", author: A, text: "The branch switch is ready for rehearsal; Main and the demo branch now show different work.", at: ms(-2) },
  { id: "tc-3", author: OWNER, text: "Great. Keep real client data out of the recording and finish with the Gemini MCP action.", at: ms(-1) },
];
insert(
  "task_comments",
  ["id", "project_id", "task_id", "author_id", "content", "created_at", "updated_at"],
  comments.map((c) => ({
    id: c.id, project_id: AURORA, task_id: HERO, author_id: c.author,
    content: simple(c.text), created_at: c.at, updated_at: c.at,
  })),
);

// ===================== CLIENT REQUESTS =====================
const reqDesc: Record<string, string> = {
  "demo-req-1": "Presenters need compact speaker notes beside the rehearsed demo sequence.",
  "demo-req-2": "Reviewers should be able to open a read-only project board without joining the workspace.",
  "demo-req-3": "The team wants a CSV copy of the weekly plan for offline review.",
  "demo-req-4": "Keyboard-first navigation makes the live booth demo faster and more accessible.",
  "demo-req-5": "Task cards should make the current internal workstream obvious at a glance.",
  "demo-req-6": "Rehearsal-only requests must remain outside Main until the showcase flow is approved.",
};
const requests = [
  { id: "demo-req-1", code: 1, title: "Add a presenter notes view", status: "new", priority: "medium", at: ms(-1), branch: AURORA_MAIN },
  { id: "demo-req-2", code: 2, title: "Share a read-only showcase board", status: "reviewed", priority: "high", at: ms(-2), branch: AURORA_MAIN },
  { id: "demo-req-3", code: 3, title: "Export the weekly plan as CSV", status: "converted", priority: "medium", at: ms(-4), branch: AURORA_MAIN },
  { id: "demo-req-4", code: 4, title: "Add keyboard-first task navigation", status: "closed", priority: "medium", at: ms(-8), branch: AURORA_MAIN },
  { id: "demo-req-5", code: 5, title: "Show branch badges on task cards", status: "new", priority: "high", at: ms(-1), branch: AURORA_FEATURE },
  { id: "demo-req-6", code: 6, title: "Keep rehearsal work outside Main", status: "new", priority: "high", at: ms(-1), branch: AURORA_FEATURE },
];
insert(
  "client_requests",
  ["id", "owner_id", "project_id", "branch_id", "title", "description", "code_number", "status", "priority", "created_at", "updated_at"],
  requests.map((r) => ({
    id: r.id, owner_id: OWNER, project_id: AURORA, branch_id: r.branch,
    title: r.title,
    description: reqDesc[r.id], code_number: r.code, status: r.status,
    priority: r.priority, created_at: ms(-18), updated_at: r.at,
  })),
);
insert(
  "request_comments",
  ["id", "project_id", "request_id", "author_id", "content", "created_at", "updated_at"],
  [
    { id: "rc-1", project_id: AURORA, request_id: "demo-req-1", author_id: M, content: simple("Useful for the booth, but keep it out of the recorded browser crop."), created_at: ms(-1), updated_at: ms(-1) },
    { id: "rc-2", project_id: AURORA, request_id: "demo-req-2", author_id: OWNER, content: simple("Reviewed. The public client board already covers the core read-only story."), created_at: ms(-2), updated_at: ms(-2) },
  ],
);

// ===================== DAILY TASKS (this week) =====================
type DailySeed = {
  id: string; owner: unknown; createdBy?: unknown; title: string;
  status: string; priority: string; kind: string;
  project: string | null; linked: string | null;
  off: number; sort: number;
};
const daily: DailySeed[] = [
  // Today: everyone starts with visible progress plus one operational item.
  { id: "showcase-dt-dan-0a", owner: OWNER, title: "Review the seeded demo workspace", status: "done", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a6", off: 0, sort: 0 },
  { id: "showcase-dt-dan-0b", owner: OWNER, createdBy: M, title: "Block the recording slot on the calendar", status: "todo", priority: "medium", kind: "adhoc", project: null, linked: null, off: 0, sort: 1 },
  { id: "showcase-dt-maya-0a", owner: M, title: "Finalize the submission story", status: "doing", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a2", off: 0, sort: 0 },
  { id: "showcase-dt-maya-0b", owner: M, title: "Team stand-up and weekly priorities", status: "done", priority: "medium", kind: "adhoc", project: null, linked: null, off: 0, sort: 1 },
  { id: "showcase-dt-arjun-0a", owner: A, title: "Rehearse the branch switch workflow", status: "doing", priority: "high", kind: "project", project: AURORA, linked: "demo-task-feat-1", off: 0, sort: 0 },
  { id: "showcase-dt-arjun-0b", owner: A, title: "Check the Google sign-in callback", status: "doing", priority: "medium", kind: "project", project: AURORA, linked: "demo-task-a4", off: 0, sort: 1 },
  { id: "showcase-dt-lena-0a", owner: L, title: "Start the showcase regression pass", status: "doing", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a5", off: 0, sort: 0 },
  { id: "showcase-dt-lena-0b", owner: L, title: "Triage the support inbox", status: "todo", priority: "medium", kind: "adhoc", project: null, linked: null, off: 0, sort: 1 },
  { id: "showcase-dt-tomas-0a", owner: T, title: "Draft the 90-second shot list", status: "doing", priority: "high", kind: "project", project: AURORA, linked: HERO, off: 0, sort: 0 },
  { id: "showcase-dt-tomas-0b", owner: T, title: "Collect logo and screenshot assets", status: "todo", priority: "medium", kind: "adhoc", project: null, linked: null, off: 0, sort: 1 },

  // Day 1.
  { id: "showcase-dt-dan-1", owner: OWNER, title: "Connect Gemini CLI through Seeder MCP", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a3", off: 1, sort: 0 },
  { id: "showcase-dt-maya-1", owner: M, title: "Review the dashboard demo copy", status: "todo", priority: "medium", kind: "project", project: AURORA, linked: "demo-task-a7", off: 1, sort: 0 },
  { id: "showcase-dt-arjun-1", owner: A, title: "Finish Google sign-in verification", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a4", off: 1, sort: 0 },
  { id: "showcase-dt-lena-1", owner: L, title: "Run client dashboard regression QA", status: "todo", priority: "high", kind: "project", project: ATLAS, linked: "demo-task-b1", off: 1, sort: 0 },
  { id: "showcase-dt-tomas-1", owner: T, title: "Outline the support handoff guide", status: "todo", priority: "medium", kind: "project", project: ATLAS, linked: "demo-task-b5", off: 1, sort: 0 },

  // Day 2.
  { id: "showcase-dt-dan-2", owner: OWNER, title: "Rehearse Gemini read and write prompts", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a3", off: 2, sort: 0 },
  { id: "showcase-dt-maya-2", owner: M, title: "Draft the booth value proposition", status: "todo", priority: "medium", kind: "project", project: AURORA, linked: "demo-task-a7", off: 2, sort: 0 },
  { id: "showcase-dt-arjun-2", owner: A, title: "Reduce activity-feed API latency", status: "todo", priority: "high", kind: "project", project: ATLAS, linked: "demo-task-b2", off: 2, sort: 0 },
  { id: "showcase-dt-lena-2", owner: L, title: "Verify Main vs branch request isolation", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-feat-2", off: 2, sort: 0 },
  { id: "showcase-dt-tomas-2", owner: T, title: "Run a timed voiceover rehearsal", status: "todo", priority: "medium", kind: "adhoc", project: null, linked: null, off: 2, sort: 0 },

  // Day 3.
  { id: "showcase-dt-dan-3", owner: OWNER, title: "Review the first demo cut", status: "todo", priority: "high", kind: "adhoc", project: null, linked: null, off: 3, sort: 0 },
  { id: "showcase-dt-maya-3", owner: M, title: "Send the weekly stakeholder update", status: "todo", priority: "medium", kind: "project", project: ATLAS, linked: "demo-task-b3", off: 3, sort: 0 },
  { id: "showcase-dt-arjun-3", owner: A, title: "Pair on the branch and Git demo setup", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-feat-1", off: 3, sort: 0 },
  { id: "showcase-dt-lena-3", owner: L, title: "Run the full demo rehearsal QA", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a5", off: 3, sort: 0 },
  { id: "showcase-dt-tomas-3", owner: T, title: "Record the primary 90-second demo", status: "todo", priority: "high", kind: "project", project: AURORA, linked: HERO, off: 3, sort: 0 },

  // Day 4.
  { id: "showcase-dt-dan-4", owner: OWNER, title: "Review production health and backups", status: "todo", priority: "high", kind: "project", project: ATLAS, linked: "demo-task-b4", off: 4, sort: 0 },
  { id: "showcase-dt-maya-4", owner: M, title: "Finalize booth walkthrough talking points", status: "todo", priority: "medium", kind: "project", project: AURORA, linked: "demo-task-a7", off: 4, sort: 0 },
  { id: "showcase-dt-arjun-4", owner: A, title: "Prepare branch and Git talking points", status: "todo", priority: "medium", kind: "project", project: AURORA, linked: "demo-task-feat-1", off: 4, sort: 0 },
  { id: "showcase-dt-lena-4", owner: L, title: "Review accessibility and captions", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a5", off: 4, sort: 0 },
  { id: "showcase-dt-tomas-4", owner: T, title: "Capture backup demo footage", status: "todo", priority: "medium", kind: "project", project: AURORA, linked: "demo-task-feat-3", off: 4, sort: 0 },

  // Day 5.
  { id: "showcase-dt-dan-5", owner: OWNER, title: "Submit the DevFest showcase application", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a8", off: 5, sort: 0 },
  { id: "showcase-dt-maya-5", owner: M, title: "Complete the final application copy review", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a8", off: 5, sort: 0 },
  { id: "showcase-dt-arjun-5", owner: A, title: "Follow up on client performance fixes", status: "todo", priority: "medium", kind: "project", project: ATLAS, linked: "demo-task-b2", off: 5, sort: 0 },
  { id: "showcase-dt-lena-5", owner: L, title: "Retest the client dashboard fixes", status: "todo", priority: "high", kind: "project", project: ATLAS, linked: "demo-task-b1", off: 5, sort: 0 },
  { id: "showcase-dt-tomas-5", owner: T, title: "Refresh the support handoff guide", status: "todo", priority: "medium", kind: "project", project: ATLAS, linked: "demo-task-b5", off: 5, sort: 0 },

  // Day 6: lighter close-out and planning work.
  { id: "showcase-dt-dan-6", owner: OWNER, title: "Weekly review and next-week plan", status: "todo", priority: "medium", kind: "adhoc", project: null, linked: null, off: 6, sort: 0 },
  { id: "showcase-dt-maya-6", owner: M, title: "Review client feedback and roadmap", status: "todo", priority: "medium", kind: "project", project: ATLAS, linked: "demo-task-b3", off: 6, sort: 0 },
  { id: "showcase-dt-arjun-6", owner: A, title: "Plan next week's technical debt work", status: "todo", priority: "low", kind: "adhoc", project: null, linked: null, off: 6, sort: 0 },
  { id: "showcase-dt-lena-6", owner: L, title: "Triage new client feedback", status: "todo", priority: "medium", kind: "project", project: ATLAS, linked: "demo-task-b8", off: 6, sort: 0 },
  { id: "showcase-dt-tomas-6", owner: T, title: "Archive raw clips and publish team notes", status: "todo", priority: "low", kind: "adhoc", project: null, linked: null, off: 6, sort: 0 },
];
insert(
  "daily_tasks",
  ["id", "owner_id", "created_by_id", "planned_date", "title", "description", "status", "priority", "kind", "project_id", "linked_task_id", "sort_order", "batch_id", "created_at", "updated_at"],
  daily.map((d) => ({
    id: d.id, owner_id: d.owner, created_by_id: d.createdBy ?? OWNER, planned_date: day(d.off),
    title: d.title, description: null, status: d.status, priority: d.priority,
    kind: d.kind, project_id: d.project, linked_task_id: d.linked,
    sort_order: d.sort, batch_id: null, created_at: ms(-2), updated_at: ms(-1),
  })),
  // Refresh on every reseed so the plan always lands on the current week.
  "replace",
);

// ===================== STATUS UPDATES (client board log + shipped feed) =====================
const statusUpdates = [
  { id: "su-a6", project: AURORA, task: "demo-task-a6", summary: "Prepared a focused, privacy-safe two-project workspace for the DevFest recording.", at: ms(-1) },
  { id: "su-b6", project: ATLAS, task: "demo-task-b6", summary: "Fixed the member-permission regression and verified project access boundaries.", at: ms(-5) },
  { id: "su-b7", project: ATLAS, task: "demo-task-b7", summary: "Published the previous client release notes and support handoff summary.", at: ms(-8) },
];
insert(
  "project_status_updates",
  ["id", "owner_id", "project_id", "task_id", "summary", "created_at", "updated_at"],
  statusUpdates.map((s) => ({ id: s.id, owner_id: OWNER, project_id: s.project, task_id: s.task, summary: s.summary, created_at: s.at, updated_at: s.at })),
);

// ===================== PROJECT ACTIVITY (history + diff modal) =====================
const change = (field: string, label: string, from: string | null, to: string | null, kind = "text") =>
  ({ field, label, from, to, kind });
const activity = [
  { id: "ac-1", actor: T, entity: "task", eid: HERO, action: "moved", label: "Moved task to Doing", detail: "Record the 90-second showcase demo", changes: [change("status", "Status", "Todo", "Doing")], at: ms(-1) },
  { id: "ac-2", actor: OWNER, entity: "task", eid: "demo-task-a3", action: "updated", label: "Updated task", detail: "Connect Gemini CLI through Seeder MCP", changes: [change("priority", "Priority", "Medium", "High"), change("dueDate", "Due date", "Aug 28", "Aug 25")], at: ms(-2) },
  { id: "ac-3", actor: M, entity: "task", eid: HERO, action: "updated", label: "Updated task", detail: "Record the 90-second showcase demo", changes: [change("assignee", "Assignee", "Unassigned", "Tomas Rivera")], at: ms(-3) },
  { id: "ac-4", actor: OWNER, entity: "request", eid: "demo-req-3", action: "converted", label: "Converted request to task", detail: "Export the weekly plan as CSV", changes: null, at: ms(-4) },
  { id: "ac-5", actor: M, entity: "task", eid: "demo-task-a2", action: "created", label: "Created task", detail: "Finalize the submission story", changes: null, at: ms(-7) },
  { id: "ac-6", actor: OWNER, entity: "project", eid: AURORA, action: "updated", label: "Updated project", detail: "Seeder DevFest Showcase", changes: [change("status", "Status", "POC", "Development"), change("summary", "Summary", "DevFest submission", "Showcase Seeder's team planning, branches, Git workflow, and Gemini MCP integration.")], at: ms(-10) },
];
insert(
  "project_activity",
  ["id", "owner_id", "project_id", "entity_type", "entity_id", "action", "label", "detail", "changes", "created_at"],
  activity.map((a) => ({
    id: a.id, owner_id: a.actor, project_id: AURORA, entity_type: a.entity,
    entity_id: a.eid, action: a.action, label: a.label, detail: a.detail,
    changes: a.changes ? JSON.stringify(a.changes) : null, created_at: a.at,
  })),
);

// ===================== INVITATIONS =====================
const invites = [
  { id: "inv-1", email: "newhire@alphv.example", role: "member", token: "invtok_pending_6d_aZ19", expires: ms(6), accepted: null, created: ms(-1) },
  { id: "inv-2", email: "contractor@client.example", role: "member", token: "invtok_pending_2d_bQ72", expires: ms(2), accepted: null, created: ms(-3) },
  { id: "inv-3", email: "kai@seeder.dev", role: "admin", token: "invtok_accepted_kX55", expires: ms(-2), accepted: ms(-5), created: ms(-12) },
  { id: "inv-4", email: "olddesigner@seeder.dev", role: "member", token: "invtok_expired_zP08", expires: ms(-4), accepted: null, created: ms(-20) },
];
insert(
  "invitations",
  ["id", "email", "role", "invited_by_id", "token", "expires_at", "accepted_at", "created_at"],
  invites.map((i) => ({ id: i.id, email: i.email, role: i.role, invited_by_id: OWNER, token: i.token, expires_at: i.expires, accepted_at: i.accepted, created_at: i.created })),
);

// ===================== PERSONAL ACCESS TOKENS =====================
// Display-only placeholder hashes — these tokens cannot authenticate.
const fakeHash = (seed: string) => createHash("sha256").update(seed).digest("hex");
const pats = [
  { id: "pat-1", name: "Gemini CLI demo", scope: "readwrite", prefix: "seed_pat_kQ9fA2", last: ms(-1), exp: null, rev: null, created: ms(-10) },
  { id: "pat-2", name: "Read-only CI", scope: "read", prefix: "seed_pat_R3dz8M", last: ms(-3), exp: ms(60), rev: null, created: ms(-20) },
  { id: "pat-3", name: "Old laptop", scope: "readwrite", prefix: "seed_pat_zX1bW7", last: ms(-40), exp: ms(-5), rev: null, created: ms(-50) },
];
insert(
  "personal_access_token",
  ["id", "user_id", "name", "token_hash", "token_prefix", "scope", "last_used_at", "expires_at", "revoked_at", "created_at", "updated_at"],
  pats.map((p) => ({ id: p.id, user_id: OWNER, name: p.name, token_hash: fakeHash(p.id), token_prefix: p.prefix, scope: p.scope, last_used_at: p.last, expires_at: p.exp, revoked_at: p.rev, created_at: p.created, updated_at: p.created })),
);

// ===================== STORED NOTIFICATIONS (daily ops) =====================
const notifs = [
  { id: "ntf-1", actor: M, type: "daily_assignment", tone: "warning", title: "Maya planned a task for your day", body: "Block the recording slot on the calendar was added to today.", href: "/daily", etype: "daily_task", eid: "showcase-dt-dan-0b", read: null, at: ms(-0.2) },
  { id: "ntf-2", actor: M, type: "daily_assignment", tone: "default", title: "Maya planned a task for your day", body: "Submit the DevFest showcase application was added to your week.", href: "/daily", etype: "daily_task", eid: "showcase-dt-dan-5", read: ms(-1), at: ms(-4) },
];
insert(
  "notifications",
  ["id", "recipient_id", "actor_id", "type", "tone", "title", "body", "href", "entity_type", "entity_id", "read_at", "created_at"],
  notifs.map((n) => ({ id: n.id, recipient_id: OWNER, actor_id: n.actor, type: n.type, tone: n.tone, title: n.title, body: n.body, href: n.href, entity_type: n.etype, entity_id: n.eid, read_at: n.read, created_at: n.at })),
);
// Mark one computed (request) notification as read so the bell shows a read example.
insert(
  "notification_reads",
  ["id", "user_id", "notification_id", "read_at"],
  [{ id: "nr-1", user_id: OWNER, notification_id: "request-demo-req-2", read_at: ms(-1) }],
);

// ---------- preflight: owner must exist ----------
async function ownerExists(): Promise<boolean> {
  try {
    const rows = await queryRows(
      `SELECT id FROM user WHERE email = '${esc(OWNER_EMAIL)}' LIMIT 1;`,
    );
    return rows.length > 0;
  } catch {
    return true; // if the check is inconclusive, let the insert surface the real error
  }
}

async function run() {
  if (!(await ownerExists())) {
    console.error(
      `No owner account found for ${OWNER_EMAIL}.\n` +
        `Create it first with:  npm run db:seed:local  (or db:seed:node)\n` +
        `(or sign up via the one-time /sign-in bootstrap form), then re-run this.`,
    );
    process.exit(1);
  }

  await execSql(statements.join("\n"));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

console.log(
  `\nSeeded demo workspace for ${OWNER_EMAIL}: ` +
    `${projects.length} projects, ${tasks.length} tasks, ${requests.length} requests, ` +
    `${daily.length} daily items, ${users.length} teammates.\n` +
    `Public client board: /client/${AURORA_TOKEN}`,
);
