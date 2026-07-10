// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// AES-GCM secret encryption for VCS provider tokens/webhook secrets. Web
// Crypto is portable across Cloudflare Workers and Node 24, so this file has
// no runtime-specific branches (unlike lib/db/index.ts). Stored as
// `v<keyVersion>:<ivBase64>:<ciphertextBase64>` — the version prefix lets us
// route to a different key once VCS_ENCRYPTION_KEY is rotated (not needed yet;
// only one key exists today).
import { serverEnv } from "@/lib/env";

const KEY_VERSION = 1;
let keyPromise: Promise<CryptoKey> | null = null;

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const raw = fromB64(serverEnv.vcsEncryptionKey); // add to serverEnv (0.2)
    if (raw.length !== 32) throw new Error("VCS_ENCRYPTION_KEY must decode to 32 bytes");
    keyPromise = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
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
