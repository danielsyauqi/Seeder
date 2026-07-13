"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CircleNotch, Crown, Trash, UserPlus } from "@phosphor-icons/react";

import { Avatar } from "@/components/ui/avatar";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type ProjectRole = "owner" | "leader" | "member";

type Owner = {
  userId: string;
  name: string;
  email: string;
  role: string;
  image: string | null;
};

type Member = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  projectRole: ProjectRole;
  image: string | null;
  addedAt: Date;
};

type Props = {
  projectId: string;
  owner: Owner | null;
  members: Member[];
  // Leader-level: can add/remove Members.
  canManage: boolean;
  // Owner-level: can add/remove/assign Leaders and change roles.
  canAdminister: boolean;
};

const projectRoleStyles: Record<ProjectRole, string> = {
  owner: "border-accent/30 bg-accent-soft text-accent",
  leader: "border-emerald/30 bg-emerald/10 text-emerald",
  member: "border-border bg-surface text-muted",
};

export function MembersManager({
  projectId,
  owner,
  members,
  canManage,
  canAdminister,
}: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [addRole, setAddRole] = useState<"member" | "leader">("member");
  const [isPending, startTransition] = useTransition();

  const addMember = () => {
    const target = email.trim();
    startTransition(async () => {
      const response = await fetch(`/api/projects/${projectId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: target, role: addRole }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !data.ok) {
        toast(data.error ?? "Failed to add member.", "danger");
        return;
      }
      toast(`Added ${target}`, "success");
      setEmail("");
      setAddRole("member");
      router.refresh();
    });
  };

  const removeMember = (userId: string) => {
    startTransition(async () => {
      const response = await fetch(
        `/api/projects/${projectId}/members?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        toast(data.error ?? "Could not remove member", "danger");
        return;
      }
      toast("Member removed", "success");
      router.refresh();
    });
  };

  const changeRole = (userId: string, role: ProjectRole) => {
    startTransition(async () => {
      const response = await fetch(`/api/projects/${projectId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        toast(data.error ?? "Could not change role", "danger");
        return;
      }
      toast(role === "leader" ? "Promoted to Leader" : "Set to Member", "success");
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      {canManage ? (
        <div className="ui-panel-soft p-5">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
            Add member
          </p>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            <span className="font-medium text-foreground">Leaders</span> run the
            project; <span className="font-medium text-foreground">Members</span>{" "}
            do the work. The email must belong to an existing account — invite
            them from{" "}
            <span className="font-medium text-foreground">/admin/invites</span>{" "}
            first.
            {canAdminister ? " Only you can grant the Leader role." : null}
          </p>
          <form
            className="mt-3 flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (isPending || !email.trim()) return;
              addMember();
            }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@company.com"
              className="ui-input min-w-0 flex-1"
              disabled={isPending}
            />
            {canAdminister ? (
              <div className="w-32 shrink-0">
                <select
                  value={addRole}
                  onChange={(e) =>
                    setAddRole(e.target.value as "member" | "leader")
                  }
                  aria-label="Role for the new member"
                  className="ui-select"
                  disabled={isPending}
                >
                  <option value="member">Member</option>
                  <option value="leader">Leader</option>
                </select>
              </div>
            ) : null}
            <button
              type="submit"
              disabled={isPending || !email.trim()}
              className="ui-button-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? (
                <CircleNotch className="size-4 animate-spin" />
              ) : (
                <UserPlus className="size-4" />
              )}
              Add
            </button>
          </form>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-surface px-4 py-3 text-[12px] leading-5 text-muted">
          You can view this project&apos;s members. Only the owner, a leader, or
          a workspace admin can add or remove members.
        </div>
      )}

      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-muted">
          Current members
        </p>
        <div className="mt-2 ui-panel-soft divide-y divide-border">
          {owner ? (
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Avatar
                name={owner.name}
                email={owner.email}
                image={owner.image}
                px={36}
                className="size-9 text-[12px]"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {owner.name}
                  </p>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em]",
                      projectRoleStyles.owner,
                    )}
                  >
                    <Crown className="size-3" />
                    Owner
                  </span>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                  {owner.email}
                </p>
              </div>
            </div>
          ) : null}

          {members.length === 0 && !owner ? (
            <div className="px-5 py-10 text-center text-[13px] leading-7 text-muted">
              No members yet.
            </div>
          ) : null}

          {members.map((m) => {
            // A leader can be removed only by an owner; members by any manager.
            const canRemove =
              canManage && (m.projectRole !== "leader" || canAdminister);
            return (
              <div
                key={m.membershipId}
                className="flex items-center gap-3 px-4 py-3"
              >
                <Avatar
                  name={m.name}
                  email={m.email}
                  image={m.image}
                  px={36}
                  className="size-9 text-[12px]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {m.name}
                    </p>
                    <span
                      className={cn(
                        "inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em]",
                        projectRoleStyles[m.projectRole] ??
                          projectRoleStyles.member,
                      )}
                    >
                      {m.projectRole}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                    {m.email} · added {m.addedAt.toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {canAdminister ? (
                    <div className="w-28">
                      <select
                        value={m.projectRole === "leader" ? "leader" : "member"}
                        onChange={(e) =>
                          changeRole(m.userId, e.target.value as ProjectRole)
                        }
                        aria-label={`Role for ${m.name}`}
                        className="ui-select"
                        disabled={isPending}
                      >
                        <option value="member">Member</option>
                        <option value="leader">Leader</option>
                      </select>
                    </div>
                  ) : null}
                  {canRemove ? (
                    <button
                      type="button"
                      onClick={() => removeMember(m.userId)}
                      disabled={isPending}
                      className="ui-button-ghost"
                      title="Remove member"
                      aria-label="Remove member"
                    >
                      <Trash className="size-4" />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
