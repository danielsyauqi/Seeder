// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { describe, expect, it } from "vitest";

import { detectProviderFromUrl, parseRepositoryUrl } from "@/lib/services/vcs/repo-url";

describe("parseRepositoryUrl", () => {
  it("parses a plain https GitHub URL", () => {
    expect(parseRepositoryUrl("https://github.com/acme-inc/seeder", "github")).toEqual({
      baseUrl: "https://github.com",
      owner: "acme-inc",
      repo: "seeder",
    });
  });

  it("strips a .git suffix", () => {
    expect(parseRepositoryUrl("https://github.com/acme-inc/seeder.git", "github")).toEqual({
      baseUrl: "https://github.com",
      owner: "acme-inc",
      repo: "seeder",
    });
  });

  it("strips a trailing slash", () => {
    expect(parseRepositoryUrl("https://github.com/acme-inc/seeder/", "github")).toEqual({
      baseUrl: "https://github.com",
      owner: "acme-inc",
      repo: "seeder",
    });
  });

  it("defaults to https when no scheme is given", () => {
    expect(parseRepositoryUrl("github.com/acme-inc/seeder", "github")).toEqual({
      baseUrl: "https://github.com",
      owner: "acme-inc",
      repo: "seeder",
    });
  });

  it("drops GitHub sub-page paths (tree/blob/pull/...)", () => {
    expect(parseRepositoryUrl("https://github.com/acme-inc/seeder/tree/main", "github")).toEqual({
      baseUrl: "https://github.com",
      owner: "acme-inc",
      repo: "seeder",
    });
    expect(
      parseRepositoryUrl("https://github.com/acme-inc/seeder/pull/42", "github"),
    ).toEqual({ baseUrl: "https://github.com", owner: "acme-inc", repo: "seeder" });
  });

  it("parses a self-managed GitHub Enterprise host", () => {
    expect(
      parseRepositoryUrl("https://github.acme.internal/acme-inc/seeder", "github"),
    ).toEqual({ baseUrl: "https://github.acme.internal", owner: "acme-inc", repo: "seeder" });
  });

  it("parses the SSH clone form", () => {
    expect(parseRepositoryUrl("git@github.com:acme-inc/seeder.git", "github")).toEqual({
      baseUrl: "https://github.com",
      owner: "acme-inc",
      repo: "seeder",
    });
  });

  it("parses a single-namespace GitLab URL", () => {
    expect(
      parseRepositoryUrl("https://gitlab.com/alphvtechologies/abraham_lfms", "gitlab"),
    ).toEqual({
      baseUrl: "https://gitlab.com",
      owner: "alphvtechologies",
      repo: "abraham_lfms",
    });
  });

  it("parses a nested GitLab subgroup as part of the owner", () => {
    expect(parseRepositoryUrl("https://gitlab.com/group/subgroup/project", "gitlab")).toEqual({
      baseUrl: "https://gitlab.com",
      owner: "group/subgroup",
      repo: "project",
    });
  });

  it("drops GitLab sub-page paths at the literal '-' segment", () => {
    expect(
      parseRepositoryUrl("https://gitlab.com/group/subgroup/project/-/tree/main", "gitlab"),
    ).toEqual({ baseUrl: "https://gitlab.com", owner: "group/subgroup", repo: "project" });
  });

  it("treats gitea like github (no namespace nesting)", () => {
    expect(
      parseRepositoryUrl("https://git.alphv.com/acme-inc/seeder/issues/3", "gitea"),
    ).toEqual({ baseUrl: "https://git.alphv.com", owner: "acme-inc", repo: "seeder" });
  });

  it.each(["", "   ", "not a url", "https://github.com", "https://github.com/onlyonesegment"])(
    "returns null for unparseable input %j",
    (input) => {
      expect(parseRepositoryUrl(input, "github")).toBeNull();
    },
  );

  it("rejects a non-http(s) scheme", () => {
    expect(parseRepositoryUrl("ftp://github.com/acme-inc/seeder", "github")).toBeNull();
    expect(parseRepositoryUrl("javascript:alert(1)", "github")).toBeNull();
  });
});

describe("detectProviderFromUrl", () => {
  it("recognizes github.com", () => {
    expect(detectProviderFromUrl("https://github.com/acme-inc/seeder")).toBe("github");
  });

  it("recognizes gitlab.com", () => {
    expect(detectProviderFromUrl("https://gitlab.com/acme-inc/seeder")).toBe("gitlab");
  });

  it("returns null for a self-managed host", () => {
    expect(detectProviderFromUrl("https://git.alphv.com/acme-inc/seeder")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(detectProviderFromUrl("not a url")).toBeNull();
  });
});
