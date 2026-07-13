"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  ChatCircleText,
  Folders,
  Kanban,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";

import type { SearchIndexItem } from "@/lib/data";
import { cn } from "@/lib/utils";

const kindMeta = {
  project: {
    label: "Project",
    icon: Folders,
  },
  request: {
    label: "Request",
    icon: ChatCircleText,
  },
  task: {
    label: "Task",
    icon: Kanban,
  },
} as const;

function matchesQuery(item: SearchIndexItem, queryTokens: string[]) {
  if (!queryTokens.length) {
    return true;
  }

  return queryTokens.every((token) => item.searchText.includes(token));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMatches(text: string, tokens: string[]) {
  if (!tokens.length || !text) return text;

  const pattern = new RegExp(
    `(${tokens.map(escapeRegex).join("|")})`,
    "gi",
  );
  const parts = text.split(pattern);

  return parts.map((part, index) => {
    const isMatch =
      part.length > 0 &&
      tokens.some((token) => part.toLowerCase() === token.toLowerCase());
    if (!isMatch) return part;
    return (
      <mark
        key={index}
        className="rounded-[3px] bg-yellow-300/40 px-0.5 text-inherit"
      >
        {part}
      </mark>
    );
  });
}

export function CommandBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchIndexItem[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const queryTokens = normalizedQuery ? normalizedQuery.split(/\s+/) : [];
  const visibleItems = items
    .filter((item) => matchesQuery(item, queryTokens))
    .slice(0, queryTokens.length ? 12 : 8);

  // Keyboard-driven result list: the highlighted row is what Enter opens, and
  // it resets to the top whenever the result set changes under you.
  const [activeIndex, setActiveIndex] = useState(0);
  const activeKey = visibleItems.map((item) => item.id).join("|");
  const [seenKey, setSeenKey] = useState(activeKey);
  if (seenKey !== activeKey) {
    setSeenKey(activeKey);
    setActiveIndex(0);
  }

  const onGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setIsOpen((current) => !current);
      return;
    }

    if (event.key === "Escape") {
      setIsOpen(false);
    }
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      onGlobalKeyDown(event);
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onGlobalKeyDown]);

  useEffect(() => {
    setIsOpen(false);
    setQuery("");
    setHasLoaded(false);
    setItems([]);
    setLoadError(null);
  }, [pathname]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setLoadError(null);
  }, [isOpen]);

  useEffect(() => {
    // Re-fire only when the modal opens or the cache is invalidated.
    // Including isLoading/loadError in the dep array would cause this effect
    // to re-run on its own setState calls, which triggers cleanup before the
    // fetch resolves — isMounted flips false and the .then/.finally callbacks
    // skip themselves, leaving the UI stuck in the loading state forever.
    if (!isOpen || hasLoaded) {
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setLoadError(null);

    fetch("/api/search-index", {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Search index request failed.");
        }

        const nextItems = (await response.json()) as SearchIndexItem[];

        if (!isMounted) {
          return;
        }

        setItems(nextItems);
        setHasLoaded(true);
      })
      .catch((error: unknown) => {
        if (!isMounted) {
          return;
        }

        // TypeError on fetch usually means a network-level block —
        // ad-blocker / privacy extension / corporate proxy
        if (error instanceof TypeError) {
          setLoadError(
            "Search request was blocked. Disable any ad-blocker or privacy extension for this site, then reopen.",
          );
        } else {
          setLoadError("Search is temporarily unavailable.");
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [hasLoaded, isOpen]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-[13px] font-medium text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
      >
        <span className="inline-flex items-center gap-2">
          <MagnifyingGlass className="size-4" />
          Search
        </span>
        <span className="ui-kbd">
          Ctrl K
        </span>
      </button>

      {isOpen && typeof document !== "undefined"
        ? createPortal(
        <div className="fixed inset-0 z-50 p-4 sm:p-6">
          <button
            type="button"
            aria-label="Close search"
            onClick={() => setIsOpen(false)}
            className="ui-modal-backdrop absolute inset-0 backdrop-blur-xs"
          />

          <div className="relative mx-auto flex min-h-full max-w-3xl items-start justify-center pt-[10dvh]">
            <div className="ui-modal-panel w-full overflow-hidden rounded-md border border-border bg-surface-strong shadow-xl">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <MagnifyingGlass className="size-4 text-muted" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setActiveIndex((current) =>
                        visibleItems.length
                          ? (current + 1) % visibleItems.length
                          : 0,
                      );
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveIndex((current) =>
                        visibleItems.length
                          ? (current - 1 + visibleItems.length) %
                            visibleItems.length
                          : 0,
                      );
                      return;
                    }
                    if (event.key === "Enter") {
                      const target = visibleItems[activeIndex];
                      if (!target) return;
                      event.preventDefault();
                      setIsOpen(false);
                      router.push(target.href);
                    }
                  }}
                  placeholder="Search projects, tasks, or requests"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
                />
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="inline-flex size-7 items-center justify-center rounded-sm text-muted transition hover:bg-surface hover:text-foreground"
                >
                  <X className="size-4" />
                  <span className="sr-only">Close</span>
                </button>
              </div>

              <div className="max-h-[70dvh] overflow-y-auto p-2">
                {isLoading ? (
                  <div className="space-y-1.5">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <div key={index} className="ui-skeleton h-16" />
                    ))}
                  </div>
                ) : loadError ? (
                  <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center text-[13px] leading-7 text-muted">
                    {loadError}
                  </div>
                ) : visibleItems.length ? (
                  <div className="space-y-0.5">
                    {visibleItems.map((item, index) => {
                      const meta = kindMeta[item.kind];
                      const Icon = meta.icon;
                      const isActive = index === activeIndex;

                      return (
                        <Link
                          key={item.id}
                          href={item.href}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => setIsOpen(false)}
                          aria-selected={isActive}
                          className={cn(
                            "flex items-start justify-between gap-4 rounded-sm px-3 py-2.5 transition hover:bg-surface",
                            isActive && "bg-surface",
                          )}
                        >
                          <div className="flex min-w-0 items-start gap-2.5">
                            <div className="mt-0.5 inline-flex size-8 items-center justify-center rounded-sm border border-border bg-background text-muted">
                              <Icon className="size-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <p className="truncate text-[13px] font-medium text-foreground">
                                  {highlightMatches(item.title, queryTokens)}
                                </p>
                                <span className="ui-badge">{meta.label}</span>
                                {item.archived ? (
                                  <span className="ui-badge">Archived</span>
                                ) : null}
                              </div>
                              {item.code ? (
                                <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
                                  {highlightMatches(item.code, queryTokens)}
                                </p>
                              ) : null}
                              <p className="mt-0.5 text-[13px] leading-6 text-muted">
                                {highlightMatches(item.subtitle, queryTokens)}
                              </p>
                            </div>
                          </div>

                          <div className="shrink-0 text-right">
                            <p className="inline-flex items-center justify-end gap-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                              {item.projectColor ? (
                                <span
                                  aria-hidden
                                  className="inline-block size-2 rounded-full"
                                  style={{ backgroundColor: item.projectColor }}
                                />
                              ) : null}
                              {highlightMatches(item.projectName, queryTokens)}
                            </p>
                            <p
                              className={cn(
                                "mt-1 font-mono text-[11px] text-muted",
                                item.archived && "text-foreground",
                              )}
                            >
                              {item.status}
                            </p>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center">
                    <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
                      <MagnifyingGlass className="size-5" />
                    </div>
                    <p className="mt-3 text-[13px] font-medium text-foreground">No matches</p>
                    <p className="mt-1 text-[13px] leading-6 text-muted">
                      Try the project name, a task title, or part of a request.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>,
            document.body,
          )
        : null}
    </>
  );
}
