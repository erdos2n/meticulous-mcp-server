/**
 * Meticulous Espresso MCP Server — HTTP entry point
 *
 * Used on a Raspberry Pi (or any always-on machine) to expose the MCP server
 * over HTTP so it can be reached by claude.ai / Claude mobile via a
 * Cloudflare Tunnel. All shared logic lives in server.ts.
 *
 * Environment variables:
 *   METICULOUS_IP    - IP of your Meticulous machine on your local network (required)
 *   MCP_AUTH_TOKEN   - Bearer token / OAuth client secret (required)
 *   OAUTH_CLIENT_ID  - OAuth client ID ("token secret id" in claude.ai connector) (required)
 *   PORT             - HTTP port to listen on (default: 3000)
 *
 * OAuth 2.0 client credentials flow (used by claude.ai custom connectors):
 *   1. claude.ai fetches GET /.well-known/oauth-authorization-server
 *   2. claude.ai POSTs /oauth/token with client_id=OAUTH_CLIENT_ID, client_secret=MCP_AUTH_TOKEN
 *   3. Server returns { access_token: MCP_AUTH_TOKEN }
 *   4. claude.ai uses Bearer <access_token> for all /mcp requests
 *
 * In claude.ai connector settings:
 *   - Token secret id  →  value of OAUTH_CLIENT_ID in your .env
 *   - Token secret key →  value of MCP_AUTH_TOKEN in your .env
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, METICULOUS_IP } from "./server.js";

// ============================================================
// ENV VALIDATION
// ============================================================

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!AUTH_TOKEN) {
  console.error(
    "ERROR: MCP_AUTH_TOKEN environment variable is required.\n" +
    "Generate one with: just generate-token\n" +
    "Then add it to your .env file."
  );
  process.exit(1);
}

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
if (!OAUTH_CLIENT_ID) {
  console.error(
    "ERROR: OAUTH_CLIENT_ID environment variable is required.\n" +
    "Set it to any identifier string (e.g. meticulous-mcp) in your .env file.\n" +
    "This is the value you enter in the 'token secret id' field in claude.ai."
  );
  process.exit(1);
}

const app = express();
app.use(express.json());

// ============================================================
// AUTH MIDDLEWARE — validates Bearer token on /mcp endpoints
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
// OAUTH 2.0 — client_credentials flow for claude.ai connector
// ============================================================

// Discovery metadata — claude.ai fetches this to find the token endpoint
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer: base,
    token_endpoint: `${base}/oauth/token`,
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
  });
});

// Token endpoint — issues MCP_AUTH_TOKEN as the access token
app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
  const { client_id, client_secret, grant_type } = req.body;

  if (grant_type !== "client_credentials") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (client_id !== OAUTH_CLIENT_ID || client_secret !== AUTH_TOKEN) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  res.json({
    access_token: AUTH_TOKEN,
    token_type: "bearer",
    expires_in: 3600,
  });
});

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
  console.log(`OAuth client ID: ${OAUTH_CLIENT_ID}`);
});
