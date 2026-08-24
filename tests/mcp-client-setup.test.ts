import { describe, expect, it } from "vitest";

import {
  MCP_CLIENTS,
  buildMcpClientSetup,
  seederMcpEndpoint,
} from "@/lib/mcp-client-setup";

describe("Seeder MCP client setup", () => {
  it("normalizes the Seeder origin", () => {
    expect(seederMcpEndpoint("https://pm.example.com/")).toBe(
      "https://pm.example.com/api/mcp",
    );
  });

  it("generates a setup for every supported client", () => {
    const setups = MCP_CLIENTS.map(({ id }) =>
      buildMcpClientSetup(id, "https://pm.example.com"),
    );

    expect(setups).toHaveLength(4);
    for (const setup of setups) {
      expect(setup.snippet).toContain("https://pm.example.com/api/mcp");
      expect(setup.snippet).toContain("seeder-pm");
      expect(setup.snippet).toContain("SEEDER_PAT");
      expect(setup.verify).toBeTruthy();
    }
  });

  it("uses each client's native remote MCP format", () => {
    const origin = "https://pm.example.com";

    expect(buildMcpClientSetup("claude", origin).snippet).toContain(
      "--transport http",
    );
    expect(buildMcpClientSetup("codex", origin).snippet).toContain(
      "--bearer-token-env-var SEEDER_PAT",
    );
    expect(buildMcpClientSetup("cursor", origin).snippet).toContain(
      '"Authorization": "Bearer ${env:SEEDER_PAT}"',
    );
    expect(buildMcpClientSetup("gemini", origin).snippet).toContain(
      '--header "Authorization: Bearer $SEEDER_PAT"',
    );
  });
});
