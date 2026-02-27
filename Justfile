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

# ── cloudflare tunnel ──────────────────────────────────────────────────────────

# Start Cloudflare tunnel in background — logs to /tmp/cloudflared.log
tunnel-bg:
    #!/usr/bin/env bash
    nohup cloudflared tunnel --url http://localhost:${PORT:-3000} > /tmp/cloudflared.log 2>&1 &
    echo $! > /tmp/cloudflared.pid
    echo "Cloudflare tunnel starting (PID $(cat /tmp/cloudflared.pid)) ..."
    sleep 5
    just tunnel-url

# Stop background Cloudflare tunnel
stop-tunnel:
    #!/usr/bin/env bash
    if [ -f /tmp/cloudflared.pid ]; then
      PID=$(cat /tmp/cloudflared.pid)
      kill "$PID" && rm /tmp/cloudflared.pid
      echo "Tunnel stopped (PID $PID)"
    else
      echo "No background tunnel running (no PID file found)"
    fi

# Print the current tunnel URL (from background tunnel log)
tunnel-url:
    @grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cloudflared.log | tail -1

# Tail Cloudflare tunnel logs
tunnel-logs:
    tail -f /tmp/cloudflared.log

# Generate cloudflared systemd service and enable it (tunnel survives reboots)
enable-tunnel:
    @just generate-tunnel-service
    sudo systemctl daemon-reload
    sudo systemctl enable cloudflared-tunnel
    sudo systemctl start cloudflared-tunnel
    @echo "✅ Cloudflare tunnel service enabled"
    @echo "   URL (may take ~10s to appear): just tunnel-url-service"

# Print the tunnel URL from the systemd service logs
tunnel-url-service:
    @journalctl -u cloudflared-tunnel --no-pager | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1

# Write /etc/systemd/system/cloudflared-tunnel.service
generate-tunnel-service:
    #!/usr/bin/env bash
    set -euo pipefail
    SERVICE_USER=$(whoami)
    CF_PATH=$(which cloudflared)
    PORT=${PORT:-3000}
    printf '%s\n' \
      '[Unit]' \
      'Description=Cloudflare Tunnel for Meticulous MCP' \
      'After=network.target meticulous-mcp.service' \
      '' \
      '[Service]' \
      'Type=simple' \
      "User=$SERVICE_USER" \
      "ExecStart=$CF_PATH tunnel --url http://localhost:$PORT" \
      'Restart=always' \
      'RestartSec=10' \
      '' \
      '[Install]' \
      'WantedBy=multi-user.target' \
      | sudo tee /etc/systemd/system/cloudflared-tunnel.service > /dev/null
    echo "✅ Tunnel service file written"
    echo "   User: $SERVICE_USER"
    echo "   cloudflared: $CF_PATH"
    echo "   Port: $PORT"

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

# Generate the systemd service file from the current user and directory, then enable
enable:
    @just generate-service
    @just mcp enable

# Write /etc/systemd/system/meticulous-mcp.service using current user, dir, and node path
generate-service:
    #!/usr/bin/env bash
    set -euo pipefail
    SERVICE_USER=$(whoami)
    WORK_DIR=$(pwd)
    NODE_PATH=$(which node)
    SERVICE_FILE=/etc/systemd/system/meticulous-mcp.service
    printf '%s\n' \
      '[Unit]' \
      'Description=Meticulous MCP HTTP Server' \
      'After=network.target' \
      '' \
      '[Service]' \
      'Type=simple' \
      "User=$SERVICE_USER" \
      "WorkingDirectory=$WORK_DIR" \
      "EnvironmentFile=$WORK_DIR/.env" \
      "ExecStart=$NODE_PATH $WORK_DIR/dist/http.js" \
      'Restart=always' \
      'RestartSec=5' \
      '' \
      '[Install]' \
      'WantedBy=multi-user.target' \
      | sudo tee "$SERVICE_FILE" > /dev/null
    echo "✅ Service file written: $SERVICE_FILE"
    echo "   User: $SERVICE_USER"
    echo "   WorkDir: $WORK_DIR"
    echo "   Node: $NODE_PATH"

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
