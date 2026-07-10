// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Parses a pasted repository link — HTTPS or SSH form, with or without a
// scheme — into { baseUrl, owner, repo } for the connect wizard, so users
// paste one URL instead of filling Base URL / Owner / Repository separately.
// Pure string/URL parsing with zero imports, so both the client wizard (live
// preview) and createVcsConnectionAction (the source of truth) can use the
// same logic. SSRF host validation stays server-side only, in
// lib/services/vcs.ts's `optionalUrl` schema — this file only decides what's
// parseable, never what's safe.

export type ParsedRepositoryUrl = {
  baseUrl: string;
  owner: string;
  repo: string;
};

const SSH_FORM = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/i;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function extractHostAndPath(
  input: string,
): { protocol: string; host: string; path: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const ssh = trimmed.match(SSH_FORM);
  if (ssh) return { protocol: "https:", host: ssh[1], path: ssh[2] };

  const withScheme = SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { protocol: url.protocol, host: url.host, path: url.pathname };
  } catch {
    return null;
  }
}

// Only recognizes the two cloud hosts — self-managed instances (GHE,
// self-hosted GitLab) can't be told apart by host alone, so the caller keeps
// whatever provider is already selected for those.
export function detectProviderFromUrl(input: string): "github" | "gitlab" | null {
  const parsed = extractHostAndPath(input);
  if (!parsed) return null;
  if (parsed.host === "github.com") return "github";
  if (parsed.host === "gitlab.com") return "gitlab";
  return null;
}

export function parseRepositoryUrl(
  input: string,
  provider: "github" | "gitlab" | "gitea",
): ParsedRepositoryUrl | null {
  const parsed = extractHostAndPath(input);
  if (!parsed) return null;

  let segments = parsed.path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length) {
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, "");
  }

  if (provider === "gitlab") {
    // GitLab supports arbitrarily nested subgroups (owner/repo can be many
    // segments deep), but every sub-page URL inserts a literal "-" segment
    // before the resource (.../group/project/-/tree/main), so cut there.
    const dashIndex = segments.indexOf("-");
    if (dashIndex !== -1) segments = segments.slice(0, dashIndex);
  } else {
    // GitHub/Gitea don't nest namespaces — owner/repo is always the first
    // two path segments; anything after (tree/blob/pull/issues/...) is a
    // sub-page of a URL copied straight from the browser, so drop it.
    segments = segments.slice(0, 2);
  }

  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1];
  const owner = segments.slice(0, -1).join("/");
  if (!repo || !owner) return null;

  return { baseUrl: `${parsed.protocol}//${parsed.host}`, owner, repo };
}
