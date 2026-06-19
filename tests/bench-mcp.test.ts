// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Token-efficiency benchmark + regression gate for the MCP read layer (M1).
//
// Runs the real read services against a deterministic in-memory DB and compares
// the LEGACY response shape (raw TipTap rich text + verbose rows + activity
// diffs, pretty-printed) against the NEW lean default (plain text, lean
// projection, diffs opt-in, compact JSON). The legacy shape is reproduced via
// the opt-in flags the M1 change added (format:'rich', verbose, includeChanges)
// plus a pretty/compact toggle, so before/after are measured on identical data.
//
// Asserts the new defaults are strictly smaller, so a future change that
// re-bloats a response fails CI. Tokens are a chars/4 proxy (deterministic, no
// network) — good enough for a regression gate; a real token-count run against
// the Anthropic endpoint is a separate, opt-in step for external-facing numbers.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "./helpers/test-db";

const h = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock("@/lib/db", () => ({ getDb: () => h.db }));
// cache() is a request-scoped React API; make it a passthrough under Node.
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return { ...actual, cache: <T>(fn: T) => fn };
});

import type { Viewer } from "@/lib/auth-server";
import { getDb } from "@/lib/db";
import {
  projectActivity,
  projectNotes,
  projects,
  taskChecklistItems,
  tasks,
  taskStatuses,
  user,
  type ActivityChange,
} from "@/lib/db/schema";
import {
  listProjectActivity,
  listProjectNotes,
  listTasks,
  readProject,
  readTask,
} from "@/lib/services/reads";

const PROJECT_ID = "proj-aurora";
const HERO_TASK_ID = "task-01";
const TASK_COUNT = 30;
const BASE = new Date("2026-01-01T00:00:00Z").getTime();

const viewer: Viewer = {
  id: "owner-1",
  email: "owner@example.test",
  name: "Owner",
  role: "member",
  image: null,
};

// A TipTap / ProseMirror doc JSON string whose structural overhead dwarfs the
// text it carries — the bloat the plain-text default removes.
function richDoc(paragraphs: string[]): string {
  const content: unknown[] = paragraphs.map((text) => ({
    type: "paragraph",
    content: [
      { type: "text", text },
      { type: "text", marks: [{ type: "bold" }], text: " — note." },
    ],
  }));
  content.push({
    type: "bulletList",
    content: paragraphs.slice(0, 3).map((text) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    })),
  });
  return JSON.stringify({ type: "doc", content });
}

const HERO_PARAS = [
  "The checkout flow must support saved cards and one-tap re-purchase for returning customers.",
  "Payment provider migration from the legacy gateway has to be feature-flagged and reversible.",
  "Edge cases: partial refunds, currency rounding, and failed-then-retried captures all need tests.",
  "Accessibility: the entire flow must be keyboard navigable and screen-reader labelled.",
  "Performance budget is a 2.5s LCP on a mid-tier device over a 4G connection.",
  "Analytics events fire on add-to-cart, begin-checkout, and purchase with the agreed schema.",
];

let client: { close: () => void };

beforeAll(async () => {
  const made = await createTestDb();
  h.db = made.db;
  client = made.client;
  const db = getDb();

  await db
    .insert(user)
    .values({ id: "owner-1", name: "Owner", email: "owner@example.test" });

  await db.insert(projects).values({
    id: PROJECT_ID,
    ownerId: "owner-1",
    name: "Aurora Checkout Revamp",
    slug: "AURORA",
    clientName: "Northwind Retail",
    summary: "Rebuild the checkout funnel.",
    status: "production",
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
  });

  await db.insert(taskStatuses).values([
    { id: "st-todo", projectId: PROJECT_ID, name: "Todo", color: "#8a8f98", sortOrder: 0, isInitial: true, isTerminal: false },
    { id: "st-doing", projectId: PROJECT_ID, name: "Doing", color: "#5e6ad2", sortOrder: 1, isInitial: false, isTerminal: false },
    { id: "st-done", projectId: PROJECT_ID, name: "Done", color: "#27a644", sortOrder: 2, isInitial: false, isTerminal: true },
  ]);

  const cols = [
    { id: "st-todo", name: "Todo", color: "#8a8f98", terminal: false },
    { id: "st-doing", name: "Doing", color: "#5e6ad2", terminal: false },
    { id: "st-done", name: "Done", color: "#27a644", terminal: true },
  ];
  const taskRows = Array.from({ length: TASK_COUNT }, (_, i) => {
    const n = i + 1;
    const col = cols[i % 3];
    const isHero = n === 1;
    return {
      id: `task-${String(n).padStart(2, "0")}`,
      ownerId: "owner-1",
      projectId: PROJECT_ID,
      title: `Task ${n}: ${HERO_PARAS[i % HERO_PARAS.length].slice(0, 40)}`,
      codeNumber: n,
      statusId: col.id,
      statusName: col.name,
      statusColor: col.color,
      isTerminal: col.terminal,
      priority: (["low", "medium", "high"] as const)[i % 3],
      assigneeId: i % 2 === 0 ? "owner-1" : null,
      dueDate: i % 3 === 0 ? new Date(BASE + n * 86_400_000) : null,
      sortOrder: i,
      description: isHero
        ? richDoc(HERO_PARAS)
        : richDoc([`Short note for task ${n}.`]),
      createdAt: new Date(BASE + n * 1000),
      updatedAt: new Date(BASE + n * 1000),
    };
  });
  await db.insert(tasks).values(taskRows);

  await db.insert(taskChecklistItems).values([
    { id: "ck-1", ownerId: "owner-1", projectId: PROJECT_ID, taskId: HERO_TASK_ID, content: "Wire the saved-cards endpoint", isCompleted: true, sortOrder: 0 },
    { id: "ck-2", ownerId: "owner-1", projectId: PROJECT_ID, taskId: HERO_TASK_ID, content: "Add one-tap re-purchase", isCompleted: false, sortOrder: 1 },
  ]);

  await db.insert(projectNotes).values(
    [1, 2, 3].map((n) => ({
      id: `note-${n}`,
      ownerId: "owner-1",
      projectId: PROJECT_ID,
      content: richDoc(HERO_PARAS.slice(0, 4)),
      createdAt: new Date(BASE + n * 1000),
      updatedAt: new Date(BASE + n * 1000),
    })),
  );

  const activityRows = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    const rich = i % 5 === 0; // 6 of 30 carry a rich before→after diff
    const changes: ActivityChange[] = rich
      ? [
          {
            field: "description",
            label: "Description",
            from: richDoc([`Old description ${n}.`]),
            to: richDoc(HERO_PARAS.slice(0, 2)),
            kind: "rich",
          },
        ]
      : [
          {
            field: "title",
            label: "Title",
            from: `Task ${n} old`,
            to: `Task ${n} new`,
            kind: "text",
          },
        ];
    return {
      id: `act-${String(n).padStart(2, "0")}`,
      ownerId: "owner-1",
      projectId: PROJECT_ID,
      entityType: "task" as const,
      entityId: `task-${String((i % TASK_COUNT) + 1).padStart(2, "0")}`,
      action: "updated" as const,
      label: `Updated task ${n}`,
      detail: null,
      changes,
      createdAt: new Date(BASE + n * 1000),
    };
  });
  await db.insert(projectActivity).values(activityRows);
});

