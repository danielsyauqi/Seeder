import { z } from "zod";

const optionalString = (value: string | undefined) => {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
};

// RUNTIME selects the deployment runtime: "node" (self-hosted Node server + local
// SQLite) or unset/"cloudflare" (Cloudflare Workers). Fail fast on a typo so a
// mis-set value surfaces at boot rather than as a confusing off-Workers
// getCloudflareContext() error on the first request.
const runtimeValue = optionalString(process.env.RUNTIME);
if (runtimeValue && runtimeValue !== "node" && runtimeValue !== "cloudflare") {
  throw new Error(
    `Invalid RUNTIME="${runtimeValue}". Use "node" for the self-hosted Node ` +
      `runtime, or leave it unset (or "cloudflare") for Cloudflare Workers.`,
  );
}

const ownerEmailValue = optionalString(process.env.OWNER_EMAIL);
const parsedOwnerEmail = ownerEmailValue
  ? z.string().email().safeParse(ownerEmailValue.toLowerCase())
  : null;

const googleClientId = optionalString(process.env.GOOGLE_CLIENT_ID);
const googleClientSecret = optionalString(process.env.GOOGLE_CLIENT_SECRET);

const DEFAULT_BETTER_AUTH_SECRET = "change-me-in-production";

const betterAuthSecret =
  optionalString(process.env.BETTER_AUTH_SECRET) ?? DEFAULT_BETTER_AUTH_SECRET;
const betterAuthUrl = optionalString(process.env.BETTER_AUTH_URL);

// Base64 of 32 random bytes, used to AES-GCM encrypt VCS provider PATs and
// webhook secrets at rest (see lib/crypto/secrets.ts). Generate with
// `openssl rand -base64 32` and set via `wrangler secret put VCS_ENCRYPTION_KEY`.
const vcsEncryptionKeyValue = optionalString(process.env.VCS_ENCRYPTION_KEY);

// Comma-separated allowed Origin values for the MCP endpoint (DNS-rebinding
// protection). Empty = unconfigured → allowed (token auth still required);
// set this in production to your AI clients' origins.
const mcpAllowedOriginsValue = optionalString(process.env.MCP_ALLOWED_ORIGINS);

// Extra Origins allowed to make auth requests (the CSRF allow-list), on top of
// BETTER_AUTH_URL + localhost. Comma-separated. Use this when the app is reachable
// at more than one hostname — e.g. both the *.workers.dev URL and a custom domain.
// BETTER_AUTH_URL stays the single canonical base (OAuth callbacks, links); these
// only widen which Origins are accepted.
const extraTrustedOriginsValue = optionalString(
  process.env.BETTER_AUTH_TRUSTED_ORIGINS,
);

// Fail closed: the default secret is published in this repo, so signing Better
// Auth cookies with it in production would let anyone forge sessions.
// BETTER_AUTH_URL is required in production and is unset both locally and at
// build time, so its presence is our "this is a real deployment" signal.
if (betterAuthUrl && betterAuthSecret === DEFAULT_BETTER_AUTH_SECRET) {
  throw new Error(
    "BETTER_AUTH_SECRET must be set to a strong, unique value in production " +
      "(it is unset or still the example default). Generate one with " +
      "`openssl rand -base64 32` and set it via `wrangler secret put BETTER_AUTH_SECRET`.",
  );
}

// Same fail-closed signal as BETTER_AUTH_SECRET above: BETTER_AUTH_URL set
// means "this is a real deployment". Locally VCS_ENCRYPTION_KEY may stay unset
// until the VCS feature is used — lib/crypto/secrets.ts throws on first use as
// the safety net in that case.
if (betterAuthUrl && !vcsEncryptionKeyValue) {
  throw new Error(
    "VCS_ENCRYPTION_KEY must be set in production (it is unset). Generate one " +
      "with `openssl rand -base64 32` and set it via " +
      "`wrangler secret put VCS_ENCRYPTION_KEY`.",
  );
}

export const serverEnv = {
  betterAuthSecret,
  betterAuthUrl,
  ownerEmail: parsedOwnerEmail?.success
    ? parsedOwnerEmail.data
    : "admin@admin.com",
  googleClientId,
  googleClientSecret,
  hasGoogleAuth: Boolean(googleClientId && googleClientSecret),
  mcpAllowedOrigins: mcpAllowedOriginsValue
    ? mcpAllowedOriginsValue
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [],
  vcsEncryptionKey: vcsEncryptionKeyValue ?? "",
};

export const authTrustedOrigins = Array.from(
  new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...(serverEnv.betterAuthUrl ? [serverEnv.betterAuthUrl] : []),
    ...(extraTrustedOriginsValue
      ? extraTrustedOriginsValue
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  ]),
);
