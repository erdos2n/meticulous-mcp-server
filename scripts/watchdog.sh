#!/usr/bin/env bash
# Meticulous MCP watchdog
# Auto-restarts the MCP server if it goes down.
# Checks the Cloudflare tunnel status but does NOT restart it —
# restarting cloudflared assigns a new random URL and breaks the claude.ai connector.
#
# Install via: just watchdog-install
# Runs every 5 minutes as root (needed to control system services)

LOG=/tmp/meticulous-watchdog.log
PORT=${PORT:-3000}

# Rolling 24h log — delete if the file is older than 1 day so it doesn't grow forever
if [ -f "$LOG" ] && [ -n "$(find "$LOG" -mtime +1 2>/dev/null)" ]; then
  rm "$LOG"
fi

TS=$(date '+%Y-%m-%d %H:%M:%S')

# ── MCP server ────────────────────────────────────────────────────────────────
if systemctl is-active --quiet meticulous-mcp; then
  echo "[$TS] ✅ meticulous-mcp running" >> "$LOG"
else
  systemctl start meticulous-mcp
  echo "[$TS] ⚠️  meticulous-mcp was down — restarted" >> "$LOG"
fi

# ── Cloudflare tunnel ─────────────────────────────────────────────────────────
# ⚠️  Do NOT auto-restart cloudflared — restarting gives a new random
# trycloudflare.com URL, which breaks the claude.ai connector until you
# manually update it. Just alert so you can intervene intentionally.
if systemctl is-active --quiet cloudflared-tunnel; then
  echo "[$TS] ✅ cloudflared-tunnel running" >> "$LOG"
else
  echo "[$TS] ❌ cloudflared-tunnel is DOWN — manual restart required (restarting changes the tunnel URL)" >> "$LOG"
fi

# ── Health endpoint ───────────────────────────────────────────────────────────
HEALTH=$(curl -s --max-time 5 "http://localhost:$PORT/health" 2>/dev/null)
if [ -n "$HEALTH" ]; then
  echo "[$TS] 🌐 health ok: $HEALTH" >> "$LOG"
else
  echo "[$TS] ❌ health endpoint not responding on port $PORT" >> "$LOG"
fi
