// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { gitlabAdapter, parse, verify } from "@/lib/services/vcs/gitlab";

const FIXTURES_DIR = path.join(process.cwd(), "tests/fixtures/vcs");

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function headersFor(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "x-gitlab-event": "Push Hook",
    "x-gitlab-event-uuid": "9c6b1e2a-3f4d-4a5b-8c7d-1a2b3c4d5e6f",
    "content-type": "application/json",
    ...overrides,
  });
}

describe("gitlabAdapter", () => {
  it("exposes the expected header names", () => {
    expect(gitlabAdapter.sigHeader).toBe("x-gitlab-token");
    expect(gitlabAdapter.deliveryHeader).toBe("x-gitlab-event-uuid");
  });
});

describe("parse — ordinary push", () => {
  const rawBody = loadFixture("gitlab-push.json");

  it("normalizes ref, event, headSha and delivery id", () => {
    const envelope = parse(headersFor(), rawBody);
    expect(envelope).not.toBeNull();
    expect(envelope?.provider).toBe("gitlab");
    expect(envelope?.event).toBe("push");
    expect(envelope?.ref).toBe("main");
    expect(envelope?.headSha).toBe("da1560886d4f094c3e6c9ef40349f7d38b5d27d7");
    expect(envelope?.deliveryId).toBe("9c6b1e2a-3f4d-4a5b-8c7d-1a2b3c4d5e6f");
  });

  it("maps commits to NormalizedCommit shape without a username field", () => {
    const envelope = parse(headersFor(), rawBody);
    expect(envelope?.commits).toHaveLength(4);
    const first = envelope?.commits[0];
    expect(first).toMatchObject({
      sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      message: "SEEDER-123: fix login\n\nHandles the expired-session redirect loop.",
      url: "https://gitlab.com/acme/seeder-demo/-/commit/1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      authorName: "Priya Natarajan",
      authorEmail: "priya@acme.example.com",
    });
    expect(first?.authorUsername).toBeUndefined();
    expect(typeof first?.committedAt).toBe("number");
  });

  it("uses the latest commit timestamp as pushTimestamp", () => {
    const envelope = parse(headersFor(), rawBody);
    const expected = Date.parse("2026-07-08T10:21:30-07:00");
    expect(envelope?.pushTimestamp).toBe(expected);
  });
});

describe("parse — zero-SHA branch lifecycle detection", () => {
  it("before all-zeros → branch_create, keeps commits", () => {
    const rawBody = loadFixture("gitlab-branch-create.json");
    const envelope = parse(headersFor(), rawBody);
    expect(envelope).not.toBeNull();
    expect(envelope?.event).toBe("branch_create");
    expect(envelope?.ref).toBe("feature/seeder-201-signup");
    expect(envelope?.headSha).toBe("3d1a67376e5be2cc2672748cf5469ee9718b783e");
    expect(envelope?.commits).toHaveLength(1);
  });

  it("after all-zeros → branch_delete, empty commits, no headSha", () => {
    const rawBody = loadFixture("gitlab-branch-delete.json");
    const envelope = parse(headersFor(), rawBody);
    expect(envelope).not.toBeNull();
    expect(envelope?.event).toBe("branch_delete");
    expect(envelope?.ref).toBe("feature/seeder-150-old");
    expect(envelope?.headSha).toBeUndefined();
    expect(envelope?.commits).toEqual([]);
  });
});

describe("parse — non-push object_kind", () => {
  it("returns null (skip) for a non-push event", () => {
    const rawBody = JSON.stringify({ object_kind: "tag_push", ref: "refs/tags/v1.0.0" });
    const envelope = parse(headersFor({ "x-gitlab-event": "Tag Push Hook" }), rawBody);
    expect(envelope).toBeNull();
  });

  it("returns null for a merge request event", () => {
    const rawBody = JSON.stringify({ object_kind: "merge_request" });
    const envelope = parse(headersFor({ "x-gitlab-event": "Merge Request Hook" }), rawBody);
    expect(envelope).toBeNull();
  });
});

describe("verify — constant-time token comparison", () => {
  const secret = "s3cr3t-webhook-token";

  it("accepts the correct secret", async () => {
    await expect(verify("", secret, secret)).resolves.toBe(true);
  });

  it("rejects a wrong token of the same length", async () => {
    const wrongSameLength = "x".repeat(secret.length);
    await expect(verify("", secret, wrongSameLength)).resolves.toBe(false);
  });

  it("rejects an empty token", async () => {
    await expect(verify("", secret, "")).resolves.toBe(false);
  });

  it("rejects a token of a different length", async () => {
    await expect(verify("", secret, secret + "extra")).resolves.toBe(false);
    await expect(verify("", secret, secret.slice(0, -1))).resolves.toBe(false);
  });
});
