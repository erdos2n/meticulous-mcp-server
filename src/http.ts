/**
 * Meticulous Espresso MCP Server — HTTP entry point
 *
 * Used on a Raspberry Pi (or any always-on machine) to expose the MCP server
 * over HTTP so it can be reached by claude.ai / Claude mobile via a
 * Cloudflare Tunnel. All shared logic lives in server.ts.
 *
 * Environment variables:
 *   METICULOUS_IP    - IP of your Meticulous machine on your local network (required)
 *   MCP_AUTH_TOKEN   - Bearer token for request authentication (required)
 *   PORT             - HTTP port to listen on (default: 3000)
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, METICULOUS_IP } from "./server.js";

// Fail fast if auth token is not configured
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!AUTH_TOKEN) {
  console.error(
    "ERROR: MCP_AUTH_TOKEN environment variable is required.\n" +
    "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
    "Then set it in your environment or systemd service file."
  );
  process.exit(1);
}

const app = express();
app.use(express.json());

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ============================================================
// MCP ENDPOINT — Streamable HTTP transport
// ============================================================

app.post("/mcp", requireAuth, async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireAuth, async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

// ============================================================
// HEALTH CHECK — no auth (used by Cloudflare and monitoring)
// ============================================================

app.get("/health", (_req, res) => {
  res.json({ status: "ok", machine: METICULOUS_IP });
});

// ============================================================
// START
// ============================================================

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`Meticulous MCP HTTP server running on port ${PORT}`);
  console.log(`Machine IP: ${METICULOUS_IP}`);
});
