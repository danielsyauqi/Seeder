"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ArrowSquareOut,
  Buildings,
  CircleNotch,
  Crown,
  Plus,
} from "@phosphor-icons/react";

import { toast } from "@/lib/toast";

type SpaceRow = {
  id: string;
  name: string;
  leadName: string | null;
  memberCount: number;
  projectCount: number;
};

// Company-space list (Personal is never shown here). Admins get a create form;
// every row links to the space detail (members + projects).
export function SpacesList({
  spaces,
  canCreate,
}: {
  spaces: SpaceRow[];
  canCreate: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");

  const create = () => {
    const value = name.trim();
    if (!value) return;
    startTransition(async () => {
      const res = await fetch("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "create", name: value }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        toast(data.error ?? "Could not create the space.", "danger");
        return;
      }
      toast("Company space created", "success");
      setName("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {canCreate ? (
        <div className="ui-panel-soft p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
            Create company space
          </p>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            Name it after the company or team. You become its lead — open it to
            add members and grant access to its projects.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Northwind Retail"
              className="ui-input min-w-0 flex-1"
              disabled={isPending}
            />
            <button
              type="button"
              onClick={create}
              disabled={isPending || !name.trim()}
              className="ui-button-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? (
                <CircleNotch className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Create
            </button>
          </div>
        </div>
      ) : null}

      {spaces.length ? (
        <div className="grid gap-2">
          {spaces.map((space) => (
            <Link
              key={space.id}
              href={`/spaces/${space.id}`}
              className="group flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3 transition hover:border-border-strong hover:bg-surface-strong"
            >
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted">
                <Buildings className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[15px] font-medium tracking-[-0.011em] text-foreground">
                  {space.name}
                </h3>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Crown className="size-3" />
                    {space.leadName ?? "No lead"}
                  </span>
                  <span>· {space.memberCount} member{space.memberCount === 1 ? "" : "s"}</span>
                  <span>· {space.projectCount} project{space.projectCount === 1 ? "" : "s"}</span>
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-muted transition group-hover:text-foreground">
                Open
                <ArrowSquareOut className="size-4" />
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface px-5 py-12 text-center">
          <div className="mx-auto inline-flex size-10 items-center justify-center rounded-md border border-border bg-background text-muted">
            <Buildings className="size-5" />
          </div>
          <p className="mt-3 text-[13px] font-medium text-foreground">
            No company spaces yet
          </p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] leading-6 text-muted">
            {canCreate
              ? "Create one above to group projects and share them with a team."
              : "You're not a member of any company space yet."}
          </p>
        </div>
      )}
    </div>
  );
}
