import { describe, expect, it } from "vitest";

import { parseTicketRefs } from "@/lib/services/vcs/parse";

describe("parseTicketRefs", () => {
  it("matches a task code mid-sentence", () => {
    expect(parseTicketRefs("See SEEDER-123 for details.", "SEEDER")).toEqual([
      { kind: "task", number: 123 },
    ]);
  });

  it("matches a task code inside a branch-style path, case-insensitively", () => {
    expect(parseTicketRefs("feature/seeder-123-x", "SEEDER")).toEqual([
      { kind: "task", number: 123 },
    ]);
  });

  it("matches a request code (CR-) as kind 'request' and not also as task", () => {
    const refs = parseTicketRefs("Fixes SEEDER-CR-45 per client request.", "SEEDER");
    expect(refs).toEqual([{ kind: "request", number: 45 }]);
    expect(refs.some((r) => r.kind === "task" && r.number === 45)).toBe(false);
  });

  it("rejects a code with the wrong project slug", () => {
    expect(parseTicketRefs("OTHER-9 should not match", "SEEDER")).toEqual([]);
  });

  it("dedupes repeated references to the same code", () => {
    expect(
      parseTicketRefs("SEEDER-123 mentioned twice: SEEDER-123 again", "SEEDER"),
    ).toEqual([{ kind: "task", number: 123 }]);
  });

  it("returns [] for empty text", () => {
    expect(parseTicketRefs("", "SEEDER")).toEqual([]);
  });

  it("returns [] for undefined/null text", () => {
    expect(parseTicketRefs(undefined, "SEEDER")).toEqual([]);
    expect(parseTicketRefs(null, "SEEDER")).toEqual([]);
  });

  it("matches when projectSlug is passed lowercase", () => {
    expect(parseTicketRefs("SEEDER-123", "seeder")).toEqual([{ kind: "task", number: 123 }]);
  });

  it("parses numbers with leading zeros as their numeric value", () => {
    expect(parseTicketRefs("SEEDER-007", "SEEDER")).toEqual([{ kind: "task", number: 7 }]);
  });

  it("matches a code at the very start of the string", () => {
    expect(parseTicketRefs("SEEDER-1 kicks off the release", "SEEDER")).toEqual([
      { kind: "task", number: 1 },
    ]);
  });

  it("matches a code at the very end of the string", () => {
    expect(parseTicketRefs("release notes for SEEDER-1", "SEEDER")).toEqual([
      { kind: "task", number: 1 },
    ]);
  });

  it("distinguishes task and request codes for the same number", () => {
    expect(parseTicketRefs("SEEDER-45 and SEEDER-CR-45", "SEEDER")).toEqual([
      { kind: "task", number: 45 },
      { kind: "request", number: 45 },
    ]);
  });

  it("mixes matching and non-matching slugs in the same text", () => {
    expect(parseTicketRefs("SEEDER-1 relates to OTHER-2 and SEEDER-CR-3", "SEEDER")).toEqual([
      { kind: "task", number: 1 },
      { kind: "request", number: 3 },
    ]);
  });
});
