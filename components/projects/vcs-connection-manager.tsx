"use client";

// Git integration settings section (spec §1.7) — a 3-step connect wizard plus
// the list of existing connections. There's no existing multi-step wizard
// component in the repo (recon: token-manager.tsx / create-branch-modal.tsx
// are single-form-then-reveal), so this duplicates the ModalShell portal
// pattern those files use rather than extracting a shared one, matching how
// the repo already duplicates that shell per-file.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  CheckCircle,
  CircleNotch,
  Copy,
  GithubLogo,
  GitlabLogo,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  createVcsConnectionAction,
  deleteVcsConnectionAction,
  syncVcsConnectionAction,
  updateVcsConnectionAction,
} from "@/lib/actions";
import type { VcsLinkMode, VcsProvider } from "@/lib/db/schema";
import type { VcsConnectionSummary } from "@/lib/services/vcs";
import { detectProviderFromUrl, parseRepositoryUrl } from "@/lib/services/vcs/repo-url";
import { toast } from "@/lib/toast";
import { cn, formatDate } from "@/lib/utils";

type ProviderConfig = {
  value: VcsProvider;
  label: string;
  icon: typeof GithubLogo;
  defaultBaseUrl: string;
  scopeHint: string;
  webhookHint: string;
};

// Gitea isn't offered in the wizard yet (spec §0/§1.1a) — GitHub | GitLab only.
const PROVIDERS: ProviderConfig[] = [
  {
    value: "github",
    label: "GitHub",
    icon: GithubLogo,
    defaultBaseUrl: "https://github.com",
    scopeHint:
      "Fine-grained PAT with Contents: read + Metadata: read (or a classic token with repo read access).",
    webhookHint:
      "Repo → Settings → Webhooks → Add webhook. Content type application/json, paste the secret below, and enable the Push, Create, and Delete events.",
  },
  {
    value: "gitlab",
    label: "GitLab",
    icon: GitlabLogo,
    defaultBaseUrl: "https://gitlab.com",
    scopeHint: "Personal access token with the read_api scope.",
    webhookHint:
      "Repo → Settings → Webhooks. Paste the secret below as the Secret token, and enable Push events.",
  },
];

const LINK_MODES: {
  value: VcsLinkMode;
  label: string;
  describe: (slug: string) => string;
}[] = [
  {
    value: "branch",
    label: "Use real branches",
    describe: (slug) =>
      `A branch named feature/${slug}-123-login links itself and every commit on it to ${slug}-123, even without a code in the commit messages.`,
  },
  {
    value: "ticket",
    label: "Ticket ID only",
    describe: (slug) =>
      `Only commits that mention a ticket code (e.g. "${slug}-123: fix login") get linked. Branch names still link the branch itself.`,
  },
];

const linkModeLabel: Record<VcsLinkMode, string> = {
  branch: "Real branches",
  ticket: "Ticket ID only",
};

function providerConfig(provider: VcsProvider): ProviderConfig {
  return PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];
}