afterAll(() => client.close());

const tok = (s: string) => Math.ceil(s.length / 4);
// Legacy: pretty-printed JSON (the pre-M1 jsonResult). New: compact.
const prettyTok = (d: unknown) => tok(JSON.stringify(d, null, 2));
const compactTok = (d: unknown) => tok(JSON.stringify(d));

describe("MCP token-efficiency benchmark (M1)", () => {
  it("new lean defaults are strictly smaller than the legacy shape", async () => {
    // read-task: legacy = raw TipTap description (format:'rich'); new = plain text.
    const rtBefore = prettyTok(
      await readTask(viewer, { projectId: PROJECT_ID, taskId: HERO_TASK_ID, format: "rich" }),
    );
    const rtAfter = compactTok(
      await readTask(viewer, { projectId: PROJECT_ID, taskId: HERO_TASK_ID }),
    );

    // list-tasks: legacy = verbose rows; new = lean projection.
    const ltBefore = prettyTok(await listTasks(viewer, { projectId: PROJECT_ID, verbose: true }));
    const ltAfter = compactTok(await listTasks(viewer, { projectId: PROJECT_ID }));

    // list-project-activity: legacy = diffs included (rich); new = diffs omitted.
    const laBefore = prettyTok(
      await listProjectActivity(viewer, { projectId: PROJECT_ID, limit: 30, includeChanges: true }),
    );
    const laAfter = compactTok(
      await listProjectActivity(viewer, { projectId: PROJECT_ID, limit: 30 }),
    );

    // read-project-notes: legacy = raw TipTap; new = plain text.
    const pnBefore = prettyTok(
      await listProjectNotes(viewer, { projectId: PROJECT_ID, format: "rich" }),
    );
    const pnAfter = compactTok(await listProjectNotes(viewer, { projectId: PROJECT_ID }));

    // scenario: project review = read-project + notes + activity(30)
    const prBefore =
      prettyTok(await readProject(viewer, { projectId: PROJECT_ID })) + pnBefore + laBefore;
    const prAfter =
      compactTok(await readProject(viewer, { projectId: PROJECT_ID })) + pnAfter + laAfter;

    // scenario: triage round-trip = list-tasks(30) + read-task(hero). Confirms the
    // lean list default doesn't net-increase tokens once the follow-up detail
    // read is counted.
    const trBefore = ltBefore + rtBefore;
    const trAfter = ltAfter + rtAfter;

    const rows: Array<[string, number, number]> = [
      ["read-task (hero rich desc)", rtBefore, rtAfter],
      ["list-tasks (30)", ltBefore, ltAfter],
      ["list-project-activity (30, 6 rich)", laBefore, laAfter],
      ["read-project-notes (3 rich)", pnBefore, pnAfter],
      ["scenario: project-review", prBefore, prAfter],
      ["scenario: triage round-trip", trBefore, trAfter],
    ];

    console.log("\nMCP token-efficiency — legacy vs lean (chars/4 proxy)");
    console.log("-".repeat(66));
    for (const [name, b, a] of rows) {
      const ratio = (b / a).toFixed(2);
      const pct = (((b - a) / b) * 100).toFixed(0);
      console.log(
        `${name.padEnd(38)} ${String(b).padStart(6)} → ${String(a).padStart(6)}  ${ratio}x (-${pct}%)`,
      );
    }
    console.log("-".repeat(66));

    // Regression gate: every response is strictly leaner than the legacy shape.
    for (const [, b, a] of rows) {
      expect(a).toBeLessThan(b);
    }
    // Lock in the headline wins so a regression can't quietly erode them.
    expect(rtBefore / rtAfter).toBeGreaterThanOrEqual(1.5);
    expect(laBefore / laAfter).toBeGreaterThanOrEqual(1.8);
  });
});
