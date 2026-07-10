import { getDb } from "@/lib/db";
import { notifications, type NotificationTone } from "@/lib/db/schema";
import { chunk } from "@/lib/utils";

// D1 caps every statement at 100 bound parameters; each notification row
// binds 12 columns, so floor(100/12) = 8 rows/statement keeps a large
// fan-out (e.g. VCS Sync's "N commits pushed" notify-all-members) from
// throwing "too many SQL variables" in production.
const NOTIFICATIONS_INSERT_CHUNK = 8;

type DbClient = ReturnType<typeof getDb>;

export type NotificationInput = {
  recipientId: string;
  actorId: string | null;
  type: string;
  tone?: NotificationTone;
  title: string;
  body?: string | null;
  href: string;
  entityType: string;
  entityId: string;
};

function toNotificationRow(input: NotificationInput) {
  return {
    id: crypto.randomUUID(),
    recipientId: input.recipientId,
    actorId: input.actorId ?? null,
    type: input.type,
    tone: input.tone ?? ("default" as NotificationTone),
    title: input.title,
    body: input.body ?? null,
    href: input.href,
    entityType: input.entityType,
    entityId: input.entityId,
    readAt: null,
    createdAt: new Date(),
  };
}

// Never notify a user about their own action.
function isSelf(input: NotificationInput) {
  return Boolean(input.actorId) && input.actorId === input.recipientId;
}

export async function createNotification(db: DbClient, input: NotificationInput) {
  if (isSelf(input)) return;
  await db.insert(notifications).values(toNotificationRow(input));
}

export async function createNotifications(
  db: DbClient,
  inputs: NotificationInput[],
) {
  const rows = inputs.filter((input) => !isSelf(input)).map(toNotificationRow);
  if (!rows.length) return;
  for (const batch of chunk(rows, NOTIFICATIONS_INSERT_CHUNK)) {
    await db.insert(notifications).values(batch);
  }
}
