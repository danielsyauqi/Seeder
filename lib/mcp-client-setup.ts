export type McpClientId = "claude" | "codex" | "cursor" | "gemini";

export const MCP_CLIENTS: { id: McpClientId; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "gemini", label: "Gemini" },
];

export type McpClientSetup = {
  label: string;
  destination: string;
  snippet: string;
  verify: string;
  note: string;
};

export function seederMcpEndpoint(origin: string) {
  return `${origin.replace(/\/$/, "")}/api/mcp`;
}

export function buildMcpClientSetup(
  client: McpClientId,
  origin: string,
): McpClientSetup {
  const endpoint = seederMcpEndpoint(origin);

  switch (client) {
    case "claude":
      return {
        label: "User-scoped CLI command",
        destination: "Claude Code",
        snippet: [
          "claude mcp add \\",
          "  --scope user \\",
          "  --transport http \\",
          "  --header 'Authorization: Bearer ${SEEDER_PAT}' \\",
          `  seeder-pm ${endpoint}`,
        ].join("\n"),
        verify: "claude mcp list",
        note: "Claude expands SEEDER_PAT when it connects, so the token stays out of its MCP configuration.",
      };

    case "codex":
      return {
        label: "User-scoped CLI command",
        destination: "Codex CLI, IDE, and desktop",
        snippet: [
          "codex mcp add seeder-pm \\",
          `  --url ${endpoint} \\`,
          "  --bearer-token-env-var SEEDER_PAT",
        ].join("\n"),
        verify: "codex mcp list",
        note: "Codex stores only the SEEDER_PAT variable name and shares this MCP configuration across its local clients.",
      };

    case "cursor":
      return {
        label: "Global MCP configuration",
        destination: "~/.cursor/mcp.json",
        snippet: JSON.stringify(
          {
            mcpServers: {
              "seeder-pm": {
                url: endpoint,
                headers: {
                  Authorization: "Bearer ${env:SEEDER_PAT}",
                },
              },
            },
          },
          null,
          2,
        ),
        verify: "Cursor → Customize → MCP → seeder-pm",
        note: "Restart Cursor after SEEDER_PAT is available to the app. Merge this entry if the file already contains other servers.",
      };

    case "gemini":
      return {
        label: "User-scoped CLI command",
        destination: "Gemini CLI",
        snippet: [
          "gemini mcp add \\",
          "  --scope user \\",
          "  --transport http \\",
          "  --header \"Authorization: Bearer $SEEDER_PAT\" \\",
          `  seeder-pm ${endpoint}`,
        ].join("\n"),
        verify: "gemini mcp list",
        note: "Gemini resolves SEEDER_PAT when this command runs and stores the resulting authorization header in its user settings.",
      };
  }
}
