// Seed a realistic demo workspace into the database, for development and docs.
//
// Usage:  npm run db:seed:demo:local   (local Miniflare D1)
//         npm run db:seed:demo:node    (node-mode SQLite file at SQLITE_DB_PATH)
//
// Populates a showcase workspace on top of the owner account: 3 demo projects
// with varied statuses, tasks spread across every board column (with priorities,
// assignees, due dates, a rich-text "hero" task, subtasks and comments), client
// requests across the full new→reviewed→converted→closed flow, a week of daily
// plan items, published client status updates, an activity log with before→after
// diffs, pending/accepted/expired invites, and a few personal access tokens.
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
// the teammates a Personal space too, plus a shared Company space (Northwind,
// led by Maya) so grouping + shared access are visible. Aurora lives in the
// company space below, so Maya/Arjun/Lena reach it through space membership.
const NORTHWIND = "demo-space-northwind";
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
    { id: NORTHWIND, kind: "company", name: "Northwind Retail", owner_id: null, lead_id: "demo-user-maya", created_by: OWNER, created_at: ms(-110), updated_at: ms(-2) },
  ],
);
insert(
  "space_members",
  ["id", "space_id", "user_id", "added_by_id", "created_at"],
  [
    { id: "demo-sm-nw-maya", space_id: NORTHWIND, user_id: "demo-user-maya", added_by_id: OWNER, created_at: ms(-110) },
    { id: "demo-sm-nw-arjun", space_id: NORTHWIND, user_id: "demo-user-arjun", added_by_id: "demo-user-maya", created_at: ms(-100) },
    { id: "demo-sm-nw-lena", space_id: NORTHWIND, user_id: "demo-user-lena", added_by_id: "demo-user-maya", created_at: ms(-90) },
  ],
);

// ===================== PROJECTS =====================
const AURORA = "demo-proj-aurora";
const ATLAS = "demo-proj-atlas";
const PULSE = "demo-proj-pulse";
const AURORA_TOKEN = "auroraBoard_3kP9xZ2mQ7wL5vN8rT6yH1";
const projects = [
  { id: AURORA, name: "Aurora Mobile App", slug: "AURORA", client_name: "Northwind Retail", summary: "Cross-platform shopping companion with offline support and push notifications.", status: "production", color: "#6366f1", deadline: ms(30), client_share_enabled: 1, client_share_token: AURORA_TOKEN, created_at: ms(-110) },
  { id: ATLAS, name: "Atlas Analytics", slug: "ATLAS", client_name: "Meridian Health", summary: "Self-serve analytics warehouse and dashboards for clinical operations teams.", status: "development", color: "#0ea5e9", deadline: ms(62), client_share_enabled: 0, client_share_token: null, created_at: ms(-80) },
  { id: PULSE, name: "Pulse Design System", slug: "PULSE", client_name: "Internal", summary: "Shared component library and design tokens powering every Seeder surface.", status: "poc", color: "#f59e0b", deadline: ms(14), client_share_enabled: 0, client_share_token: null, created_at: ms(-45) },
];
insert(
  "projects",
  ["id", "owner_id", "space_id", "name", "slug", "client_name", "summary", "status", "deadline", "color", "archived_at", "client_share_enabled", "client_share_token", "created_at", "updated_at"],
  // Default every project into the owner's Personal space on a fresh insert; the
  // explicit UPDATEs below then place them authoritatively (also fixes an
  // already-seeded DB where INSERT OR IGNORE skips the rows).
  projects.map((p) => ({ ...p, owner_id: OWNER, space_id: ADMIN_PERSONAL, archived_at: null, updated_at: ms(-2) })),
);
// Aurora is shared work → company space; the others stay in the owner's Personal.
statements.push(`UPDATE projects SET space_id = '${NORTHWIND}' WHERE id = '${AURORA}';`);
statements.push(
  `UPDATE projects SET space_id = ${ADMIN_PERSONAL.__raw} WHERE id IN ('${ATLAS}', '${PULSE}');`,
);

