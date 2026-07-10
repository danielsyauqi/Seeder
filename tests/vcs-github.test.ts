// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { giteaAdapter, githubAdapter, verifyHmacSha256 } from "@/lib/services/vcs/github";

const FIXTURES_DIR = path.join(process.cwd(), "tests/fixtures/vcs");

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function headersFor(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "x-github-event": "push",
    "x-github-delivery": "3f1b1e2a-4c5d-4a6b-8c7d-1a2b3c4d5e6f",
    "content-type": "application/json",
    ...overrides,
  });
}

describe("githubAdapter", () => {
  it("exposes the expected header names", () => {
    expect(githubAdapter.sigHeader).toBe("x-hub-signature-256");
    expect(githubAdapter.deliveryHeader).toBe("x-github-delivery");
  });
});

describe("giteaAdapter", () => {
  it("shares GitHub's signature header but has its own delivery header", () => {
    expect(giteaAdapter.sigHeader).toBe("x-hub-signature-256");
    expect(giteaAdapter.deliveryHeader).toBe("x-gitea-delivery");
  });

  it("normalizes push payloads the same way as githubAdapter, tagged with provider 'gitea'", () => {
    const rawBody = loadFixture("github-push.json");
    const envelope = giteaAdapter.parse(
      headersFor({ "x-gitea-delivery": "gitea-delivery-1" }),
      rawBody,
    );
    expect(envelope).not.toBeNull();
    expect(envelope?.provider).toBe("gitea");
    expect(envelope?.event).toBe("push");
    expect(envelope?.deliveryId).toBe("gitea-delivery-1");
  });
});

describe("githubAdapter.parse — push", () => {
  const rawBody = loadFixture("github-push.json");

  it("normalizes the ref, event, headSha and delivery id", () => {
    const envelope = githubAdapter.parse(headersFor(), rawBody);
    expect(envelope).not.toBeNull();
    expect(envelope?.provider).toBe("github");
    expect(envelope?.event).toBe("push");
    expect(envelope?.ref).toBe("feature/seeder-123-login");
    expect(envelope?.headSha).toBe("90e431f81c2b62dec4b6fb036feea00c8b017149");
    expect(envelope?.deliveryId).toBe("3f1b1e2a-4c5d-4a6b-8c7d-1a2b3c4d5e6f");
  });

  it("maps commits to the NormalizedCommit shape", () => {
    const envelope = githubAdapter.parse(headersFor(), rawBody);
    expect(envelope?.commits).toHaveLength(3);
    const first = envelope?.commits[0];
    expect(first).toMatchObject({
      sha: "d5a32f23fe2f3a482ea7386b0b66efca80e9add0",
      message: "SEEDER-123: fix login",
      url: "https://github.com/octo-org/seeder-demo/commit/d5a32f23fe2f3a482ea7386b0b66efca80e9add0",
      authorName: "Priya Natarajan",
      authorEmail: "priya@octo-org.example.com",
      authorUsername: "priyan",
    });
    expect(first?.committedAt).toBe(Date.parse("2026-07-08T09:12:00-07:00"));
  });

  it("includes the request-linking commit (SEEDER-CR-45) and the uncoded commit", () => {
    const envelope = githubAdapter.parse(headersFor(), rawBody);
    expect(envelope?.commits[1]?.message).toBe("SEEDER-CR-45 adjust copy");
    expect(envelope?.commits[2]?.message).toBe("wip");
  });

  it("uses head_commit.timestamp as pushTimestamp", () => {
    const envelope = githubAdapter.parse(headersFor(), rawBody);
    expect(envelope?.pushTimestamp).toBe(Date.parse("2026-07-08T09:31:00-07:00"));
  });

  it("derives refUrl from the repository html_url", () => {
    const envelope = githubAdapter.parse(headersFor(), rawBody);
    expect(envelope?.refUrl).toBe(
      "https://github.com/octo-org/seeder-demo/tree/feature/seeder-123-login",
    );
  });
});

