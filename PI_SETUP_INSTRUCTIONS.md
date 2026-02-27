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

- Pi already cloned the repo and ran `npm run build` (confirm with `ls ~/meticulous-mcp-server/dist/`)
- Your Meticulous machine's local IP (e.g. `192.168.1.x`)
- A bearer token — generate one now on your laptop:
  ```bash
  npm run generate-token
  ```
  Save this somewhere safe (password manager). You'll paste it in two places: the systemd service below, and claude.ai's connector settings.

---

## Step 1 — Pull the latest code and rebuild

SSH into the Pi and run:

```bash
ssh pi@meticulous-pi.local
cd ~/meticulous-mcp-server
git pull
npm install
npm run build
```

Verify the HTTP entry point compiled:

```bash
ls dist/http.js
# Should exist
```

---

## Step 2 — Quick smoke test (before setting up systemd)

```bash
MCP_AUTH_TOKEN=your-token-here METICULOUS_IP=192.168.x.x npm run start:http
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

While `start:http` is running, open another SSH session and run these:

```bash
# 1. Health check — no auth needed
curl http://localhost:3000/health
# Expected: {"status":"ok","machine":"192.168.x.x"}

# 2. Auth rejection — should get 401
curl -X POST http://localhost:3000/mcp
# Expected: {"error":"Unauthorized"}

# 3. MCP initialize handshake — replace YOUR_TOKEN
# Note: MCP Streamable HTTP requires Accept to include both types
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}},"id":1}'
# Expected: JSON response with "serverInfo" containing "meticulous-espresso"

# 4. Real tool call — list profiles from your machine
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_profiles","arguments":{}},"id":2}'
# Expected: your actual profiles from the Meticulous machine
```

If test 4 returns an error about connecting to the machine, double-check that:
- The Pi and the Meticulous machine are on the same Wi-Fi network
- `METICULOUS_IP` is the machine's current IP (check your router if unsure)

---

## Step 4 — Create the systemd service

This keeps the server running and restarts it automatically after reboots or crashes.

```bash
sudo nano /etc/systemd/system/meticulous-mcp.service
```

Paste the following — replace `192.168.x.x` with your machine's real IP and `your-token-here` with your generated token:

```ini
[Unit]
Description=Meticulous MCP HTTP Server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/meticulous-mcp-server
Environment=METICULOUS_IP=192.168.x.x
Environment=MCP_AUTH_TOKEN=your-token-here
Environment=PORT=3000
ExecStart=/usr/bin/node /home/pi/meticulous-mcp-server/dist/http.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Save: `Ctrl+X` → `Y` → `Enter`

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable meticulous-mcp
sudo systemctl start meticulous-mcp
sudo systemctl status meticulous-mcp
```

Should show **active (running)** in green.

Useful commands going forward:

```bash
sudo journalctl -u meticulous-mcp -f    # live logs
sudo systemctl restart meticulous-mcp   # restart
sudo systemctl stop meticulous-mcp      # stop
```

---

## Step 5 — Install and start Cloudflare Tunnel

```bash
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm.deb
sudo dpkg -i cloudflared.deb
```

Start a quick temporary tunnel:

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

When you push changes to GitHub, update the Pi with:

```bash
ssh pi@meticulous-pi.local
cd ~/meticulous-mcp-server && git pull && npm install && npm run build
sudo systemctl restart meticulous-mcp
```

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| `systemctl status` shows failed | `sudo journalctl -u meticulous-mcp -n 50` for error details |
| Health check returns connection refused | systemd service not running — `sudo systemctl start meticulous-mcp` |
| Tool calls return machine connection error | Meticulous IP wrong or machine offline; verify with `curl http://192.168.x.x` from the Pi |
| 401 on all requests | Token mismatch — compare `MCP_AUTH_TOKEN` in service file vs what you entered in claude.ai |
| Cloudflare URL not reachable | Tunnel may have restarted (URL changes); re-run `cloudflared tunnel --url http://localhost:3000` |
