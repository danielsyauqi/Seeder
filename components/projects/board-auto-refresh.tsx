"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// How often to check for board changes while the tab is focused. Short enough to
// feel near-live for an MCP/teammate update, long enough to stay cheap (the poll
// is a single-row lookup — see app/api/projects/[projectId]/board-version).
const POLL_INTERVAL_MS = 8000;

async function readBoardVersion(projectId: string): Promise<number | null> {
  try {
    const response = await fetch(
      `/api/projects/${projectId}/board-version?ts=${Date.now()}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === "number" ? data.version : null;
  } catch {
    // Best effort — a failed poll (offline, transient 5xx) just waits for the
    // next tick rather than surfacing an error.
    return null;
  }
}

/**
 * Auto-refreshes the project board when its data changes anywhere — an MCP
 * client posts a task, a teammate edits one, a request is filed. Polls the
 * lightweight board-version endpoint and calls router.refresh() when the version
 * advances; because the (app) layout is force-dynamic, that re-runs the server
 * render against D1 and the board remounts with the new cards. Renders nothing.
 */
export function BoardAutoRefresh({
  projectId,
  initialVersion,
}: {
  projectId: string;
  initialVersion: number;
}) {
  const router = useRouter();
  // The newest version already reflected on screen. Seeded with the version the
  // page was rendered at, so the first poll can already catch a change that
  // landed between server render and mount.
  const seenVersionRef = useRef(initialVersion);

  // A router.refresh() re-renders the page (new initialVersion prop) but does
  // NOT remount this component, so keep the ref in step with the latest rendered
  // version. This also prevents a redundant refresh right after the current
  // user's own mutation already refreshed the tree.
  useEffect(() => {
    if (initialVersion > seenVersionRef.current) {
      seenVersionRef.current = initialVersion;
    }
  }, [initialVersion]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function check() {
      if (cancelled || document.visibilityState !== "visible") return;
      const version = await readBoardVersion(projectId);
      if (cancelled || version === null) return;
      if (version > seenVersionRef.current) {
        seenVersionRef.current = version;
        router.refresh();
      }
    }

    function scheduleNext() {
      timer = setTimeout(() => {
        void check().finally(() => {
          if (!cancelled) scheduleNext();
        });
      }, POLL_INTERVAL_MS);
    }

    // Re-check the moment the tab regains focus, so a background update shows up
    // immediately on return instead of waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    scheduleNext();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, router]);

  return null;
}
