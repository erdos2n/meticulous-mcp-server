#!/usr/bin/env node

/**
 * Meticulous Espresso MCP Server — stdio entry point
 *
 * Used by Claude Desktop and Claude Code on your laptop.
 * All shared tools and logic live in server.ts.
 *
 * Environment variables (can be set via .env file):
 *   METICULOUS_IP  - IP of your Meticulous machine on your local network (required)
 */

import 'dotenv/config';
import { server } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
