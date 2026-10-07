// The package import selects the Node driver for self-hosting; next.config.ts
// pins Cloudflare builds to the D1 driver. Both are checked by TypeScript.
export { getDb } from "#db-runtime";
