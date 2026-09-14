/**
 * Interactive setup wizard for Seeder. Run with `npm run setup`.
 *
 * Picks one of three deployment modes and configures it end to end:
 *   1. dev (local)          — Miniflare/workerd, `next dev --webpack`
 *   2. production (node)     — standalone Node server (next start) on a local
 *                             SQLite file + local-disk uploads, no Cloudflare
 *   3. production (cloudflare) — OpenNext -> Cloudflare Workers (D1 + R2)
 *
 * Most prompts accept Enter for the shown default; genuinely-required fields
 * (e.g. the production app URL) loop until answered. BETTER_AUTH_SECRET is
 * always auto-generated, never prompted. SQLite means there are no DB
 * host/port/user/password prompts.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  applyD1Id,
  extractD1Id,
  generateSecret,
  isEmail,
  isUrl,
  renderEnv,
} from "./setup-lib";
import {
  caddyfile,
  dockerCompose,
  dockerfile,
  pm2Ecosystem,
  runbook,
  systemdUnit,
} from "./setup-templates";

const rl = createInterface({ input: stdin, output: stdout });
const ROOT = process.cwd();

// ---------------------------------------------------------------- prompt utils

async function ask(question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function askRequired(
  question: string,
  validate?: (value: string) => string | null,
): Promise<string> {
  for (;;) {
    const answer = (await rl.question(`${question}: `)).trim();
    if (!answer) {
      console.log("  ↳ required — please enter a value.");
      continue;
    }
    const error = validate?.(answer);
    if (error) {
      console.log(`  ↳ ${error}`);
      continue;
    }
    return answer;
  }
}

async function askValidated(
  question: string,
  fallback: string,
  validate: (value: string) => string | null,
): Promise<string> {
  for (;;) {
    const answer = await ask(question, fallback);
    const error = validate(answer);
    if (error) {
      console.log(`  ↳ ${error}`);
      continue;
    }
    return answer;
  }
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

// --------------------------------------------------------------- file + shell

function writeEnvFile(file: string, vars: Record<string, string | undefined>) {
  writeFileSync(path.join(ROOT, file), renderEnv(vars), "utf8");
  console.log(`  ✓ wrote ${file}`);
}

function writeArtifact(file: string, contents: string, mode?: number) {
  const target = path.join(ROOT, file);
  writeFileSync(target, contents, "utf8");
  if (mode !== undefined) chmodSync(target, mode);
  console.log(`  ✓ generated ${file}`);
}

function run(command: string, args: string[], opts: { capture?: boolean } = {}): string {
  console.log(`  $ ${command} ${args.join(" ")}`);
  if (opts.capture) {
    return execFileSync(command, args, { cwd: ROOT, encoding: "utf8" });
  }
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
  return "";
}

async function maybeRun(label: string, command: string, args: string[]): Promise<boolean> {
  if (!(await confirm(`Run now: ${label}?`))) {
    console.log(`  ↷ skipped — run it later with:  ${command} ${args.join(" ")}`);
    return false;
  }
  try {
    run(command, args);
    return true;
  } catch {
    console.log(`  ✗ command failed. You can re-run it manually:  ${command} ${args.join(" ")}`);
    return false;
  }
}

/**
 * A `.env` with RUNTIME=node from a prior "production (node)" setup is loaded by
 * Next automatically, which would silently force node mode in dev/cloudflare.
 * Detect and offer to remove it before configuring a non-node mode.
 */
async function warnStaleNodeEnv(modeLabel: string) {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return;
  if (!/^\s*RUNTIME\s*=\s*node\b/m.test(readFileSync(file, "utf8"))) return;

  console.log(
    `\n⚠️  A .env with RUNTIME=node exists from a previous "production (node)" setup.` +
      `\n   Next loads .env automatically, so it would force node mode in ${modeLabel}.`,
  );
  if (await confirm("Remove the stale .env now?")) {
    rmSync(file);
    console.log("  ✓ removed .env");
  } else {
    console.log("  ↳ left in place — delete .env manually if the app misbehaves.");
  }
}

async function collectOptionalIntegrations(): Promise<Record<string, string | undefined>> {
  const vars: Record<string, string | undefined> = {};
  if (await confirm("Enable Google sign-in (set GOOGLE_CLIENT_ID/SECRET)?", false)) {
    vars.GOOGLE_CLIENT_ID = await askRequired("  Google client ID");
    vars.GOOGLE_CLIENT_SECRET = await askRequired("  Google client secret");
  }
  const mcp = await ask(
    "Restrict MCP origins (MCP_ALLOWED_ORIGINS, comma-separated) — optional",
  );
  if (mcp) vars.MCP_ALLOWED_ORIGINS = mcp;
  return vars;
}

