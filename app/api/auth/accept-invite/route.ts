import { and, eq, isNull, gt } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";

import { getDb } from "@/lib/db";
import { account, invitations, user } from "@/lib/db/schema";
import { ensurePersonalSpace } from "@/lib/services/spaces";

const acceptInviteSchema = z.object({
  token: z.string().trim().min(1),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(128),
});

export async function POST(request: Request) {
  let payload: z.infer<typeof acceptInviteSchema>;

  try {
    payload = acceptInviteSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }

  const db = getDb();
  const now = new Date();

  const [invite] = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.token, payload.token),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .limit(1);

  if (!invite) {
    return Response.json(
      { error: "Invitation is invalid or has expired." },
      { status: 400 },
    );
  }

  const email = invite.email.toLowerCase();

  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (existing) {
    return Response.json(
      { error: "An account already exists for this email." },
      { status: 409 },
    );
  }

  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const passwordHash = await hashPassword(payload.password);

  await db.insert(user).values({
    id: userId,
    name: payload.name,
    email,
    emailVerified: false,
    role: invite.role,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(account).values({
    id: accountId,
    accountId: userId,
    providerId: "credential",
    userId,
    password: passwordHash,
    createdAt: now,
    updatedAt: now,
  });

  await db
    .update(invitations)
    .set({ acceptedAt: now })
    .where(eq(invitations.id, invite.id));

  // Give the new user their Personal space (this insert bypasses the auth hook).
  await ensurePersonalSpace(userId);

  return Response.json({ ok: true, email });
}
