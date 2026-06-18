import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";

import { requireRole } from "@/lib/auth-server";
import { getDb } from "@/lib/db";
import { account, user, userRoleValues } from "@/lib/db/schema";
import { ensurePersonalSpace } from "@/lib/services/spaces";

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().transform((v) => v.toLowerCase()),
  role: z.enum(userRoleValues).default("member"),
  password: z.string().min(8).max(128),
  image: z.string().trim().optional(),
});

export async function POST(request: Request) {
  const viewer = await requireRole(["owner", "admin"]);

  let payload: z.infer<typeof createUserSchema>;
  try {
    payload = createUserSchema.parse(await request.json());
  } catch {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }

  // Only owners can mint admin/owner accounts; admins create members only.
  if (payload.role !== "member" && viewer.role !== "owner") {
    return Response.json(
      { error: "Only owners can create admins or owners." },
      { status: 403 },
    );
  }

  const db = getDb();
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, payload.email))
    .limit(1);
  if (existing) {
    return Response.json(
      { error: "An account already exists for this email." },
      { status: 409 },
    );
  }

  const now = new Date();
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const passwordHash = await hashPassword(payload.password);

  // Mirror the invite-accept flow: a user row + a credential account row.
  await db.insert(user).values({
    id: userId,
    name: payload.name,
    email: payload.email,
    emailVerified: true,
    image: payload.image?.trim() || null,
    role: payload.role,
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

  // Give the new user their Personal space (this insert bypasses the auth hook).
  await ensurePersonalSpace(userId);

  revalidatePath("/admin/users");
  return Response.json({ ok: true, id: userId });
}