// ===================== TASK CATEGORIES =====================
const cats = [
  { id: "cat-a-design", project_id: AURORA, name: "Design", color: "#ec4899" },
  { id: "cat-a-front", project_id: AURORA, name: "Frontend", color: "#6366f1" },
  { id: "cat-a-back", project_id: AURORA, name: "Backend", color: "#10b981" },
  { id: "cat-b-data", project_id: ATLAS, name: "Data", color: "#0ea5e9" },
  { id: "cat-b-infra", project_id: ATLAS, name: "Infra", color: "#64748b" },
  { id: "cat-c-comp", project_id: PULSE, name: "Components", color: "#f59e0b" },
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
const PULSE_MAIN = "demo-branch-pulse-main";
const AURORA_FEATURE = "demo-branch-aurora-checkout";
const MAIN: Record<string, string> = {
  [AURORA]: AURORA_MAIN,
  [ATLAS]: ATLAS_MAIN,
  [PULSE]: PULSE_MAIN,
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
  `DELETE FROM branches WHERE is_default = 1 AND project_id IN ('${AURORA}', '${ATLAS}', '${PULSE}') AND id NOT IN ('${AURORA_MAIN}', '${ATLAS_MAIN}', '${PULSE_MAIN}');`,
);
insert(
  "branches",
  ["id", "project_id", "name", "description", "created_by", "is_default", "created_at", "updated_at"],
  [
    { id: AURORA_MAIN, project_id: AURORA, name: "Main", description: null, created_by: OWNER, is_default: 1, created_at: ms(-110), updated_at: ms(-2) },
    { id: ATLAS_MAIN, project_id: ATLAS, name: "Main", description: null, created_by: OWNER, is_default: 1, created_at: ms(-80), updated_at: ms(-2) },
    { id: PULSE_MAIN, project_id: PULSE, name: "Main", description: null, created_by: OWNER, is_default: 1, created_at: ms(-45), updated_at: ms(-2) },
    { id: AURORA_FEATURE, project_id: AURORA, name: "feature/checkout", description: "Redesigned checkout + payment flow, kept separate from the Main release work.", created_by: "demo-user-arjun", is_default: 0, created_at: ms(-14), updated_at: ms(-1) },
  ],
);

// ===================== PROJECT MEMBERS =====================
// Collaborators on Aurora so the role model is visible: Maya is a Leader (runs
// the project), Arjun is a Member. The Owner is the workspace owner via
// projects.owner_id and is never a member row.
insert(
  "project_members",
  ["id", "project_id", "user_id", "role", "added_by_id", "created_at"],
  [
    { id: "demo-pm-aurora-maya", project_id: AURORA, user_id: "demo-user-maya", role: "leader", added_by_id: OWNER, created_at: ms(-100) },
    { id: "demo-pm-aurora-arjun", project_id: AURORA, user_id: "demo-user-arjun", role: "member", added_by_id: OWNER, created_at: ms(-90) },
  ],
);

// ===================== TASKS =====================
const HERO = "demo-task-a1";
const heroDesc = doc(
  heading(2, txt("Goal")),
  para(
    txt("Rebuild the first-run experience so new users reach their first "),
    txt("aha moment", BOLD),
    txt(" in under "),
    txt("60 seconds", BOLD),
    txt(". Keep it "),
    txt("calm and skippable", ITALIC),
    txt("."),
  ),
  heading(3, txt("Scope")),
  bullet(
    "Three-step progressive walkthrough with a skip affordance",
    "Animated progress indicator (reduced-motion aware)",
    "Contextual empty states on the home screen",
  ),
  para(
    txt("Reference: "),
    txt("the onboarding spec", link("https://www.figma.com/")),
    txt(" and the latest usability notes."),
  ),
  heading(3, txt("Platform status")),
  table(
    ["Platform", "Status", "Owner"],
    ["iOS", "In progress", "Arjun"],
    ["Android", "In progress", "Arjun"],
    ["Web", "Queued", "Lena"],
  ),
);

type TaskOpts = {
  id: string; project: string; code: number; title: string;
  status: string; priority: string; assignee: unknown; cat?: string;
  phase?: string; due?: number | null; desc?: string | null;
  created?: number; updated?: number; sort?: number; branch?: string;
};
// Per-project board columns. Aurora gets an extra "In Review" column to show off
// custom statuses; Atlas and Pulse use the default three. Mirrors how the 0034
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
  [PULSE]: DEFAULT_COLS,
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
  task({ id: HERO, project: AURORA, code: 1, title: "Onboarding flow redesign", status: "doing", priority: "high", assignee: A, cat: "cat-a-design", phase: "Build", due: day(0), desc: heroDesc, created: ms(-25), updated: ms(-1), sort: 0 }),
  task({ id: "demo-task-a3", project: AURORA, code: 3, title: "Offline cache layer", status: "doing", priority: "high", assignee: OWNER, cat: "cat-a-back", phase: "Build", due: day(-2), created: ms(-22), updated: ms(-2), sort: 1, desc: simple("Persist the product catalog and cart so the app is usable on flaky connections.\nUse a write-through cache with background sync.") }),
  task({ id: "demo-task-c2", project: PULSE, code: 2, title: "Theming tokens", status: "doing", priority: "high", assignee: OWNER, cat: "cat-c-comp", phase: "Build", due: day(4), created: ms(-18), updated: ms(-2), sort: 2 }),
  task({ id: "demo-task-b1", project: ATLAS, code: 1, title: "ETL pipeline v2", status: "doing", priority: "high", assignee: OWNER, cat: "cat-b-data", phase: "Build", due: day(3), created: ms(-30), updated: ms(-2), sort: 3 }),
  task({ id: "demo-task-b4", project: ATLAS, code: 4, title: "Query result caching", status: "doing", priority: "low", assignee: A, cat: "cat-b-data", phase: "Build", created: ms(-12), updated: ms(-4), sort: 4 }),
  // todo
  task({ id: "demo-task-a2", project: AURORA, code: 2, title: "Push notification service", status: "todo", priority: "medium", assignee: L, cat: "cat-a-back", phase: "Build", due: day(5), created: ms(-20), updated: ms(-5), sort: 0, desc: simple("Stand up the push service with topic subscriptions and quiet hours.") }),
  task({ id: "demo-task-a6", project: AURORA, code: 6, title: "Crash reporting integration", status: "review", priority: "high", assignee: L, cat: "cat-a-front", phase: "Build", due: day(0), created: ms(-9), updated: ms(-1), sort: 0 }),
  task({ id: "demo-task-b2", project: ATLAS, code: 2, title: "Dashboard widgets", status: "todo", priority: "medium", assignee: L, cat: "cat-b-data", phase: "Design", due: day(8), created: ms(-15), updated: ms(-6), sort: 2 }),
  task({ id: "demo-task-c3", project: PULSE, code: 3, title: "Docs site scaffolding", status: "todo", priority: "low", assignee: T, cat: "cat-c-comp", phase: "Discovery", created: ms(-8), updated: ms(-6), sort: 3 }),
  // done (updated_at spread over weeks for the dashboard charts/heatmap)
  task({ id: "demo-task-a4", project: AURORA, code: 4, title: "Adaptive app icon set", status: "done", priority: "low", assignee: M, cat: "cat-a-design", phase: "Build", created: ms(-50), updated: ms(-26), sort: 0 }),
  task({ id: "demo-task-a5", project: AURORA, code: 5, title: "Login screen polish", status: "done", priority: "medium", assignee: A, cat: "cat-a-front", phase: "Build", created: ms(-44), updated: ms(-12), sort: 1 }),
  task({ id: "demo-task-a7", project: AURORA, code: 7, title: "Splash screen animation", status: "done", priority: "medium", assignee: M, cat: "cat-a-design", phase: "Build", created: ms(-40), updated: ms(-18), sort: 2 }),
  task({ id: "demo-task-a8", project: AURORA, code: 8, title: "Analytics events wiring", status: "done", priority: "high", assignee: OWNER, cat: "cat-a-front", phase: "Build", created: ms(-38), updated: ms(-6), sort: 3 }),
  task({ id: "demo-task-b3", project: ATLAS, code: 3, title: "Provision staging cluster", status: "done", priority: "medium", assignee: M, cat: "cat-b-infra", phase: "Build", created: ms(-55), updated: ms(-33), sort: 4 }),
  task({ id: "demo-task-c1", project: PULSE, code: 1, title: "Button and Input primitives", status: "done", priority: "medium", assignee: M, cat: "cat-c-comp", phase: "Build", created: ms(-40), updated: ms(-20), sort: 5 }),

  // Aurora's feature/checkout branch — these only show on that branch, not Main.
  task({ id: "demo-task-feat-1", project: AURORA, branch: AURORA_FEATURE, code: 9, title: "Checkout cart redesign", status: "doing", priority: "high", assignee: A, cat: "cat-a-front", phase: "Build", due: day(6), created: ms(-12), updated: ms(-1), sort: 0, desc: simple("Rebuild the cart and payment steps for the new checkout flow.") }),
  task({ id: "demo-task-feat-2", project: AURORA, branch: AURORA_FEATURE, code: 10, title: "Apple Pay integration", status: "todo", priority: "medium", assignee: A, cat: "cat-a-back", phase: "Build", due: day(10), created: ms(-10), updated: ms(-2), sort: 0 }),
  task({ id: "demo-task-feat-3", project: AURORA, branch: AURORA_FEATURE, code: 11, title: "Promo code field", status: "todo", priority: "low", assignee: L, cat: "cat-a-front", created: ms(-8), updated: ms(-3), sort: 1 }),
];
insert(
  "tasks",
  ["id", "owner_id", "project_id", "branch_id", "request_id", "assignee_id", "title", "description", "code_number", "category_id", "category_name", "category_color", "phase", "status_id", "status_name", "status_color", "is_terminal", "priority", "due_date", "sort_order", "created_at", "updated_at"],
  tasks,
);

