"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  CheckCircle,
  CircleNotch,
  Copy,
  Key,
  Plus,
  Prohibit,
  X,
} from "@phosphor-icons/react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { TokenListItem } from "@/lib/data-tokens";
import type { TokenScope } from "@/lib/db/schema";

const scopeStyles: Record<TokenScope, string> = {
  readwrite: "border-accent/30 bg-accent-soft text-accent",
  read: "border-border bg-surface text-muted",
};
const scopeLabel: Record<TokenScope, string> = {
  read: "Read",
  readwrite: "Read · Write",
};

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: "No expiry", days: null },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

function formatRelative(date: Date | null) {
  if (!date) return "Never";
  const diff = Date.now() - date.getTime();
  const day = 86_400_000;
  if (diff < day) return "Today";
  if (diff < 2 * day) return "Yesterday";
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString();
}

export function TokenManager({ tokens }: { tokens: TokenListItem[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<TokenListItem | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function revoke(token: TokenListItem) {
    setPendingId(token.id);
    try {
      const response = await fetch(`/api/account/tokens/${token.id}/revoke`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Revoke failed");
      toast("Token revoked", "success");
      startTransition(() => router.refresh());
    } catch (error) {
      toast(error instanceof Error ? error.message : "Revoke failed", "danger");
    } finally {
      setPendingId(null);
      setRevoking(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="ui-panel ui-header p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
              Settings · API tokens
            </p>
            <h1 className="mt-2 text-[24px] font-medium tracking-[-0.022em] text-foreground">
              Personal access tokens
            </h1>
            <p className="mt-1 max-w-prose text-[13px] leading-6 text-muted">
              Let an AI assistant or script act as you through the MCP endpoint
              (<code className="font-mono text-[12px]">/api/mcp</code>) — read or
              edit projects, tasks, categories, labels, requests, comments,
              notes, members, and settings. A token can
              never do more than you can, and is shown only once — treat it like a
              password.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="ui-button-primary shrink-0"
          >
            <Plus className="size-4" />
            New token
          </button>
        </div>
      </section>

      <div className="ui-panel-soft divide-y divide-border">
        {tokens.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] leading-7 text-muted">
            No tokens yet. Create one to connect an MCP client.
          </div>
        ) : (
          tokens.map((token) => {
            const revoked = token.status === "revoked";
            const expired = token.status === "expired";
            const inactive = token.status !== "active";
            const busy = pendingId === token.id;
            return (
              <div
                key={token.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 px-4 py-3",
                  inactive && "opacity-60",
                )}
              >
                <div className="inline-flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted">
                  <Key className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {token.name}
                    </p>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em]",
                        scopeStyles[token.scope],
                      )}
                    >
                      {scopeLabel[token.scope]}
                    </span>
                    {revoked ? (
                      <span className="inline-flex items-center rounded-sm border border-danger/30 bg-danger/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-danger">
                        Revoked
                      </span>
                    ) : expired ? (
                      <span className="inline-flex items-center rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-muted">
                        Expired
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                    {token.tokenPrefix}…
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-left font-mono sm:gap-6 sm:text-right">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.04em] text-muted">
                      Last used
                    </p>
                    <p className="text-[13px] font-medium text-foreground">
                      {formatRelative(token.lastUsedAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.04em] text-muted">
                      Expires
                    </p>
                    <p className="text-[13px] font-medium text-foreground">
                      {token.expiresAt ? token.expiresAt.toLocaleDateString() : "Never"}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {!inactive ? (
                    <button
                      type="button"
                      onClick={() => setRevoking(token)}
                      disabled={busy}
                      aria-label={`Revoke ${token.name}`}
                      title="Revoke"
                      className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy ? (
                        <CircleNotch className="size-4 animate-spin" />
                      ) : (
                        <Prohibit className="size-4" />
                      )}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {creating ? (
        <CreateTokenModal
          onClose={() => setCreating(false)}
          onCreated={() => startTransition(() => router.refresh())}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(revoking)}
        title={`Revoke ${revoking?.name ?? "token"}?`}
        description="Any client using this token loses access immediately. This can't be undone — you'd create a new token to reconnect."
        confirmLabel="Revoke"
        cancelLabel="Keep"
        variant="danger"
        isPending={Boolean(pendingId)}
        onCancel={() => setRevoking(null)}
        onConfirm={() => revoking && revoke(revoking)}
      />
    </div>
  );
}

function CreateTokenModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("read");
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-domain";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/account/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scope,
          ...(expiryDays ? { expiresInDays: expiryDays } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
      };
      if (!response.ok || !data.token) {
        throw new Error(data.error || "Could not create token");
      }
      setCreated(data.token);
      onCreated(); // refresh the list behind the modal
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not create token",
        "danger",
      );
    } finally {
      setSaving(false);
    }
  }

  async function copyToken() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
      toast("Token copied", "success");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copy failed — select the text and copy manually", "danger");
    }
  }

  if (typeof document === "undefined") return null;

  const snippet = JSON.stringify(
    {
      mcpServers: {
        seeder: {
          url: `${origin}/api/mcp`,
          headers: { Authorization: `Bearer ${created ?? "seed_pat_…"}` },
        },
      },
    },
    null,
    2,
  );

  return createPortal(
    <div className="fixed inset-0 z-[55] p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="ui-modal-backdrop absolute inset-0 bg-[rgba(10,10,10,0.44)] backdrop-blur-xs"
      />
      <div className="relative flex min-h-full items-end justify-center sm:items-center">
        <div className="ui-modal-panel relative max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-md border border-border bg-surface-strong p-5 shadow-xl sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-muted">
                Settings · API tokens
              </p>
              <h3 className="mt-2 text-[1.2rem] font-medium tracking-[-0.022em] text-foreground">
                {created ? "Copy your token" : "New token"}
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

          {created ? (
            <div className="grid grid-cols-1 gap-4">
              <div className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent-soft p-3 text-[12px] leading-5 text-foreground">
                <CheckCircle className="mt-0.5 size-4 shrink-0 text-accent" />
                <span>
                  Copy this token now — for security it{" "}
                  <strong>won&apos;t be shown again</strong>. Store it in your MCP
                  client config.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={created}
                  onFocus={(e) => e.currentTarget.select()}
                  className="ui-input min-w-0 flex-1 font-mono text-[12px]"
                />
                <button
                  type="button"
                  onClick={copyToken}
                  className="ui-button-secondary shrink-0 px-3"
                >
                  {copied ? (
                    <CheckCircle className="size-4 text-accent" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="min-w-0 rounded-md border border-border bg-surface p-3">
                <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
                  MCP client config (Claude, Cursor, …)
                </p>
                <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre font-mono text-[11px] leading-5 text-foreground">
                  {snippet}
                </pre>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="ui-button-primary mt-1 w-full px-4"
              >
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="grid gap-4">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  className="ui-input"
                  placeholder="e.g. Claude desktop"
                  autoFocus
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Scope</span>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as TokenScope)}
                  className="ui-select"
                >
                  <option value="read">
                    Read — browse projects, tasks, requests, and activity
                  </option>
                  <option value="readwrite">
                    Read &amp; write — also manage tasks, projects, members &amp;
                    invites
                  </option>
                </select>
                <span className="text-[12px] text-muted">
                  A token can never exceed your own access. Editing project
                  settings, members, and invites still needs owner or admin rights.
                </span>
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">Expiry</span>
                <select
                  value={expiryDays === null ? "" : String(expiryDays)}
                  onChange={(e) =>
                    setExpiryDays(
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  className="ui-select"
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option
                      key={opt.label}
                      value={opt.days === null ? "" : String(opt.days)}
                    >
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="submit"
                disabled={saving}
                className="ui-button-primary mt-2 w-full px-4 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? <CircleNotch className="size-4 animate-spin" /> : null}
                {saving ? "Creating…" : "Create token"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
