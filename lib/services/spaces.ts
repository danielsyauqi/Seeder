// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Space services. A Space groups projects and is the lowest-precedence access
// tier (see lib/authz.ts): Personal spaces are private to their owner; Company
// spaces are shared — members get baseline access to all the space's projects,
// and a Space Lead (+ workspace admins) manage them. This module starts with
// the provisioning helper every user-creation path needs; the management
// services (create/rename/delete/members/move) are added in a later phase.
import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { spaces } from "@/lib/db/schema";

/**
 * Guarantee the user has their one Personal space and return its id. Called at
 * every user-creation path so a user always has a default home before they can
 * create a project. Idempotent: re-reads on the partial-unique collision from a
 * concurrent create. Safe to call repeatedly.
 */
export async function ensurePersonalSpace(userId: string): Promise<string> {
  const db = getDb();

  const findExisting = async () => {
    const [row] = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.ownerId, userId), eq(spaces.kind, "personal")))
      .limit(1);
    return row?.id ?? null;
  };

  const existing = await findExisting();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = new Date();
  try {
    await db.insert(spaces).values({
      id,
      kind: "personal",
      name: "Personal",
      ownerId: userId,
      leadId: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  } catch (error) {
    // A concurrent call won the partial-unique (spaces_personal_owner_idx);
    // adopt the row it created.
    const raced = await findExisting();
    if (raced) return raced;
    throw error;
  }
}