// ===================== CHECKLIST (hero task) =====================
const checklist = [
  { id: "ck-1", content: "Audit current onboarding screens", done: 1, sort: 0, created: ms(-25) },
  { id: "ck-2", content: "Define the new step sequence", done: 1, sort: 1, created: ms(-24) },
  { id: "ck-3", content: "Build the progress indicator", done: 0, sort: 2, created: ms(-10) },
  { id: "ck-4", content: "Usability test with 5 users", done: 0, sort: 3, created: ms(-9) },
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
  { id: "tc-1", author: M, text: "Love the new direction. Can we add a skip option on step two?", at: ms(-8) },
  { id: "tc-2", author: A, text: "Pushed the progress indicator component. Ready for review whenever.", at: ms(-5) },
  { id: "tc-3", author: OWNER, text: "Great work. Lets ship the first cut behind a feature flag.", at: ms(-1) },
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
  "demo-req-1": "Customers in low-light warehouses want a dark theme to reduce glare on the scanner screens.",
  "demo-req-5": "Ops wants to archive a whole quarter of finished projects in one action.",
  "demo-req-2": "Finance needs the weekly summary as CSV for their existing spreadsheets.",
  "demo-req-3": "Enterprise security requires Okta SSO before the wider rollout.",
  "demo-req-4": "Add hover tooltips explaining each KPI on the analytics dashboard.",
  "demo-req-6": "Returning shoppers want their cards saved for one-tap checkout.",
};
const requests = [
  { id: "demo-req-1", code: 1, title: "Add a dark mode toggle", status: "new", priority: "high", at: ms(-1), branch: AURORA_MAIN },
  { id: "demo-req-5", code: 5, title: "Bulk archive completed projects", status: "new", priority: "medium", at: ms(-2), branch: AURORA_MAIN },
  { id: "demo-req-2", code: 2, title: "Export reports to CSV", status: "reviewed", priority: "medium", at: ms(-4), branch: AURORA_MAIN },
  { id: "demo-req-3", code: 3, title: "Single sign-on with Okta", status: "converted", priority: "high", at: ms(-9), branch: AURORA_MAIN },
  { id: "demo-req-4", code: 4, title: "Tooltips on the dashboard", status: "closed", priority: "low", at: ms(-15), branch: AURORA_MAIN },
  // A requirement scoped to the feature/checkout branch.
  { id: "demo-req-6", code: 6, title: "Saved payment methods", status: "new", priority: "high", at: ms(-1), branch: AURORA_FEATURE },
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
    { id: "rc-1", project_id: AURORA, request_id: "demo-req-1", author_id: M, content: simple("Good idea. Lets scope this against the design tokens work."), created_at: ms(-1), updated_at: ms(-1) },
    { id: "rc-2", project_id: AURORA, request_id: "demo-req-2", author_id: OWNER, content: simple("Reviewed. Converting once the reporting service lands."), created_at: ms(-3), updated_at: ms(-3) },
  ],
);

