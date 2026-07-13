"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CircleNotch, PaperPlaneTilt } from "@phosphor-icons/react";

import { toast } from "@/lib/toast";

type Role = "member" | "admin";

export function InviteForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    const target = email.trim();
    startTransition(async () => {
      const response = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: target, role }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        token?: string;
        error?: string;
      };

      if (!response.ok || !data.ok) {
        toast(data.error ?? "Failed to create invitation.", "danger");
        return;
      }

      // No email is sent — the invite is a shareable link the admin copies from
      // the list below. Don't imply the invitee will receive a message.
      toast(`Invite created for ${target} — copy the link to share`, "success");
      setEmail("");
      setRole("member");
      router.refresh();
    });
  };

  return (
    <div className="ui-panel-soft p-5">
      <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
        New invitation
      </p>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_180px_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (isPending || !email.trim()) return;
          submit();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="colleague@company.com"
          className="ui-input"
          disabled={isPending}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="ui-select"
          disabled={isPending}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button
          type="submit"
          disabled={isPending || !email.trim()}
          className="ui-button-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? (
            <CircleNotch className="size-4 animate-spin" />
          ) : (
            <PaperPlaneTilt className="size-4" />
          )}
          Create invite
        </button>
      </form>

      <p className="mt-3 text-[12px] leading-5 text-muted">
        Links expire after 7 days. Admins can invite members; only the owner can
        invite other admins.
      </p>
    </div>
  );
}
