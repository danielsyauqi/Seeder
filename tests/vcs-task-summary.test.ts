// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { describe, expect, it } from "vitest";

import {
  summarizeTaskGit,
  type TaskCommitRow,
  type TaskRefRow,
} from "@/lib/services/vcs/task-summary";

const ref = (over: Partial<TaskRefRow> = {}): TaskRefRow => ({
  taskId: "task-1",
  name: "f/LFMS-56-batch",
  state: "open",
  updatedAt: new Date("2026-07-10T00:00:00Z"),
  ...over,
});

const commit = (over: Partial<TaskCommitRow> = {}): TaskCommitRow => ({
  taskId: "task-1",
  sha: "a7f31d9aa11223344556677889900aabbccddeeff",
  refName: null,
  commitCount: 1,
  latestCommittedAt: Date.parse("2026-07-10T00:00:00Z"),
  ...over,
});

describe("summarizeTaskGit", () => {
  it("returns no entry for a task with no git links", () => {
    expect(summarizeTaskGit([], []).get("task-1")).toBeUndefined();
  });

  it("carries the branch and the latest commit for a linked task", () => {
    const summary = summarizeTaskGit([ref()], [commit({ commitCount: 4 })]).get(
      "task-1",
    );

    expect(summary).toEqual({
      branchName: "f/LFMS-56-batch",
      branchState: "open",
      branchCount: 1,
      commitSha: "a7f31d9aa11223344556677889900aabbccddeeff",
      commitCount: 4,
    });
  });

  it("prefers a live branch over a deleted one, even when the deleted one is newer", () => {
    const summary = summarizeTaskGit(
      [
        ref({
          name: "old/LFMS-56",
          state: "deleted",
          updatedAt: new Date("2026-07-12T00:00:00Z"),
        }),
        ref({
          name: "f/LFMS-56-batch",
          state: "open",
          updatedAt: new Date("2026-07-01T00:00:00Z"),
        }),
      ],
      [],
    ).get("task-1");

    expect(summary?.branchName).toBe("f/LFMS-56-batch");
    expect(summary?.branchState).toBe("open");
    expect(summary?.branchCount).toBe(2);
  });

  it("picks the most recently updated branch among equally live ones", () => {
    const summary = summarizeTaskGit(
      [
        ref({ name: "a-old", updatedAt: new Date("2026-07-01T00:00:00Z") }),
        ref({ name: "z-new", updatedAt: new Date("2026-07-12T00:00:00Z") }),
      ],
      [],
    ).get("task-1");

    expect(summary?.branchName).toBe("z-new");
  });

  it("falls back to the name so the pick is stable when timestamps tie", () => {
    const rows = [
      ref({ name: "b-branch", updatedAt: null }),
      ref({ name: "a-branch", updatedAt: null }),
    ];

    expect(summarizeTaskGit(rows, []).get("task-1")?.branchName).toBe("a-branch");
    expect(summarizeTaskGit([...rows].reverse(), []).get("task-1")?.branchName).toBe(
      "a-branch",
    );
  });

  it("still shows a deleted branch when it is the only one", () => {
    const summary = summarizeTaskGit(
      [ref({ name: "gone/LFMS-56", state: "deleted" })],
      [],
    ).get("task-1");

    expect(summary?.branchName).toBe("gone/LFMS-56");
    expect(summary?.branchState).toBe("deleted");
  });

  it("summarizes a commit-only task with no branch anywhere", () => {
    const summary = summarizeTaskGit([], [commit({ commitCount: 2 })]).get(
      "task-1",
    );

    expect(summary?.branchName).toBeNull();
    expect(summary?.branchCount).toBe(0);
    expect(summary?.commitCount).toBe(2);
  });

  // A connection in 'ticket' link mode never links a ref to a task, so without
  // this fallback the card would show a commit and no branch at all.
  it("falls back to the latest commit's ref_name when no ref is linked", () => {
    const summary = summarizeTaskGit(
      [],
      [commit({ refName: "b/p.32-revamp", commitCount: 26 })],
    ).get("task-1");

    expect(summary?.branchName).toBe("b/p.32-revamp");
    // No tracked ref means no open/merged/deleted state to report.
    expect(summary?.branchState).toBeNull();
    expect(summary?.branchCount).toBe(0);
  });

  it("prefers a linked ref over the commit's ref_name", () => {
    const summary = summarizeTaskGit(
      [ref({ name: "f/LFMS-56-batch" })],
      [commit({ refName: "b/p.32-revamp" })],
    ).get("task-1");

    expect(summary?.branchName).toBe("f/LFMS-56-batch");
    expect(summary?.branchState).toBe("open");
  });

  it("keeps each task's links separate", () => {
    const summaries = summarizeTaskGit(
      [ref({ taskId: "task-1" }), ref({ taskId: "task-2", name: "f/LFMS-71" })],
      [
        commit({ taskId: "task-1", commitCount: 3 }),
        commit({ taskId: "task-2", sha: "0749ac2", commitCount: 1 }),
      ],
    );

    expect(summaries.get("task-1")?.branchName).toBe("f/LFMS-56-batch");
    expect(summaries.get("task-1")?.commitCount).toBe(3);
    expect(summaries.get("task-2")?.branchName).toBe("f/LFMS-71");
    expect(summaries.get("task-2")?.commitSha).toBe("0749ac2");
  });
});