// ===================== DAILY TASKS (this week) =====================
const daily = [
  // Today — a full plate: project work + adhoc, mixed statuses/priorities.
  { id: "dt-1", title: "Review onboarding PR", status: "doing", priority: "high", kind: "project", project: AURORA, linked: HERO, off: 0, sort: 0 },
  { id: "dt-2", title: "Write the release notes", status: "todo", priority: "medium", kind: "adhoc", project: null, linked: null, off: 0, sort: 1 },
  { id: "dt-3", title: "1:1 with Maya", status: "todo", priority: "low", kind: "adhoc", project: null, linked: null, off: 0, sort: 2 },
  { id: "dt-9", title: "Polish onboarding empty states", status: "todo", priority: "medium", kind: "project", project: PULSE, linked: "demo-task-c2", off: 0, sort: 3 },
  { id: "dt-10", title: "Sync with design on the icon set", status: "done", priority: "low", kind: "project", project: AURORA, linked: "demo-task-a4", off: 0, sort: 4 },
  { id: "dt-11", title: "Reply to the Atlas client thread", status: "todo", priority: "high", kind: "adhoc", project: null, linked: null, off: 0, sort: 5 },
  // Tomorrow.
  { id: "dt-4", title: "Triage new requests", status: "doing", priority: "medium", kind: "adhoc", project: null, linked: null, off: 1, sort: 0 },
  { id: "dt-5", title: "ETL pipeline testing", status: "todo", priority: "high", kind: "project", project: ATLAS, linked: "demo-task-b1", off: 1, sort: 1 },
  { id: "dt-12", title: "Pair on the offline cache layer", status: "todo", priority: "high", kind: "project", project: AURORA, linked: "demo-task-a3", off: 1, sort: 2 },
  // Later this week.
  { id: "dt-6", title: "Design review: Pulse", status: "todo", priority: "medium", kind: "project", project: PULSE, linked: null, off: 2, sort: 0 },
  { id: "dt-13", title: "Draft the ETL runbook", status: "todo", priority: "medium", kind: "project", project: ATLAS, linked: "demo-task-b2", off: 2, sort: 1 },
  { id: "dt-8", title: "Sprint planning", status: "todo", priority: "high", kind: "adhoc", project: null, linked: null, off: 3, sort: 0 },
  { id: "dt-16", title: "Roadmap grooming", status: "todo", priority: "medium", kind: "adhoc", project: null, linked: null, off: 4, sort: 0 },
  // Earlier this week (history / completed).
  { id: "dt-7", title: "Inbox zero", status: "done", priority: "low", kind: "adhoc", project: null, linked: null, off: -1, sort: 0 },
  { id: "dt-14", title: "Ship the splash animation", status: "done", priority: "medium", kind: "project", project: AURORA, linked: "demo-task-a7", off: -1, sort: 1 },
  { id: "dt-15", title: "Weekly review & cleanup", status: "done", priority: "low", kind: "adhoc", project: null, linked: null, off: -2, sort: 0 },
];
insert(
  "daily_tasks",
  ["id", "owner_id", "created_by_id", "planned_date", "title", "description", "status", "priority", "kind", "project_id", "linked_task_id", "sort_order", "batch_id", "created_at", "updated_at"],
  daily.map((d) => ({
    id: d.id, owner_id: OWNER, created_by_id: OWNER, planned_date: day(d.off),
    title: d.title, description: null, status: d.status, priority: d.priority,
    kind: d.kind, project_id: d.project, linked_task_id: d.linked,
    sort_order: d.sort, batch_id: null, created_at: ms(-2), updated_at: ms(-1),
  })),
  // Refresh on every reseed so the plan always lands on the current week.
  "replace",
);

