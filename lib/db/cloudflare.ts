import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle } from "drizzle-orm/d1";
import { cache } from "react";

import * as schema from "@/lib/db/schema";

export const getDb = cache(() => {
  const { env } = getCloudflareContext();
  return drizzle(env.PM_DB, { schema });
});
