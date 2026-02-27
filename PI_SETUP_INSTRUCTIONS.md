# Raspberry Pi Setup — Meticulous MCP HTTP Server

Run the MCP server on a Pi so it's reachable from claude.ai and Claude mobile via a Cloudflare Tunnel.

---

## Architecture

```
claude.ai / Claude mobile
         │
         ▼
Cloudflare Tunnel (https://xxxx.trycloudflare.com/mcp)
         │
         ▼
  Raspberry Pi :3000
         │
  src/http.ts (Express + Bearer auth)
         │
  src/server.ts (all MCP tools)
         │
         ▼
  Meticulous machine (192.168.x.x)
```

Your laptop uses `src/index.ts` → stdio → Claude Desktop / Claude Code — unchanged.

---

## Prerequisites

- Pi has the repo cloned (e.g. `~/meticulous-mcp-server`)
- Your Meticulous machine's local IP (e.g. `192.168.1.x`)
- A bearer token — generate one now on your laptop:
  ```bash
  just generate-token
  # or: npm run generate-token
  ```
  Save this somewhere safe (password manager). You'll paste it in the `.env` file below and in claude.ai's connector settings.

---

## Step 1 — Run the setup script (installs Node, just, cloudflared)

SSH into the Pi and run:

```bash
ssh pi@meticulous-pi.local
cd ~/meticulous-mcp-server
git pull
./pi-setup.sh
```

`pi-setup.sh` installs Node.js 20 LTS, `just`, `cloudflared`, and `jq`, then runs `npm install` and `npm run build` automatically.

Verify the HTTP entry point compiled:

```bash
ls dist/http.js
# Should exist
```

---

## Step 2 — Create your .env file

```bash
cd ~/meticulous-mcp-server
nano .env
```

Paste (with your real values):

```env
METICULOUS_IP=192.168.x.x
MCP_AUTH_TOKEN=your-token-here
PORT=3000
```

Save: `Ctrl+X` → `Y` → `Enter`

The `Justfile` has `set dotenv-load := true`, so `just` commands automatically pick up `.env`.

---

## Step 2b — Quick smoke test

```bash
just start-http
```

Expected output:
```
Meticulous MCP HTTP server running on port 3000
Machine IP: 192.168.x.x
```

Press `Ctrl+C` to stop. If it fails, check:
- `METICULOUS_IP` is set to the correct IP (no `http://` prefix needed)
- `MCP_AUTH_TOKEN` is non-empty

---

## Step 3 — Sanity tests (run from the Pi in a second terminal)

While `just start-http` is running, open another SSH session. Tests read `MCP_AUTH_TOKEN` and `METICULOUS_IP` from your `.env` file automatically.

**Easiest — run all four tests at once:**

```bash
just test
```

**Or run them individually:**

```bash
# 1. Health check — no auth needed
just health
# Expected: {"status":"ok","machine":"<your METICULOUS_IP>"}

# 2. Auth rejection — should return 401
just test-auth
# Expected: 401

# 3. MCP initialize handshake
just test-init
# Expected: JSON with "serverInfo" containing "meticulous-espresso"

# 4. List profiles from your machine
just test-profiles
# Expected: your actual profiles from the Meticulous machine
```

**Or raw curl with env vars (if you prefer):**

```bash
# Source .env so $MCP_AUTH_TOKEN is available in your shell
set -a && source .env && set +a

# Health
curl -s http://localhost:3000/health | jq .

# Initialize
# Note: MCP Streamable HTTP requires Accept to include both content types
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}' | jq .

# List profiles
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_profiles","arguments":{}},"id":2}' | jq .
```

If test 4 returns a machine connection error, double-check:
- The Pi and the Meticulous machine are on the same Wi-Fi network
- `METICULOUS_IP` in `.env` is the current IP (check your router if unsure)

---

## Step 4 — Create the systemd service

This keeps the server running and restarts it automatically after reboots or crashes.

```bash
sudo nano /etc/systemd/system/meticulous-mcp.service
```

Paste the following (env vars are loaded from `.env` via `EnvironmentFile`):

```ini
[Unit]
Description=Meticulous MCP HTTP Server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/meticulous-mcp-server
EnvironmentFile=/home/pi/meticulous-mcp-server/.env
ExecStart=/usr/bin/node /home/pi/meticulous-mcp-server/dist/http.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Save: `Ctrl+X` → `Y` → `Enter`

Enable and start (or just use `just`):

```bash
just enable
# equivalent to: sudo systemctl daemon-reload && sudo systemctl enable meticulous-mcp && sudo systemctl start meticulous-mcp
```

Should show **active (running)** in green. Verify:

```bash
just status
```

Useful `just` commands going forward:

```bash
just logs      # live logs (journalctl -f)
just restart   # restart service
just stop      # stop service
just deploy    # git pull + npm install + build + restart (one command for future updates)
```

---

## Step 5 — Start Cloudflare Tunnel

`cloudflared` was installed by `pi-setup.sh`. Start a quick temporary tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the `https://xxxx.trycloudflare.com` URL it prints. This URL changes every time you restart the tunnel.

> **For a permanent URL** (recommended once everything is confirmed working): create a free Cloudflare account, set up a named tunnel, and run it as a second systemd service. The named tunnel gives you a stable `https://your-subdomain.yourdomain.com` URL that survives Pi restarts.

---

## Step 6 — Test the tunnel

From any machine (your laptop, phone, etc.):

```bash
# Health check via tunnel
curl https://xxxx.trycloudflare.com/health
# Expected: {"status":"ok","machine":"192.168.x.x"}
```

---

## Step 7 — Add connector in claude.ai

1. Go to **claude.ai** → Profile → Settings → **Connectors**
2. Click **Add custom connector**
3. URL: `https://xxxx.trycloudflare.com/mcp`
4. Enter your bearer token when prompted
5. Should show as **connected**

Once added on claude.ai, it's available on Claude mobile too.

Test it: ask Claude "What profiles are on my Meticulous machine?"

---

## Future updates

One command to pull, rebuild, and restart:

```bash
ssh pi@meticulous-pi.local
cd ~/meticulous-mcp-server && just deploy
```

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| `just status` shows failed | `just logs` for error details |
| Health check returns connection refused | Service not running — `just enable` or `just restart` |
| Tool calls return machine connection error | Check `METICULOUS_IP` in `.env`; verify with `curl http://192.168.x.x` from the Pi |
| 401 on all requests | Token mismatch — compare `MCP_AUTH_TOKEN` in `.env` vs what you entered in claude.ai |
| Cloudflare URL not reachable | Tunnel may have restarted (URL changes); re-run `cloudflared tunnel --url http://localhost:3000` |
