// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// VCS Sync webhook receiver (spec §1.4). Order is load-bearing: cheap
// header/id checks -> raw body -> load connection (+ provider match) ->
// decrypt secret -> adapter.verify (HMAC/token) -> delivery dedup -> parse
// (skip nulls with 202) -> ingest (best-effort; never 500s the forge) -> 202.
//
// Never prerendered/cached (reads headers + a raw body every request), and
// route params are async per the repo's route-handler convention.
import { decryptSecret } from "@/lib/crypto/secrets";
import { getDb } from "@/lib/db";
import { ADAPTERS } from "@/lib/services/vcs/adapters";
import { VCS_BOT_USER_ID } from "@/lib/services/vcs/constants";
import {
  ingest,
  insertDeliveryOrIgnore,
  isUuid,
  loadConnectionById,
} from "@/lib/services/vcs";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ provider: string; connectionId: string }> };

export async function POST(request: Request, context: Ctx) {
  const { provider, connectionId } = await context.params;
  const adapter = ADAPTERS[provider as keyof typeof ADAPTERS];
  if (!adapter || !isUuid(connectionId)) {
    return new Response(null, { status: 404 });
  }

  const headerSig = request.headers.get(adapter.sigHeader);
  const deliveryId = request.headers.get(adapter.deliveryHeader);
  if (!headerSig || !deliveryId) {
    return new Response(null, { status: 400 });
  }

  // Raw bytes BEFORE any parsing — HMAC/token verification must run over the
  // exact wire bytes, never a re-serialized JSON.parse(...) round-trip.
  const raw = await request.text();
  const db = getDb();

  const conn = await loadConnectionById(db, connectionId);
  if (!conn || conn.provider !== provider) {
    return new Response(null, { status: 404 });
  }

  const secret = await decryptSecret(conn.webhookSecretEnc);
  if (!(await adapter.verify(raw, secret, headerSig))) {
    return new Response(null, { status: 401 });
  }

  const fresh = await insertDeliveryOrIgnore(db, deliveryId, connectionId);
  if (!fresh) {
    return new Response("duplicate", { status: 202 });
  }

  try {
    const envelope = adapter.parse(request.headers, raw);
    if (envelope) {
      await ingest(
        db,
        { kind: "system", botUserId: VCS_BOT_USER_ID, projectId: conn.projectId },
        conn,
        envelope,
      );
    }
    // envelope === null: nothing for Seeder to ingest (e.g. a tag
    // create/delete, or an unrelated event) — still ack 202, not an error.
  } catch (error) {
    console.error("vcs ingest failed", error); // don't 500 the forge into disabling us
  }

  return new Response("ok", { status: 202 });
}