describe("githubAdapter.parse — branch create/delete", () => {
  it("create + ref_type branch → branch_create with no commits", () => {
    const rawBody = loadFixture("github-create-branch.json");
    const envelope = githubAdapter.parse(headersFor({ "x-github-event": "create" }), rawBody);
    expect(envelope).not.toBeNull();
    expect(envelope?.event).toBe("branch_create");
    expect(envelope?.ref).toBe("feature/seeder-210-signup");
    expect(envelope?.commits).toEqual([]);
    expect(envelope?.headSha).toBeUndefined();
  });

  it("delete + ref_type branch → branch_delete with no commits", () => {
    const rawBody = loadFixture("github-delete-branch.json");
    const envelope = githubAdapter.parse(headersFor({ "x-github-event": "delete" }), rawBody);
    expect(envelope).not.toBeNull();
    expect(envelope?.event).toBe("branch_delete");
    expect(envelope?.ref).toBe("feature/seeder-150-old");
    expect(envelope?.commits).toEqual([]);
  });

  it("create + ref_type tag is skipped (returns null)", () => {
    const rawBody = JSON.stringify({ ref: "v1.0.0", ref_type: "tag" });
    const envelope = githubAdapter.parse(headersFor({ "x-github-event": "create" }), rawBody);
    expect(envelope).toBeNull();
  });

  it("delete + ref_type tag is skipped (returns null)", () => {
    const rawBody = JSON.stringify({ ref: "v1.0.0", ref_type: "tag" });
    const envelope = githubAdapter.parse(headersFor({ "x-github-event": "delete" }), rawBody);
    expect(envelope).toBeNull();
  });
});

describe("githubAdapter.parse — unrecognized events", () => {
  it("returns null for an event that isn't push/create/delete", () => {
    const rawBody = JSON.stringify({ zen: "Keep it logically awesome." });
    const envelope = githubAdapter.parse(headersFor({ "x-github-event": "ping" }), rawBody);
    expect(envelope).toBeNull();
  });

  it("returns null when there is no x-github-event header at all", () => {
    const headers = new Headers({ "x-github-delivery": "no-event-header" });
    const envelope = githubAdapter.parse(headers, JSON.stringify({}));
    expect(envelope).toBeNull();
  });
});

describe("verifyHmacSha256", () => {
  const secret = "s3cr3t-webhook-secret";
  const rawBody = loadFixture("github-push.json");

  function hmacHex(body: string): string {
    return createHmac("sha256", secret).update(body, "utf8").digest("hex");
  }

  it("accepts a valid signature with the sha256= prefix", async () => {
    const sig = `sha256=${hmacHex(rawBody)}`;
    await expect(verifyHmacSha256(rawBody, secret, sig)).resolves.toBe(true);
  });

  it("accepts a valid signature without the sha256= prefix", async () => {
    const sig = hmacHex(rawBody);
    await expect(verifyHmacSha256(rawBody, secret, sig)).resolves.toBe(true);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const wrongSig = `sha256=${createHmac("sha256", "not-the-secret").update(rawBody, "utf8").digest("hex")}`;
    await expect(verifyHmacSha256(rawBody, secret, wrongSig)).resolves.toBe(false);
  });

  it("rejects a signature computed over a different body", async () => {
    const sig = `sha256=${hmacHex(rawBody)}`;
    await expect(verifyHmacSha256(rawBody + "\n", secret, sig)).resolves.toBe(false);
  });

  it("rejects malformed hex (odd length)", async () => {
    await expect(verifyHmacSha256(rawBody, secret, "sha256=abc")).resolves.toBe(false);
  });

  it("rejects malformed hex (non-hex characters)", async () => {
    const bogus = `sha256=${"zz".repeat(32)}`;
    await expect(verifyHmacSha256(rawBody, secret, bogus)).resolves.toBe(false);
  });

  it("rejects an empty signature", async () => {
    await expect(verifyHmacSha256(rawBody, secret, "")).resolves.toBe(false);
  });

  it("githubAdapter.verify delegates to verifyHmacSha256", async () => {
    const sig = `sha256=${hmacHex(rawBody)}`;
    await expect(githubAdapter.verify(rawBody, secret, sig)).resolves.toBe(true);
    await expect(githubAdapter.verify(rawBody, "wrong", sig)).resolves.toBe(false);
  });
});
