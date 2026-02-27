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

# Start HTTP server in background — logs to /tmp/meticulous-mcp.log
start-http-bg:
    #!/usr/bin/env bash
    nohup node dist/http.js > /tmp/meticulous-mcp.log 2>&1 &
    echo $! > /tmp/meticulous-mcp.pid
    echo "Server started (PID $(cat /tmp/meticulous-mcp.pid))"
    echo "Logs: tail -f /tmp/meticulous-mcp.log"

# Stop background HTTP server started with start-http-bg
stop-http-bg:
    #!/usr/bin/env bash
    if [ -f /tmp/meticulous-mcp.pid ]; then
      PID=$(cat /tmp/meticulous-mcp.pid)
      kill "$PID" && rm /tmp/meticulous-mcp.pid
      echo "Server stopped (PID $PID)"
    else
      echo "No background server running (no PID file found)"
    fi

# Tail logs from background HTTP server
http-logs:
    tail -f /tmp/meticulous-mcp.log

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

# Manage the MCP HTTP service — usage: just mcp [start|stop|restart|status|logs|enable]
mcp action:
    #!/usr/bin/env bash
    case "{{action}}" in
      start)
        sudo systemctl start meticulous-mcp
        systemctl is-active meticulous-mcp
        ;;
      stop)
        sudo systemctl stop meticulous-mcp
        ;;
      restart)
        sudo systemctl restart meticulous-mcp
        systemctl is-active meticulous-mcp
        ;;
      status)
        systemctl status meticulous-mcp
        ;;
      logs)
        journalctl -u meticulous-mcp -f
        ;;
      enable)
        sudo systemctl daemon-reload
        sudo systemctl enable meticulous-mcp
        sudo systemctl start meticulous-mcp
        ;;
      *)
        echo "Usage: just mcp [start|stop|restart|status|logs|enable]"
        exit 1
        ;;
    esac

# Aliases for convenience
status:
    @just mcp status

logs:
    @just mcp logs

restart:
    @just mcp restart

stop:
    @just mcp stop

enable:
    @just mcp enable

# ── deploy ────────────────────────────────────────────────────────────────────

# Pull latest code, reinstall, rebuild, and restart service (if enabled)
deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    git pull
    npm install
    npm run build
    if systemctl is-enabled meticulous-mcp &>/dev/null; then
      sudo systemctl restart meticulous-mcp
      sleep 1
      systemctl is-active meticulous-mcp
      echo "✅ Deployed. Service restarted."
    else
      echo "✅ Built and updated."
      echo "   Service not set up yet — run: just enable"
    fi

# ── sanity tests ──────────────────────────────────────────────────────────────

# Health check (no auth required)
health port="3000":
    curl -s http://localhost:{{port}}/health | jq .

# Test auth rejection (should return 401)
test-auth port="3000":
    curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:{{port}}/mcp

# Full MCP initialize handshake — requires MCP_AUTH_TOKEN in env or .env
# Response is SSE format (data: {...}) — strip prefix before parsing
test-init port="3000":
    curl -s -X POST http://localhost:{{port}}/mcp \
      -H "Authorization: Bearer ${MCP_AUTH_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}' \
      | grep '^data:' | sed 's/^data: //' | jq .

# List profiles from the machine — requires MCP_AUTH_TOKEN + METICULOUS_IP in env or .env
test-profiles port="3000":
    curl -s -X POST http://localhost:{{port}}/mcp \
      -H "Authorization: Bearer ${MCP_AUTH_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_profiles","arguments":{}},"id":2}' \
      | grep '^data:' | sed 's/^data: //' | jq .

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
