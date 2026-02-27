# Meticulous MCP — LLM Setup Guide

Connect your Meticulous espresso machine to an LLM (Claude, etc.) so it can read shot history, manage profiles, track grinder settings, and keep a shot diary — all hands-free.

---

## What this does

- Gives your LLM direct access to your Meticulous machine via 25 tools (profiles, shot history, machine control, settings)
- Tracks grinder settings per profile across sessions so you never lose your dial-in
- Keeps a persistent shot diary with tasting notes so the LLM has context every time you open a new chat

## Generated files

Two files are created automatically on first use, stored at `~/.meticulous-mcp/` on whatever machine runs the server:

| File | What's in it |
|---|---|
| `grinder.json` | Grinder model + setting per profile, updated whenever you tell the LLM your grind size |
| `espresso_diary.md` | Markdown log of shots, tasting notes, and dial-in observations |

You can open either file in any text editor. They're plain text — no database, no setup.

---

## Requirements

- Node.js 18+
- A Meticulous machine on your local network
- The machine's local IP address (find it in your router or the Meticulous app)

---

## Option A — Laptop (Claude Desktop or Claude Code)

Best for: using Claude on your laptop while you're at home on the same Wi-Fi as the machine.

**1. Clone and build**
```bash
git clone https://github.com/erdos2n/meticulous-mcp-server.git
cd meticulous-mcp-server
npm install && npm run build
```

**2. Configure Claude Desktop**

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or equivalent:

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "node",
      "args": ["/absolute/path/to/meticulous-mcp-server/dist/index.js"],
      "env": {
        "METICULOUS_IP": "192.168.x.x"
      }
    }
  }
}
```

Replace `192.168.x.x` with your machine's local IP. Restart Claude Desktop.

**3. Test it**

Ask Claude: *"What profiles are on my Meticulous machine?"*

---

## Option B — Raspberry Pi + Cloudflare Tunnel (claude.ai / Claude mobile)

Best for: accessing your machine from anywhere — claude.ai, Claude on your phone, or any LLM client that supports remote MCP servers.

Requires a Raspberry Pi (or any always-on machine) on the same local network as your Meticulous. See **[PI_SETUP_INSTRUCTIONS.md](./PI_SETUP_INSTRUCTIONS.md)** for the full walkthrough.

The short version:
```bash
# On the Pi:
git clone https://github.com/erdos2n/meticulous-mcp-server.git
cd meticulous-mcp-server
./pi-setup.sh          # installs Node, just, cloudflared
nano .env              # set METICULOUS_IP, MCP_AUTH_TOKEN, OAUTH_CLIENT_ID, PORT
just enable            # start MCP server as a system service
just enable-tunnel     # start Cloudflare tunnel as a system service
just tunnel-url-service  # get the public URL
# Add the URL + credentials to claude.ai → Settings → Connectors
```

> **Note:** The Pi path requires a small amount of terminal comfort. If that's not you, Option A is simpler and works great for at-home use.

---

## Starting a session

Tell your LLM at the start of any chat:

> *"Check my grinder context and read my shot diary to get up to speed."*

The LLM will call `get_grinder_context` and `read_diary` automatically and have full context of your setup and recent shots without you having to re-explain anything.

---

## Key tools the LLM has access to

| Tool | What it does |
|---|---|
| `get_grinder_context` | Recall saved grinder settings for all profiles |
| `set_grinder_context` | Save current grinder setting for a profile |
| `read_diary` | Read the full shot diary |
| `append_diary_entry` | Log a shot with tasting notes |
| `list_profiles` | List all profiles on the machine |
| `get_last_shot` | Get data from the most recent shot |
| `get_shot_history` | Browse past shots |
| `get_device_info` | Machine status and firmware version |
| `execute_action` | Start, stop, tare, preheat, etc. |

Full tool list: see `src/server.ts` or ask the LLM *"what tools do you have for my espresso machine?"*
