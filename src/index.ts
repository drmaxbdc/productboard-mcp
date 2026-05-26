#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { setAuthResolution } from "./api/client.js";
import { createAuthResolution } from "./auth/resolver.js";

async function main(): Promise<void> {
  // Initialize auth BEFORE creating the MCP server so the resolver's startup
  // validation (env var sanity, etc.) is the first thing that runs. OAuth
  // setup, if needed, kicks off in the background and does NOT block here.
  try {
    setAuthResolution(createAuthResolution());
  } catch (err: unknown) {
    process.stderr.write(`[productboard-mcp] Startup failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[productboard-mcp] Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
