import { ne } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { VCS_BOT_USER_ID } from "@/lib/services/vcs/constants";

// Migration 0038 creates a permanent bot row before the first owner signs up.
// Only a real user should close the one-time bootstrap path.
export async function hasRegisteredUser(): Promise<boolean> {
  const [existing] = await getDb()
    .select({ id: user.id })
    .from(user)
    .where(ne(user.id, VCS_BOT_USER_ID))
    .limit(1);

  return Boolean(existing);
}
