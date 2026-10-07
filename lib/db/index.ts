// The package import defaults to D1. Next aliases it to the Node driver for
// self-hosting, leaving Cloudflare builds free of native libSQL dependencies.
export { getDb } from "#db-runtime";
