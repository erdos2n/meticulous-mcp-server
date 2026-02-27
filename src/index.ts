#!/usr/bin/env node

/**
 * Meticulous Espresso MCP Server — stdio entry point
 *
 * Used with Claude Desktop and Claude Code on your local machine.
 * All shared logic lives in server.ts.
 *
 * Environment variables:
 *   METICULOUS_IP  - IP of your Meticulous machine on your local network (required)
 */

import { createServer, METICULOUS_IP } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Meticulous MCP server started — connected to machine at ${METICULOUS_IP}`);
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
