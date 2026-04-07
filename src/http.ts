/**
 * Meticulous Espresso MCP Server — HTTP entry point
 *
 * Used on a Raspberry Pi (or any always-on machine) to expose the MCP server
 * over HTTP so it can be reached by claude.ai / Claude mobile via a
 * Tailscale or Cloudflare Tunnel. All shared logic lives in server.ts.
 *
 * Environment variables:
 *   METICULOUS_IP    - IP of your Meticulous machine on your local network (required)
 *   MCP_AUTH_TOKEN   - Bearer token / OAuth client secret (required)
 *   OAUTH_CLIENT_ID  - OAuth client ID ("token secret id" in claude.ai connector) (required)
 *   PORT             - HTTP port to listen on (default: 3000)
 *
 * OAuth 2.0 Authorization Code + PKCE flow (used by claude.ai custom connectors):
 *   1. claude.ai fetches GET /.well-known/oauth-authorization-server
 *   2. claude.ai redirects browser to GET /authorize?response_type=code&client_id=...&code_challenge=...
 *   3. Server auto-approves and redirects back to claude.ai with a one-time code
 *   4. claude.ai POSTs /oauth/token with grant_type=authorization_code&code=...&code_verifier=...
 *   5. Server verifies PKCE, returns { access_token: MCP_AUTH_TOKEN }
 *   6. claude.ai uses Bearer <access_token> for all /mcp requests
 *
 * In claude.ai connector settings:
 *   - Token secret id  →  value of OAUTH_CLIENT_ID in your .env
 *   - Token secret key →  value of MCP_AUTH_TOKEN in your .env
 *
 * Keepalive:
 *   The server self-pings /health every 3 minutes after startup. This prevents
 *   claude.ai from dropping the connector session due to ~5 min idle timeout.
 *   Logs to console as "[keepalive]" lines — safe to ignore.
 */

import { createHash, randomBytes } from "crypto";
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
// OAUTH 2.0 — Authorization Code + PKCE flow
// ============================================================

// In-memory store for one-time auth codes (auto-expires after 5 minutes)
interface AuthCode {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}
const authCodes = new Map<string, AuthCode>();

// In-memory registry for dynamically registered OAuth clients (RFC 7591)
const dynamicClients = new Map<string, { redirect_uris: string[] }>();

// Clean up expired codes every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 10 * 60 * 1000);

// Discovery metadata — claude.ai fetches this to find the authorization + token endpoints
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = `https://${req.get("host")}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/register`,
    grant_types_supported: ["authorization_code"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  });
});

// Registration endpoint — Anthropic hits this before /authorize to obtain a client_id (RFC 7591)
app.post("/register", (req, res) => {
  const { redirect_uris, client_name } = req.body ?? {};
  if (!redirect_uris?.length) {
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "redirect_uris required",
    });
    return;
  }

  const client_id = `dyn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  dynamicClients.set(client_id, { redirect_uris });

  console.log(`[register] new client: ${client_id} (${client_name ?? "unnamed"})`);

  res.status(201).json({
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// Authorization endpoint — claude.ai redirects the browser here to kick off auth
// Since this is a private single-user server, we auto-approve immediately
app.get("/authorize", (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } =
    req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }
  if (client_id !== OAUTH_CLIENT_ID && !dynamicClients.has(client_id)) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }
  if (!code_challenge || code_challenge_method !== "S256") {
    res.status(400).json({ error: "invalid_request", error_description: "PKCE S256 required" });
    return;
  }
  if (!redirect_uri) {
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri required" });
    return;
  }

  // Generate a one-time auth code, store it with the PKCE challenge
  const code = randomBytes(32).toString("hex");
  authCodes.set(code, {
    codeChallenge: code_challenge,
    redirectUri: redirect_uri,
    clientId: client_id,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });

  // Redirect back to claude.ai with the code
  const callbackUrl = new URL(redirect_uri);
  callbackUrl.searchParams.set("code", code);
  if (state) callbackUrl.searchParams.set("state", state);

  console.log(`OAuth: authorized client_id=${client_id}, redirecting to callback`);
  res.redirect(callbackUrl.toString());
});

// Token endpoint — exchanges auth code + code_verifier for an access token
app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
  const { grant_type, code, code_verifier, redirect_uri, client_id } = req.body;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  const stored = authCodes.get(code);
  if (!stored || stored.expiresAt < Date.now()) {
    authCodes.delete(code);
    res.status(400).json({ error: "invalid_grant", error_description: "Code expired or not found" });
    return;
  }

  if (stored.clientId !== client_id || stored.redirectUri !== redirect_uri) {
    res.status(400).json({ error: "invalid_grant", error_description: "client_id or redirect_uri mismatch" });
    return;
  }

  // Verify PKCE: SHA256(code_verifier) base64url must equal stored code_challenge
  const computed = createHash("sha256")
    .update(code_verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  if (computed !== stored.codeChallenge) {
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    return;
  }

  // Consume the code (one-time use)
  authCodes.delete(code);

  console.log(`OAuth: token issued for client_id=${client_id}`);
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
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/mcp", requireAuth, async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("MCP GET error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================
// HEALTH CHECK — no auth (used by Tailscale/Cloudflare and keepalive)
// ============================================================

app.get("/health", (_req, res) => {
  res.json({ status: "ok", machine: METICULOUS_IP });
});

// ============================================================
// START + KEEPALIVE
// ============================================================

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () => {
  console.log(`Meticulous MCP HTTP server running on port ${PORT}`);
  console.log(`Machine IP: ${METICULOUS_IP}`);
  console.log(`OAuth client ID: ${OAUTH_CLIENT_ID}`);

  // Self-ping keepalive: hits /health every 3 minutes to prevent claude.ai
  // from dropping the connector session due to idle timeout (~5 min observed).
  // Runs entirely within the process — no cron or external tooling needed.
  const KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
  const healthUrl = `http://localhost:${PORT}/health`;

  setInterval(async () => {
    try {
      const res = await fetch(healthUrl);
      if (!res.ok) {
        console.warn(`[keepalive] /health returned ${res.status}`);
      } else {
        console.log(`[keepalive] ping ok — ${new Date().toISOString()}`);
      }
    } catch (err) {
      console.warn(`[keepalive] ping failed: ${err}`);
    }
  }, KEEPALIVE_INTERVAL_MS);

  console.log(`[keepalive] self-ping active every ${KEEPALIVE_INTERVAL_MS / 1000}s → ${healthUrl}`);
});

// Log unhandled errors loudly rather than crashing silently.
// systemd Restart=always will bring the process back if it does exit.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
