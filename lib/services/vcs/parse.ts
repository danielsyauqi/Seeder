// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Ticket-code parsing shared by branch names and commit messages. Matches
// task codes (`SLUG-N`, see lib/codes.ts formatTaskCode) and request codes
// (`SLUG-CR-N`, formatRequestCode). Cross-project codes (a different slug)
// are intentionally ignored so a commit message mentioning another team's
// ticket never links into this project.

export type TicketRef = { kind: "task" | "request"; number: number };

const CODE_RE = /\b([A-Z0-9]{2,10})-(CR-)?(\d+)\b/gi;

export function parseTicketRefs(
  text: string | null | undefined,
  projectSlug: string,
): TicketRef[] {
  const slug = projectSlug.toUpperCase();
  const seen = new Set<string>();
  const out: TicketRef[] = [];
  for (const m of (text ?? "").matchAll(CODE_RE)) {
    if (m[1].toUpperCase() !== slug) continue; // never cross-project
    const kind: TicketRef["kind"] = m[2] ? "request" : "task"; // CR- parsed first
    const key = `${kind}:${m[3]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, number: Number(m[3]) });
    }
  }
  return out;
}