// ===================== STATUS UPDATES (client board log + shipped feed) =====================
const statusUpdates = [
  { id: "su-a4", project: AURORA, task: "demo-task-a4", summary: "Shipped the full adaptive app icon set across light and dark themes.", at: ms(-26) },
  { id: "su-a7", project: AURORA, task: "demo-task-a7", summary: "Added a lightweight splash animation with reduced-motion support.", at: ms(-18) },
  { id: "su-a8", project: AURORA, task: "demo-task-a8", summary: "Wired up the core analytics events for activation tracking.", at: ms(-6) },
  { id: "su-b3", project: ATLAS, task: "demo-task-b3", summary: "Staging cluster is live; analytics jobs run nightly.", at: ms(-33) },
  { id: "su-c1", project: PULSE, task: "demo-task-c1", summary: "Core form primitives released in the component library.", at: ms(-20) },
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
  { id: "ac-1", actor: A, entity: "task", eid: HERO, action: "moved", label: "Moved task to Doing", detail: "Onboarding flow redesign", changes: [change("status", "Status", "Todo", "Doing")], at: ms(-1) },
  { id: "ac-2", actor: OWNER, entity: "task", eid: "demo-task-a3", action: "updated", label: "Updated task", detail: "Offline cache layer", changes: [change("priority", "Priority", "Medium", "High"), change("dueDate", "Due date", "Jun 10", "Jun 6")], at: ms(-2) },
  { id: "ac-3", actor: M, entity: "task", eid: HERO, action: "updated", label: "Updated task", detail: "Onboarding flow redesign", changes: [change("assignee", "Assignee", "Unassigned", "Arjun Patel")], at: ms(-3) },
  { id: "ac-4", actor: OWNER, entity: "request", eid: "demo-req-3", action: "converted", label: "Converted request to task", detail: "Single sign-on with Okta", changes: null, at: ms(-9) },
  { id: "ac-5", actor: M, entity: "task", eid: "demo-task-a2", action: "created", label: "Created task", detail: "Push notification service", changes: null, at: ms(-20) },
  { id: "ac-6", actor: OWNER, entity: "project", eid: AURORA, action: "updated", label: "Updated project", detail: "Aurora Mobile App", changes: [change("status", "Status", "Development", "Production"), change("summary", "Summary", "Shopping app", "Cross-platform shopping companion with offline support and push notifications.")], at: ms(-30) },
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
  { id: "inv-1", email: "newhire@northwind.example", role: "member", token: "invtok_pending_6d_aZ19", expires: ms(6), accepted: null, created: ms(-1) },
  { id: "inv-2", email: "contractor@meridian.example", role: "member", token: "invtok_pending_2d_bQ72", expires: ms(2), accepted: null, created: ms(-3) },
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
  { id: "pat-1", name: "Claude Desktop", scope: "readwrite", prefix: "seed_pat_kQ9fA2", last: ms(-1), exp: null, rev: null, created: ms(-10) },
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
  { id: "ntf-1", actor: M, type: "daily_assignment", tone: "warning", title: "Maya planned a task for your day", body: "Review onboarding PR was added to today.", href: "/daily", etype: "daily_task", eid: "dt-1", read: null, at: ms(-0.2) },
  { id: "ntf-2", actor: M, type: "daily_assignment", tone: "default", title: "Maya planned a task for your day", body: "Sprint planning was added to your week.", href: "/daily", etype: "daily_task", eid: "dt-8", read: ms(-1), at: ms(-4) },
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
