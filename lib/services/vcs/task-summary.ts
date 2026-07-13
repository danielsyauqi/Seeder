// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import type { VcsRefState } from "@/lib/db/schema";

/**
 * Board-card git summary: the one branch and the latest commit shown on a task
 * card. Kept as a pure reducer (no db) so getProjectWorkspace can group the two
 * project-scoped aggregate queries in memory, and so the pick rules are unit
 * testable — see tests/vcs-task-summary.test.ts.
 */
export type TaskRefRow = {
  taskId: string;
  name: string;
  state: VcsRefState;
  updatedAt: Date | null;
};

export type TaskCommitRow = {
  taskId: string;
  sha: string | null;
  // The ref the latest linked commit was pushed on. This is what makes the card
  // show a branch under 'ticket' link mode, where refs are never linked to a
  // task at all — the commit still remembers where it landed.
  refName: string | null;
  commitCount: number;
  latestCommittedAt: number | null;
};

export type TaskGitSummary = {
  branchName: string | null;
  // Null when the name came from a commit's ref_name rather than a tracked ref,
  // since we then have no open/merged/deleted state to speak for it.
  branchState: VcsRefState | null;
  branchCount: number;
  commitSha: string | null;
  commitCount: number;
};

const time = (value: Date | null) => value?.getTime() ?? 0;

/**
 * A task can carry several refs (a feature branch plus, say, a stale one that
 * was deleted). The card has room for one, so prefer a live branch over a
 * merged/deleted one, then the most recently updated, then the name — the last
 * tie-break only so the pick is stable across page loads rather than dependent
 * on row order.
 */
function isBetterRef(candidate: TaskRefRow, current: TaskRefRow) {
  const candidateOpen = candidate.state === "open";
  const currentOpen = current.state === "open";
  if (candidateOpen !== currentOpen) return candidateOpen;

  const candidateAt = time(candidate.updatedAt);
  const currentAt = time(current.updatedAt);
  if (candidateAt !== currentAt) return candidateAt > currentAt;

  return candidate.name < current.name;
}

export function summarizeTaskGit(
  refRows: TaskRefRow[],
  commitRows: TaskCommitRow[],
): Map<string, TaskGitSummary> {
  const summaries = new Map<string, TaskGitSummary>();

  const blank = (): TaskGitSummary => ({
    branchName: null,
    branchState: null,
    branchCount: 0,
    commitSha: null,
    commitCount: 0,
  });
  const entryFor = (taskId: string) => {
    const existing = summaries.get(taskId);
    if (existing) return existing;
    const created = blank();
    summaries.set(taskId, created);
    return created;
  };

  const bestRefByTask = new Map<string, TaskRefRow>();
  for (const row of refRows) {
    const entry = entryFor(row.taskId);
    entry.branchCount += 1;
    const best = bestRefByTask.get(row.taskId);
    if (!best || isBetterRef(row, best)) {
      bestRefByTask.set(row.taskId, row);
      entry.branchName = row.name;
      entry.branchState = row.state;
    }
  }

  for (const row of commitRows) {
    const entry = entryFor(row.taskId);
    entry.commitCount = row.commitCount;
    entry.commitSha = row.sha;
    // A tracked ref always wins: it's an explicit link with a known state. The
    // commit's ref_name is the fallback that keeps the branch visible for
    // connections in 'ticket' mode, which never link refs to tasks.
    if (!entry.branchName && row.refName) {
      entry.branchName = row.refName;
    }
  }

  return summaries;
}
