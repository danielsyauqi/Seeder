// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { user as userTable, type UserRole } from "@/lib/db/schema";

export const getSession = cache(async () => {
  return auth.api.getSession({
    headers: await headers(),
  });
});

export async function requireSession() {
  const session = await getSession();

  if (!session) {
    redirect("/sign-in");
  }

  // Enforce deactivation at the action layer, not just via session deletion: a
  // disabled user holding a still-valid cookie must not mutate. getViewer is
  // request-cached and returns null for disabledAt users, so this adds no
  // duplicate query when the caller also reads the viewer.
  const viewer = await getViewer();
  if (!viewer) {
    redirect("/sign-in");
  }

  return session;
}

export type Viewer = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  image: string | null;
};

export const getViewer = cache(async (): Promise<Viewer | null> => {
  const session = await getSession();

  if (!session) return null;

  const db = getDb();
  const [row] = await db
    .select({
      id: userTable.id,
      email: userTable.email,
      name: userTable.name,
      role: userTable.role,
      image: userTable.image,
      disabledAt: userTable.disabledAt,
    })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);

  if (!row) return null;
  // Deactivated users are treated as logged-out everywhere — requireViewer /
  // requireRole then redirect them to /sign-in.
  if (row.disabledAt) return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    image: row.image,
  };
});

export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();

  if (!viewer) {
    redirect("/sign-in");
  }

  return viewer;
}

export async function requireRole(
  allowed: UserRole | readonly UserRole[],
): Promise<Viewer> {
  const viewer = await requireViewer();
  const allowedList = Array.isArray(allowed) ? allowed : [allowed];

  if (!allowedList.includes(viewer.role)) {
    redirect("/projects");
  }

  return viewer;
}

export function isAdminTier(role: UserRole) {
  return role === "owner" || role === "admin";
}
