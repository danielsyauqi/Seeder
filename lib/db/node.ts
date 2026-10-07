import { drizzle } from "drizzle-orm/libsql";
import path from "node:path";
import { cache } from "react";

import * as schema from "@/lib/db/schema";

let nodeDb: ReturnType<typeof drizzle> | undefined;

export const getDb = cache(() => {
  if (!nodeDb) {
    const file = path.resolve(process.env.SQLITE_DB_PATH ?? "./data/seeder.db");
    nodeDb = drizzle({ connection: { url: `file:${file}` }, schema });
  }
  return nodeDb;
});