// ------------------------------------------------------------------- mode: dev

async function setupDev() {
  console.log("\n── dev (local) ─ Miniflare; data lives under .wrangler/state ──\n");
  await warnStaleNodeEnv("dev mode");
  const ownerEmail = await askValidated(
    "Owner email (first-account email)",
    "admin@admin.com",
    isEmail,
  );
  const integrations = await collectOptionalIntegrations();

  writeEnvFile(".dev.vars", {
    NEXTJS_ENV: "development",
    OWNER_EMAIL: ownerEmail,
    BETTER_AUTH_SECRET: generateSecret(),
    VCS_ENCRYPTION_KEY: generateSecret(),
    ...integrations,
  });

  if (!existsSync(path.join(ROOT, "node_modules"))) {
    await maybeRun("install dependencies", "npm", ["install"]);
  }
  await maybeRun("apply local migrations", "npm", ["run", "db:migrate:local"]);

  console.log("\n✅ Dev mode ready.");
  console.log("   Start the app:   npm run dev   (uses --webpack)");
  console.log("   Then open http://localhost:3000/sign-in to create the owner account.");
}

// -------------------------------------------------------------- mode: node

async function setupNode() {
  console.log("\n── production (node) ─ standalone Node server + local SQLite ──\n");
  const appUrl = await askRequired("Public app URL (BETTER_AUTH_URL)", isUrl);
  const ownerEmail = await askValidated("Owner email", "admin@admin.com", isEmail);
  const dbPath = await ask("SQLite database path", "./data/seeder.db");
  const uploadsDir = await ask("Uploads directory", "./data/uploads");
  const port = await ask("Port", "3000");
  const integrations = await collectOptionalIntegrations();

  console.log("\nProcess manager (keeps the server running / restarts on crash):");
  console.log("  1) pm2 (recommended)   2) systemd   3) docker   4) none");
  const pmChoice = await ask("Choose", "1");

  const secret = generateSecret();
  const vcsEncryptionKey = generateSecret();
  writeEnvFile(".env", {
    RUNTIME: "node",
    OWNER_EMAIL: ownerEmail,
    BETTER_AUTH_SECRET: secret,
    VCS_ENCRYPTION_KEY: vcsEncryptionKey,
    BETTER_AUTH_URL: appUrl,
    SQLITE_DB_PATH: dbPath,
    UPLOADS_DIR: uploadsDir,
    ...integrations,
  });

  // Ensure data + log directories exist before first migrate/start.
  mkdirSync(path.join(ROOT, path.dirname(dbPath)), { recursive: true });
  mkdirSync(path.join(ROOT, uploadsDir), { recursive: true });
  mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  console.log("  ✓ created data/ + logs/ directories");

  if (!existsSync(path.join(ROOT, "node_modules"))) {
    await maybeRun("install dependencies", "npm", ["install"]);
  }
  await maybeRun("apply migrations to the SQLite file", "npm", ["run", "db:migrate:node"]);

  const env = {
    RUNTIME: "node",
    NODE_ENV: "production",
    PORT: port,
    HOSTNAME: "127.0.0.1",
    BETTER_AUTH_URL: appUrl,
    BETTER_AUTH_SECRET: secret,
    VCS_ENCRYPTION_KEY: vcsEncryptionKey,
    OWNER_EMAIL: ownerEmail,
    SQLITE_DB_PATH: dbPath,
    UPLOADS_DIR: uploadsDir,
  };

  // Generate the chosen process-manager artifact (+ proxy snippet + runbook).
  if (pmChoice === "1") {
    writeArtifact("ecosystem.config.cjs", pm2Ecosystem(env));
  } else if (pmChoice === "2") {
    writeArtifact("seeder.service", systemdUnit({ ...env, root: ROOT }));
  } else if (pmChoice === "3") {
    writeArtifact("Dockerfile", dockerfile());
    writeArtifact("docker-compose.yml", dockerCompose(env));
  }
  writeArtifact("Caddyfile", caddyfile(appUrl, port));
  writeArtifact("DEPLOY-node.md", runbook({ ...env, pmChoice }));

  await maybeRun("build the production bundle", "npm", ["run", "build:node"]);

  console.log("\n✅ Node mode configured.");
  if (pmChoice === "1") {
    console.log("   Start under PM2:");
    console.log("     pm2 start ecosystem.config.cjs && pm2 save");
    console.log("     pm2 startup   # prints the boot-persistence command to run with sudo");
  } else if (pmChoice === "2") {
    console.log("   Install the service (review seeder.service first):");
    console.log("     sudo cp seeder.service /etc/systemd/system/");
    console.log("     sudo systemctl enable --now seeder");
  } else if (pmChoice === "3") {
    console.log("   Build & run the container:  docker compose up -d --build");
  } else {
    console.log("   Start the server:  npm run start:node");
  }
  console.log("   Front it with TLS using the generated Caddyfile, then open " + appUrl + "/sign-in.");
  console.log("   Full runbook: DEPLOY-node.md");
}

