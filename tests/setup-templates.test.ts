import { describe, expect, it } from "vitest";

import {
  caddyfile,
  dockerCompose,
  dockerfile,
  type NodeEnv,
  pm2Ecosystem,
  runbook,
  systemdUnit,
} from "@/scripts/setup-templates";

const env: NodeEnv = {
  RUNTIME: "node",
  NODE_ENV: "production",
  PORT: "4000",
  HOSTNAME: "127.0.0.1",
  BETTER_AUTH_URL: "https://seeder.example.com",
  BETTER_AUTH_SECRET: "s3cr3t-value",
  VCS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  OWNER_EMAIL: "owner@example.com",
  SQLITE_DB_PATH: "./data/seeder.db",
  UPLOADS_DIR: "./data/uploads",
};

// The single-writer invariant is the load-bearing safety property across every
// process-manager artifact — these tests fail loudly if a future edit enables
// clustering / replicas.
describe("pm2Ecosystem", () => {
  const out = pm2Ecosystem(env);

  it("is valid, single-instance fork-mode config carrying the env", () => {
    expect(out).toContain('exec_mode: "fork"');
    expect(out).toContain("instances: 1");
    expect(out).toContain('"RUNTIME": "node"');
    expect(out).toContain('"PORT": "4000"');
    expect(out).toContain("s3cr3t-value"); // secret embedded → must be gitignored
    expect(out).toContain("kill_timeout: 30000");
  });

  it("evaluates to a real module with one app", () => {
    const mod = { exports: {} as { apps?: Array<Record<string, unknown>> } };
    new Function("module", "__dirname", out)(mod, "/srv/seeder");
    expect(mod.exports.apps).toHaveLength(1);
    expect(mod.exports.apps?.[0].exec_mode).toBe("fork");
    expect(mod.exports.apps?.[0].instances).toBe(1);
    expect(mod.exports.apps?.[0].env).toMatchObject({
      VCS_ENCRYPTION_KEY: env.VCS_ENCRYPTION_KEY,
    });
  });
});

describe("systemdUnit", () => {
  const out = systemdUnit({ ...env, root: "/srv/seeder" });
  it("reads secrets from .env and drains on SIGINT", () => {
    expect(out).toContain("EnvironmentFile=/srv/seeder/.env");
    expect(out).toContain("KillSignal=SIGINT");
    expect(out).toContain("TimeoutStopSec=30");
    expect(out).toContain("WorkingDirectory=/srv/seeder");
    expect(out).not.toContain("s3cr3t-value"); // secret stays in .env, not the unit
  });
});

describe("docker artifacts", () => {
  it("Dockerfile migrates then starts", () => {
    const out = dockerfile();
    expect(out).toContain("npm run build:node");
    expect(out).toContain("db:migrate:node");
    expect(out).toContain("start:node");
  });
  it("compose has a single service with a persistent volume", () => {
    const out = dockerCompose(env);
    expect(out).toContain("seeder-data:/data");
    expect(out).toContain("127.0.0.1:4000:3000");
    expect(out).not.toMatch(/replicas:\s*\d/); // no scaling directive
    expect(out).toContain("stop_grace_period: 30s");
  });
});

describe("caddyfile", () => {
  it("extracts the host and proxies to the local port", () => {
    const out = caddyfile("https://seeder.example.com", "4000");
    expect(out).toContain("seeder.example.com {");
    expect(out).toContain("reverse_proxy 127.0.0.1:4000");
  });
});

describe("runbook", () => {
  it("warns about single-writer and tailors the start command", () => {
    const pm2 = runbook({ ...env, pmChoice: "1" });
    expect(pm2).toContain("Single instance only");
    expect(pm2).toContain("pm2 start ecosystem.config.cjs");
    expect(pm2).toContain("./data/seeder.db");

    const none = runbook({ ...env, pmChoice: "4" });
    expect(none).toContain("npm run start:node");
  });
});