async function copyText(value: string, label: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied`, "success");
    return true;
  } catch {
    toast("Copy failed — select the text and copy manually", "danger");
    return false;
  }
}

export function VcsConnectionManager({
  projectId,
  projectSlug,
  canAdminister,
  connections,
}: {
  projectId: string;
  projectSlug: string;
  canAdminister: boolean;
  connections: VcsConnectionSummary[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<VcsConnectionSummary | null>(
    null,
  );
  const [deletePending, setDeletePending] = useState(false);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleSync(connection: VcsConnectionSummary) {
    setSyncingId(connection.id);
    try {
      const formData = new FormData();
      formData.set("projectId", projectId);
      formData.set("connectionId", connection.id);
      const result = await syncVcsConnectionAction(formData);
      if (result.degraded) {
        toast(
          "Couldn't reach the provider right now — webhook sync keeps working.",
          "danger",
        );
      } else {
        toast(
          `Synced ${result.commitsIngested} commit${result.commitsIngested === 1 ? "" : "s"}`,
          "success",
        );
      }
      refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Sync failed", "danger");
    } finally {
      setSyncingId(null);
    }
  }

  async function handleLinkModeChange(
    connection: VcsConnectionSummary,
    linkMode: VcsLinkMode,
  ) {
    try {
      const formData = new FormData();
      formData.set("projectId", projectId);
      formData.set("connectionId", connection.id);
      formData.set("linkMode", linkMode);
      await updateVcsConnectionAction(formData);
      toast("Link mode updated", "success");
      refresh();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not update link mode",
        "danger",
      );
    }
  }

  async function handleDelete() {
    if (!disconnecting) return;
    setDeletePending(true);
    try {
      const formData = new FormData();
      formData.set("projectId", projectId);
      formData.set("connectionId", disconnecting.id);
      await deleteVcsConnectionAction(formData);
      toast("Connection removed", "success");
      setDisconnecting(null);
      refresh();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not disconnect",
        "danger",
      );
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] leading-6 text-muted">
          {connections.length
            ? `${connections.length} repo${connections.length === 1 ? "" : "s"} connected.`
            : "No repository connected yet."}
        </p>
        {canAdminister ? (
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="ui-button-primary shrink-0"
          >
            <Plus className="size-4" />
            Connect repo
          </button>
        ) : null}
      </div>

      {connections.length ? (
        <ul className="grid gap-2">
          {connections.map((connection) => {
            const config = providerConfig(connection.provider);
            const Icon = config.icon;
            const busy = syncingId === connection.id;
            return (
              <li
                key={connection.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-3"
              >
                <div className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted">
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {connection.owner}/{connection.repo}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                    {config.label}
                    {connection.baseUrl ? ` · ${connection.baseUrl}` : ""} · Last
                    synced{" "}
                    {connection.lastReconciledAt
                      ? formatDate(connection.lastReconciledAt)
                      : "never"}
                  </p>
                </div>

                {canAdminister ? (
                  <select
                    value={connection.linkMode}
                    onChange={(event) =>
                      handleLinkModeChange(
                        connection,
                        event.target.value as VcsLinkMode,
                      )
                    }
                    className="ui-select w-auto shrink-0 text-[12px]"
                    aria-label="Link mode"
                  >
                    {LINK_MODES.map((mode) => (
                      <option key={mode.value} value={mode.value}>
                        {mode.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="ui-badge shrink-0">
                    {linkModeLabel[connection.linkMode]}
                  </span>
                )}

                {canAdminister ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleSync(connection)}
                      disabled={busy}
                      className="ui-button-secondary px-3 text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy ? (
                        <CircleNotch className="size-3.5 animate-spin" />
                      ) : null}
                      Sync now
                    </button>
                    <button
                      type="button"
                      onClick={() => setDisconnecting(connection)}
                      aria-label={`Disconnect ${connection.owner}/${connection.repo}`}
                      title="Disconnect"
                      className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash className="size-4" />
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : !canAdminister ? (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-8 text-center text-[13px] leading-7 text-muted">
          Ask a project owner to connect a GitHub or GitLab repo.
        </div>
      ) : null}

      {wizardOpen ? (
        <ConnectWizard
          projectId={projectId}
          projectSlug={projectSlug}
          onClose={() => {
            setWizardOpen(false);
            refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(disconnecting)}
        title={`Disconnect ${disconnecting ? `${disconnecting.owner}/${disconnecting.repo}` : "this repo"}?`}
        description="Stops syncing new commits and branches. Everything already synced (commits, links, activity) stays in place."
        confirmLabel="Disconnect"
        cancelLabel="Keep"
        variant="danger"
        isPending={deletePending}
        onCancel={() => setDisconnecting(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

type CreatedConnection = {
  connection: VcsConnectionSummary;
  receiverUrl: string;
  webhookSecret: string;
};

function ConnectWizard({
  projectId,
  projectSlug,
  onClose,
}: {
  projectId: string;
  projectSlug: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<VcsProvider>("github");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [linkMode, setLinkMode] = useState<VcsLinkMode>("ticket");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedConnection | null>(null);
  const [copied, setCopied] = useState<"url" | "secret" | null>(null);

  function handleRepositoryUrlChange(value: string) {
    setRepositoryUrl(value);
    // github.com/gitlab.com are unambiguous — self-managed hosts (GHE,
    // self-hosted GitLab) can't be told apart by host alone, so leave the
    // provider as-is and let the user pick explicitly for those.
    const detected = detectProviderFromUrl(value);
    if (detected) setProvider(detected);
  }

  const parsedRepo = repositoryUrl.trim() ? parseRepositoryUrl(repositoryUrl, provider) : null;
  const step1Valid = parsedRepo !== null && accessToken.trim().length > 0;

  async function handleCreate() {
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.set("projectId", projectId);
      formData.set("provider", provider);
      formData.set("repositoryUrl", repositoryUrl.trim());
      formData.set("accessToken", accessToken.trim());
      formData.set("linkMode", linkMode);
      const result = await createVcsConnectionAction(formData);
      setCreated(result);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the repo");
    } finally {
      setSubmitting(false);
    }
  }

  async function copy(value: string, field: "url" | "secret", label: string) {
    if (await copyText(value, label)) {
      setCopied(field);
      window.setTimeout(
        () => setCopied((current) => (current === field ? null : current)),
        2000,
      );
    }
  }

  const config = providerConfig(provider);
  const createdConfig = created ? providerConfig(created.connection.provider) : null;

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[55] p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="ui-modal-backdrop absolute inset-0 bg-[rgba(10,10,10,0.44)] backdrop-blur-xs"
      />
      <div className="relative flex min-h-full items-end justify-center sm:items-center">
        <div className="ui-modal-panel relative max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-md border border-border bg-surface-strong p-5 shadow-xl sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                Git integration · Step {step} of 3
              </p>
              <h3 className="mt-2 text-[1.2rem] font-medium tracking-[-0.022em] text-foreground">
                {step === 1 ? "Provider & repo" : step === 2 ? "Link mode" : "Webhook"}
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:bg-surface-strong hover:text-foreground"
            >
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </button>
          </div>

          {step === 1 ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!step1Valid) return;
                setStep(2);
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                {PROVIDERS.map((option) => {
                  const Icon = option.icon;
                  const selected = provider === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setProvider(option.value)}
                      aria-pressed={selected}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-3 text-left transition",
                        selected
                          ? "border-accent bg-accent-soft text-foreground"
                          : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground",
                      )}
                    >
                      <Icon className="size-5 shrink-0" />
                      <span className="text-[13px] font-medium">{option.label}</span>
                    </button>
                  );
                })}
              </div>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">
                  Repository URL
                </span>
                <input
                  value={repositoryUrl}
                  onChange={(event) => handleRepositoryUrlChange(event.target.value)}
                  className="ui-input"
                  placeholder={`${config.defaultBaseUrl}/owner/repo`}
                  autoFocus
                />
                {repositoryUrl.trim() && !parsedRepo ? (
                  <span className="text-[12px] text-danger">
                    Paste a full repository link, e.g. {config.defaultBaseUrl}/owner/repo
                  </span>
                ) : parsedRepo ? (
                  <span className="text-[12px] text-muted">
                    {parsedRepo.owner}/{parsedRepo.repo}
                    {parsedRepo.baseUrl !== config.defaultBaseUrl
                      ? ` · self-managed at ${parsedRepo.baseUrl}`
                      : ""}
                  </span>
                ) : (
                  <span className="text-[12px] text-muted">
                    Works with self-managed instances too (GitHub Enterprise,
                    self-hosted GitLab) — just paste the full URL.
                  </span>
                )}
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">
                  Access token
                </span>
                <input
                  type="password"
                  value={accessToken}
                  onChange={(event) => setAccessToken(event.target.value)}
                  className="ui-input font-mono"
                  placeholder="•••••••••••••••"
                  autoComplete="off"
                />
                <span className="text-[12px] text-muted">{config.scopeHint}</span>
              </label>

              {error ? <p className="text-[12px] text-danger">{error}</p> : null}

              <button
                type="submit"
                disabled={!step1Valid}
                className="ui-button-primary mt-1 w-full disabled:cursor-not-allowed disabled:opacity-60"
              >
                Continue
              </button>
            </form>
          ) : null}

          {step === 2 ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (submitting) return;
                handleCreate();
              }}
            >
              <div className="grid gap-3">
                {LINK_MODES.map((mode) => {
                  const selected = linkMode === mode.value;
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      onClick={() => setLinkMode(mode.value)}
                      aria-pressed={selected}
                      className={cn(
                        "rounded-md border px-4 py-3 text-left transition",
                        selected
                          ? "border-accent bg-accent-soft"
                          : "border-border bg-surface hover:border-border-strong",
                      )}
                    >
                      <p className="text-[13px] font-medium text-foreground">
                        {mode.label}
                      </p>
                      <p className="mt-1 text-[12px] leading-6 text-muted">
                        {mode.describe(projectSlug || "SLUG")}
                      </p>
                    </button>
                  );
                })}
              </div>

              {error ? <p className="text-[12px] text-danger">{error}</p> : null}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="ui-button-secondary w-full"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="ui-button-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? (
                    <CircleNotch className="size-4 animate-spin" />
                  ) : null}
                  {submitting ? "Connecting…" : "Connect repo"}
                </button>
              </div>
            </form>
          ) : null}

          {step === 3 && created && createdConfig ? (
            <div className="grid gap-4">
              <div className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent-soft p-3 text-[12px] leading-5 text-foreground">
                <CheckCircle className="mt-0.5 size-4 shrink-0 text-accent" />
                <span>
                  Copy the secret now — for security it{" "}
                  <strong>won&apos;t be shown again</strong>. Paste both values
                  into the repo&apos;s webhook settings.
                </span>
              </div>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">
                  Receiver URL
                </span>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={created.receiverUrl}
                    onFocus={(event) => event.currentTarget.select()}
                    className="ui-input min-w-0 flex-1 font-mono text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={() => copy(created.receiverUrl, "url", "Receiver URL")}
                    className="ui-button-secondary shrink-0 px-3"
                  >
                    {copied === "url" ? (
                      <CheckCircle className="size-4 text-accent" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </button>
                </div>
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Secret</span>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={created.webhookSecret}
                    onFocus={(event) => event.currentTarget.select()}
                    className="ui-input min-w-0 flex-1 font-mono text-[12px]"
                  />
                  <button
                    type="button"
                    onClick={() => copy(created.webhookSecret, "secret", "Secret")}
                    className="ui-button-secondary shrink-0 px-3"
                  >
                    {copied === "secret" ? (
                      <CheckCircle className="size-4 text-accent" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </button>
                </div>
              </label>

              <div className="min-w-0 rounded-md border border-border bg-surface p-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                  {createdConfig.label} setup
                </p>
                <p className="mt-2 text-[12px] leading-6 text-muted">
                  {createdConfig.webhookHint}
                </p>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="ui-button-primary mt-1 w-full"
              >
                Done
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
