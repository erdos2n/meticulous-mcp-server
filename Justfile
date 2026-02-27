# Meticulous MCP Server — Justfile
# Run `just` to see all available recipes.
# Install just: https://just.systems  or  run ./pi-setup.sh

set dotenv-load := true   # auto-loads .env if present

# ── default: list all recipes ──────────────────────────────────────────────────
default:
    @just --list

# ── build ──────────────────────────────────────────────────────────────────────

# Install dependencies
install:
    npm install

# Build both entry points (stdio + http)
build:
    npm run build

# Install dependencies and build
setup: install build

# ── run ───────────────────────────────────────────────────────────────────────

# Start the stdio server (for Claude Desktop / Claude Code)
start:
    node dist/index.js

# Start the HTTP server (for Pi / Cloudflare Tunnel / claude.ai)
start-http:
    node dist/http.js

# Run the HTTP server in dev mode with live reload
dev-http:
    npx tsx watch src/http.ts

# Run the stdio server in dev mode
dev:
    npx tsx src/index.ts

# ── token ─────────────────────────────────────────────────────────────────────

# Generate a secure bearer token for MCP_AUTH_TOKEN
generate-token:
    @node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ── pi / systemd ──────────────────────────────────────────────────────────────

# Show HTTP server service status
status:
    systemctl status meticulous-mcp

# Tail live logs from the HTTP server service
logs:
    journalctl -u meticulous-mcp -f

# Restart the HTTP server service
restart:
    sudo systemctl restart meticulous-mcp

# Stop the HTTP server service
stop:
    sudo systemctl stop meticulous-mcp

# Enable + start the service (first time only)
enable:
    sudo systemctl daemon-reload
    sudo systemctl enable meticulous-mcp
    sudo systemctl start meticulous-mcp

# ── deploy ────────────────────────────────────────────────────────────────────

# Pull latest code, reinstall, rebuild, and restart service
deploy:
    git pull
    npm install
    npm run build
    sudo systemctl restart meticulous-mcp
    @echo "✅ Deployed. Service restarted."
    @sleep 1
    systemctl is-active meticulous-mcp

# ── sanity tests ──────────────────────────────────────────────────────────────

# Health check (no auth required)
health port="3000":
    curl -s http://localhost:{{port}}/health | jq .

# Test auth rejection (should return 401)
test-auth port="3000":
    curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:{{port}}/mcp

# Full MCP initialize handshake — requires MCP_AUTH_TOKEN in env or .env
test-init port="3000":
    curl -s -X POST http://localhost:{{port}}/mcp \
      -H "Authorization: Bearer ${MCP_AUTH_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}' | jq .

# List profiles from the machine — requires MCP_AUTH_TOKEN + METICULOUS_IP in env or .env
test-profiles port="3000":
    curl -s -X POST http://localhost:{{port}}/mcp \
      -H "Authorization: Bearer ${MCP_AUTH_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_profiles","arguments":{}},"id":2}' | jq .

# Run all sanity tests in sequence
test port="3000":
    @echo "── 1. Health check ──"
    @just health {{port}}
    @echo "\n── 2. Auth rejection (expect 401) ──"
    @just test-auth {{port}}
    @echo "\n── 3. MCP initialize ──"
    @just test-init {{port}}
    @echo "\n── 4. list_profiles ──"
    @just test-profiles {{port}}
