// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// AES-GCM secret encryption for VCS provider tokens/webhook secrets. Web
// Crypto (encrypt/decrypt) is portable across Cloudflare Workers and Node 24.
// Stored as `v<keyVersion>:<ivBase64>:<ciphertextBase64>` — the version prefix
// lets us route to a different key once VCS_ENCRYPTION_KEY is rotated (not
// needed yet; only one key exists today).
import { serverEnv } from "@/lib/env";

const KEY_VERSION = 1;
let keyPromise: Promise<CryptoKey> | null = null;

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Resolve the raw key material at call time, mirroring getDb()'s binding
// resolution (lib/db/index.ts): serverEnv reads process.env at module load,
// which is populated in production (wrangler secrets) and RUNTIME=node, but NOT
// under local `next dev` — there `.dev.vars` only reaches the Cloudflare
// context, not process.env. So fall back to getCloudflareContext().env, guarded
// exactly like getDb so the node runtime (where the call throws) never hits it.
async function resolveRawKey(): Promise<string> {
  if (serverEnv.vcsEncryptionKey) return serverEnv.vcsEncryptionKey;
  if (process.env.RUNTIME !== "node") {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const value = getCloudflareContext().env.VCS_ENCRYPTION_KEY;
      if (typeof value === "string" && value) return value;
    } catch {
      // Off-Workers (e.g. vitest) with no Cloudflare context — fall through.
    }
  }
  return "";
}

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = resolveRawKey().then((rawKey) => {
      const raw = fromB64(rawKey);
      if (raw.length !== 32) {
        keyPromise = null; // don't cache a failed resolution; retry next call
        throw new Error("VCS_ENCRYPTION_KEY must decode to 32 bytes");
      }
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    });
  }
  return keyPromise;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh per record
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return `v${KEY_VERSION}:${b64(iv)}:${b64(ct)}`;
}

export async function decryptSecret(stored: string): Promise<string> {
  const [, ivB64, ctB64] = stored.split(":"); // keyVersion routing when >1 key exists
  const key = await getKey();
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, fromB64(ctB64));
  return new TextDecoder().decode(pt);
}
