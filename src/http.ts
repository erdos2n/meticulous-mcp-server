#!/usr/bin/env node

/**
 * Meticulous Espresso MCP Server — HTTP entry point
 *
 * Used by Claude mobile / claude.ai via a Raspberry Pi + Cloudflare Tunnel.
 * All shared tools and logic live in server.ts.
 *
 * Environment variables (can be set via .env file):
 *   METICULOUS_IP   - IP of your Meticulous machine on your local network (required)
 *   MCP_AUTH_TOKEN  - Bearer token for authenticating HTTP requests (required)
 *   PORT            - Port to listen on (default: 3000)
 */

import 'dotenv/config';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { server, METICULOUS_IP } from './server.js';

// Require auth token
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!AUTH_TOKEN) {
  console.error('ERROR: MCP_AUTH_TOKEN environment variable is required.');
  console.error('Generate one with: npm run generate-token');
  process.exit(1);
}

const app = express();
app.use(express.json());

// Bearer token auth middleware
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// MCP endpoint — Streamable HTTP (POST for requests, GET for SSE)
app.post('/mcp', requireAuth, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', requireAuth, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

// Health check — no auth required (used by Cloudflare and monitoring)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', machine: METICULOUS_IP });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`Meticulous MCP HTTP server running on port ${PORT}`);
  console.log(`Machine IP: ${METICULOUS_IP}`);
});
