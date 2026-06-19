import { revalidatePath } from "next/cache";
import { and, count, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";

import { requireRole } from "@/lib/auth-server";
import { getDb } from "@/lib/db";
import { account, session, user, userRoleValues } from "@/lib/db/schema";

type RouteParams = { params: Promise<{ userId: string }> };

// All fields optional — the Edit modal sends profile fields (+ optional
// password); the active toggle sends just `disabled`.
const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.email().transform((v) => v.toLowerCase()).optional(),
  role: z.enum(userRoleValues).optional(),
  image: z.string().trim().optional(), // "" clears the avatar
  password: z.string().min(8).max(128).optional(),
  disabled: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: RouteParams) {
  const viewer = await requireRole(["owner", "admin"]);
  const { userId } = await params;

  let payload: z.infer<typeof updateUserSchema>;
  try {
    payload = updateUserSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }

  const db = getDb();
  const [target] = await db
    .select({ id: user.id, email: user.email, role: user.role, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!target) {
    return Response.json({ error: "User not found." }, { status: 404 });
  }

  const isOwner = viewer.role === "owner";

  // Only an owner may modify another owner/admin account at all. Without this,
  // an admin could reset a higher-privileged user's password (or change their
  // email) and take over the account — the per-field role guard below only
  // protects the `role` field. Self-edits are still allowed (and remain bounded
  // by the role/last-owner/self-deactivation checks below).
  const targetIsPrivileged = target.role === "owner" || target.role === "admin";
  if (targetIsPrivileged && !isOwner && userId !== viewer.id) {
    return Response.json(
      { error: "Only an owner can modify an admin or owner account." },
      { status: 403 },
    );
  }

  const now = new Date();
  const updates: Partial<typeof user.$inferInsert> = { updatedAt: now };

  // Role change — only owners may touch admin/owner roles, and the last owner
  // cannot be demoted.
  if (payload.role && payload.role !== target.role) {
    if (!isOwner && (payload.role !== "member" || target.role !== "member")) {
      return Response.json(
        { error: "Only owners can change admin or owner roles." },
        { status: 403 },
      );
    }
    if (target.role === "owner" && payload.role !== "owner") {
      const [{ c }] = await db
        .select({ c: count() })
        .from(user)
        .where(eq(user.role, "owner"));
      if (c <= 1) {
        return Response.json(
          { error: "Cannot remove the last owner." },
          { status: 409 },
        );
      }
    }
    updates.role = payload.role;
  }

  // Email change — enforce uniqueness against other users.
  if (payload.email && payload.email !== target.email) {
    const [clash] = await db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.email, payload.email), ne(user.id, userId)))
      .limit(1);
    if (clash) {
      return Response.json(
        { error: "Another account already uses this email." },
        { status: 409 },
      );
    }
    updates.email = payload.email;
  }

  if (payload.name !== undefined) updates.name = payload.name;
  if (payload.image !== undefined) updates.image = payload.image.trim() || null;

  // Deactivate / reactivate.
  if (payload.disabled !== undefined) {
    if (payload.disabled) {
      if (userId === viewer.id) {
        return Response.json(
          { error: "You cannot deactivate your own account." },
          { status: 403 },
        );
      }
      if (target.role === "owner") {
        const [{ c }] = await db
          .select({ c: count() })
          .from(user)
          .where(and(eq(user.role, "owner"), isNull(user.disabledAt)));
        if (c <= 1) {
          return Response.json(
            { error: "Cannot deactivate the last active owner." },
            { status: 409 },
          );
        }
      }
      updates.disabledAt = now;
    } else {
      updates.disabledAt = null;
    }
  }

  await db.update(user).set(updates).where(eq(user.id, userId));

  // Password reset — rehash + update the credential account row.
  if (payload.password) {
    const passwordHash = await hashPassword(payload.password);
    await db
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential")));
  }

  // Force logout when deactivating or resetting the password.
  if (payload.disabled === true || payload.password) {
    await db.delete(session).where(eq(session.userId, userId));
  }

  revalidatePath("/admin/users");
  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const viewer = await requireRole(["owner", "admin"]);
  const { userId } = await params;

  if (userId === viewer.id) {
    return Response.json(
      { error: "You cannot delete your own account." },
      { status: 403 },
    );
  }

  const db = getDb();
  const [target] = await db
    .select({ id: user.id, role: user.role, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!target) {
    return Response.json({ error: "User not found." }, { status: 404 });
  }

  // Must be deactivated first. Deletion is destructive and cascades (it removes
  // every project the user OWNS, with all its tasks/history), so requiring the
  // deactivated state makes it a deliberate two-step action. It also keeps an
  // owner safe: the last ACTIVE owner can't be deactivated, so a deleted owner
  // is never the last one standing.
  if (!target.disabledAt) {
    return Response.json(
      { error: "Deactivate the user before deleting them." },
      { status: 409 },
    );
  }

  // Only an owner may delete another owner/admin account.
  const targetIsPrivileged = target.role === "owner" || target.role === "admin";
  if (targetIsPrivileged && viewer.role !== "owner") {
    return Response.json(
      { error: "Only an owner can delete an admin or owner account." },
      { status: 403 },
    );
  }

  // The FK graph does the rest: sessions/accounts/tokens, owned projects (and
  // their tasks/notes/activity), memberships and authored comments all cascade;
  // audit references (spaces.createdBy, notifications.actorId, …) go null.
  await db.delete(user).where(eq(user.id, userId));

  revalidatePath("/admin/users");
  return Response.json({ ok: true });
}
