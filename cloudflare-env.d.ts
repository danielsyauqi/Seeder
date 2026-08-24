declare global {
  interface CloudflareEnv {
    PM_DB: D1Database;
    UPLOADS: R2Bucket;
    // Secret (wrangler secret put / .dev.vars). Read via getCloudflareContext()
    // in lib/crypto/secrets.ts when it isn't present in process.env.
    VCS_ENCRYPTION_KEY?: string;
  }
}

export {};
