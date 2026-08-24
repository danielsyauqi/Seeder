import { beforeAll, describe, expect, it } from "vitest";

// lib/env.ts reads process.env.VCS_ENCRYPTION_KEY at import time, so it must be
// set before lib/crypto/secrets.ts (and its lib/env.ts import) is first
// evaluated. A dynamic import inside beforeAll keeps this file free of a
// vitest.config.ts env change that would leak into unrelated tests.
let encryptSecret: typeof import("@/lib/crypto/secrets").encryptSecret;
let decryptSecret: typeof import("@/lib/crypto/secrets").decryptSecret;

beforeAll(async () => {
  process.env.VCS_ENCRYPTION_KEY = "E0qJM8RYDT8w9ZQBBfnCP2ieDKJ4DHuiw16XEXHgZTE=";
  const mod = await import("@/lib/crypto/secrets");
  encryptSecret = mod.encryptSecret;
  decryptSecret = mod.decryptSecret;
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips plaintext", async () => {
    const stored = await encryptSecret("ghp_super-secret-token");
    expect(await decryptSecret(stored)).toBe("ghp_super-secret-token");
  });

  it("stores as v<version>:<iv>:<ciphertext>", async () => {
    const stored = await encryptSecret("hello world");
    const parts = stored.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
  });

  it("produces different ciphertext for the same input (fresh IV per call)", async () => {
    const a = await encryptSecret("same input");
    const b = await encryptSecret("same input");
    expect(a).not.toBe(b);
    expect(await decryptSecret(a)).toBe("same input");
    expect(await decryptSecret(b)).toBe("same input");
  });

  it("throws on tampered ciphertext", async () => {
    const stored = await encryptSecret("tamper me");
    const [version, iv, ct] = stored.split(":");
    // Flip a character in the base64 ciphertext to corrupt the GCM auth tag.
    const flipped = ct[0] === "A" ? "B" : "A";
    const tampered = `${version}:${iv}:${flipped}${ct.slice(1)}`;
    await expect(decryptSecret(tampered)).rejects.toThrow();
  });

  it("throws when decrypted with the wrong key", async () => {
    const stored = await encryptSecret("wrong key test");

    // Import a second instance of the module under a different key. Vitest's
    // module registry is per-file, so we reach into a fresh dynamic import via
    // vi.resetModules to force re-evaluation with a new env value.
    const { vi } = await import("vitest");
    vi.resetModules();
    process.env.VCS_ENCRYPTION_KEY = "l41ZzjD9E/IEAw0VCR+bJ3S8guASNpTclGRuSAmE6q0=";
    const other = await import("@/lib/crypto/secrets");
    await expect(other.decryptSecret(stored)).rejects.toThrow();

    // Restore for any subsequent tests in this file.
    process.env.VCS_ENCRYPTION_KEY = "E0qJM8RYDT8w9ZQBBfnCP2ieDKJ4DHuiw16XEXHgZTE=";
  });
});
