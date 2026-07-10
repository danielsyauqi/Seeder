import Link from "next/link";
import { ArrowSquareOut, GitBranch, GithubLogo, GitlabLogo } from "@phosphor-icons/react/dist/ssr";

import type { CommitSummary, VcsConnectionSummary } from "@/lib/services/vcs";
import { cn } from "@/lib/utils";

const providerIcon = {
  github: GithubLogo,
  gitlab: GitlabLogo,
  gitea: GitBranch,
} as const;

function formatRelativeTime(value: Date | null): string {
  if (!value) return "—";
  const diffMs = Date.now() - value.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)}d ago`;
  return value.toLocaleDateString();
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function commitAuthor(commit: CommitSummary): string {
  return commit.authorUsername || commit.authorName || commit.authorEmail || "Unknown";
}

function CommitRow({ commit }: { commit: CommitSummary }) {
  const message = commit.message?.split("\n")[0]?.trim() || "(no commit message)";
  const row = (
    <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3 transition hover:border-border-strong">
      <code className="shrink-0 rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted">
        {shortSha(commit.sha)}
      </code>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{message}</p>
        <p className="mt-0.5 font-mono text-[11px] text-muted">
          {commitAuthor(commit)} · {formatRelativeTime(commit.committedAt)}
          {commit.refName ? ` · ${commit.refName}` : ""}
        </p>
      </div>
      <ArrowSquareOut className="size-4 shrink-0 text-muted" />
    </div>
  );

  if (!commit.url) return row;

  return (
    <Link href={commit.url} target="_blank" rel="noreferrer" className="block">
      {row}
    </Link>
  );
}

export function ProjectGitPanel({
  projectId,
  canAdminister,
  connections,
  commits,
}: {
  projectId: string;
  canAdminister: boolean;
  connections: VcsConnectionSummary[];
  commits: CommitSummary[];
}) {
  return (
    <div className="grid gap-4">
      <section className="ui-panel p-5 sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
              Git
            </p>
            <h2 className="text-[17px] font-medium tracking-[-0.022em] text-foreground">
              Connected repositories
            </h2>
          </div>
          {canAdminister ? (
            <Link
              href={`/projects/${projectId}/settings`}
              className="ui-button-secondary shrink-0"
            >
              Manage connections
            </Link>
          ) : null}
        </div>

        {connections.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {connections.map((connection) => {
              const Icon = providerIcon[connection.provider];
              return (
                <li
                  key={connection.id}
                  className={cn(
                    "flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3",
                  )}
                >
                  <div className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {connection.owner}/{connection.repo}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-muted">
                      {connection.linkMode === "branch"
                        ? "Real branches"
                        : "Ticket ID only"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-surface px-5 py-8 text-center text-[13px] leading-7 text-muted">
            {canAdminister ? (
              <>
                No repository connected yet.{" "}
                <Link
                  href={`/projects/${projectId}/settings`}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Connect one in Settings
                </Link>
                {" "}to sync commits and branches.
              </>
            ) : (
              "No repository connected yet. Ask a project owner to connect one from Settings."
            )}
          </div>
        )}
      </section>

      <section className="ui-panel p-5 sm:p-6">
        <div className="mb-4 space-y-1">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
            Activity
          </p>
          <h2 className="text-[17px] font-medium tracking-[-0.022em] text-foreground">
            Recent commits
          </h2>
        </div>

        {commits.length ? (
          <div className="grid gap-2">
            {commits.map((commit) => (
              <CommitRow key={commit.id} commit={commit} />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-surface px-5 py-10 text-center text-[13px] leading-7 text-muted">
            {connections.length
              ? "No commits synced yet. Push to the connected repo, or use Sync now in Settings."
              : "Commits show up here once a repo is connected."}
          </div>
        )}
      </section>
    </div>
  );
}