// ------------------------------------------------------------ mode: cloudflare

function writeD1Id(databaseId: string) {
  const file = path.join(ROOT, "wrangler.jsonc");
  const { content, changed } = applyD1Id(readFileSync(file, "utf8"), databaseId);
  if (!changed) {
    console.log("  ↳ wrangler.jsonc already has a database_id — left unchanged.");
    return;
  }
  writeFileSync(file, content, "utf8");
  console.log("  ✓ wrote database_id into wrangler.jsonc");
}

async function setupCloudflare() {
  console.log("\n── production (cloudflare) ─ OpenNext → Workers (D1 + R2) ──\n");
  console.log("Requires a Cloudflare account; run `npx wrangler login` first if you haven't.\n");
  await warnStaleNodeEnv("cloudflare mode");
  const appUrl = await askRequired("Public app URL (BETTER_AUTH_URL)", isUrl);
  const ownerEmail = await askValidated("Owner email", "admin@admin.com", isEmail);
  const integrations = await collectOptionalIntegrations();
  const secret = generateSecret();

  if (!existsSync(path.join(ROOT, "node_modules"))) {
    await maybeRun("install dependencies", "npm", ["install"]);
  }

  // Create D1 and capture its id into wrangler.jsonc.
  if (await confirm("Create the D1 database now (npx wrangler d1 create seeder)?")) {
    try {
      const out = run("npx", ["wrangler", "d1", "create", "seeder"], { capture: true });
      console.log(out);
      const id = extractD1Id(out);
      if (id) {
        writeD1Id(id);
      } else {
        console.log("  ↳ couldn't auto-detect the database_id — paste it into wrangler.jsonc manually.");
      }
    } catch {
      console.log("  ✗ d1 create failed (are you logged in?). Run it manually, then paste the id into wrangler.jsonc.");
    }
  }

  await maybeRun("create the R2 uploads bucket", "npx", [
    "wrangler", "r2", "bucket", "create", "seeder-uploads",
  ]);

  // Secrets / runtime config — never committed to the repo.
  if (await confirm("Set Worker secrets (BETTER_AUTH_SECRET/URL, VCS_ENCRYPTION_KEY, OWNER_EMAIL) now?")) {
    const putSecret = (name: string, value: string) => {
      console.log(`  $ npx wrangler secret put ${name}`);
      execFileSync("npx", ["wrangler", "secret", "put", name], {
        cwd: ROOT,
        input: value,
        stdio: ["pipe", "inherit", "inherit"],
      });
    };
    try {
      putSecret("BETTER_AUTH_SECRET", secret);
      putSecret("VCS_ENCRYPTION_KEY", generateSecret());
      putSecret("BETTER_AUTH_URL", appUrl);
      putSecret("OWNER_EMAIL", ownerEmail);
      for (const [name, value] of Object.entries(integrations)) {
        if (value) putSecret(name, value);
      }
    } catch {
      console.log("  ✗ setting secrets failed — set them manually with `npx wrangler secret put <NAME>`.");
    }
  }

  await maybeRun("apply remote migrations", "npm", ["run", "db:migrate:remote"]);
  await maybeRun("build & deploy to Cloudflare", "npm", ["run", "deploy"]);

  console.log("\n✅ Cloudflare mode configured.");
  console.log(`   Create the first owner at ${appUrl}/sign-in (one-time, only accepts ${ownerEmail}).`);
}

// -------------------------------------------------------------------- main

async function main() {
  console.log("\n🌱  Seeder setup\n");
  console.log("Choose deployment mode:");
  console.log("  1) dev (local)            — local development (Miniflare)");
  console.log("  2) production (node)      — self-host on a VM (Node + SQLite, no Cloudflare)");
  console.log("  3) production (cloudflare) — deploy to Cloudflare Workers (D1 + R2)\n");

  const mode = await ask("Mode (1/2/3)");
  switch (mode) {
    case "1":
      await setupDev();
      break;
    case "2":
      await setupNode();
      break;
    case "3":
      await setupCloudflare();
      break;
    default:
      console.log("Unknown mode — please run `npm run setup` again and pick 1, 2, or 3.");
  }
}

main()
  .catch((error) => {
    console.error("\nSetup failed:", error);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
