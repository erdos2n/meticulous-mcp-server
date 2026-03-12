# Meticulous Espresso MCP Server

Your Meticulous espresso machine, connected to an LLM. Generate recipes from natural language, analyze shots, dial in your grinder, and keep a persistent shot diary — all through Claude.

No Anthropic API key required. No cloud subscription. Just your machine, your LLM, and a local IP.

---

## Get started in 60 seconds

Add this to your Claude Desktop or Claude Code config and you're done:

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`

**Claude Code** — `~/.claude.json`

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "npx",
      "args": ["-y", "github:erdos2n/meticulous-mcp-server"],
      "env": {
        "METICULOUS_IP": "192.168.x.x"
      }
    }
  }
}
```

Replace `192.168.x.x` with your machine's local IP (find it in your router or the Meticulous app). Restart Claude. That's it — no cloning, no building, no dependencies to manage.

> **Want this on Claude mobile or claude.ai?** You'll need a Raspberry Pi on your local network. See [LLM_SETUP.md](./LLM_SETUP.md) and [PI_SETUP_INSTRUCTIONS.md](./PI_SETUP_INSTRUCTIONS.md).

---

## What you can do

```
Pull the shot data from my last espresso and tell me what to adjust.
```
```
Generate a recipe for a washed Ethiopian, 18g dose, 1:2.5 ratio, slow bloom.
```
```
Save my grinder setting — I'm on the DF83 at 10.2 for the Osmotic flow profile.
```
```
Read my shot diary and tell me what's been working.
```
```
My last three shots were sour. Look at the shot data and suggest a fix.
```
```
List all my profiles and load the one I used last week for the natural.
```

---

## What it does

- **Generate and tweak recipes** from plain language, validated and loaded to the machine
- **Analyze shots** — pulls sensor data and gives concrete recipe improvement suggestions
- **Manage profiles** — list, load, save, delete, browse factory and community recipes
- **Control the machine** — start, stop, tare, preheat, reset
- **Track grinder settings** per profile across sessions — never re-explain your dial-in
- **Keep a shot diary** — tasting notes and observations that persist between chats

The grinder settings and diary are stored as plain files in `~/.meticulous-mcp/` on your machine. No database, no setup — just open them in any text editor.

---

## All available tools

### Machine control
| Tool | What it does |
|---|---|
| `get_device_info` | Firmware, serial, model, software version |
| `execute_action` | start / stop / tare / preheat / reset / calibration |
| `get_settings` | Read machine settings |
| `update_setting` | Change machine settings |
| `get_notifications` | Pending or acknowledged machine notifications |

### Profiles
| Tool | What it does |
|---|---|
| `list_profiles` | All profiles stored on the machine |
| `get_all_profiles` | Full details for every profile |
| `get_profile` | Single profile by UUID |
| `get_last_profile` | Currently active profile |
| `get_default_profiles` | Factory + community profiles |
| `load_profile` | Load a recipe (temporary) |
| `load_profile_by_id` | Load an existing profile by UUID |
| `save_profile` | Save a recipe to the machine permanently |
| `delete_profile` | Remove a profile by UUID |
| `validate_recipe` | Check schema + auto-fix simple errors |

### Shot history
| Tool | What it does |
|---|---|
| `get_shot_history` | Recent shots with metadata |
| `search_history` | Filter by name, date, order, limit |
| `get_current_shot` | Real-time data for a shot in progress |
| `get_last_shot` | Sensor data for the most recent shot |
| `get_shot_statistics` | Total shots, breakdown by profile |
| `get_shot_data_for_analysis` | Full shot + profile for deep analysis |
| `rate_shot` | Mark a shot as like / dislike |
| `search_historical_profiles` | Find past profile versions |

### Grinder + diary
| Tool | What it does |
|---|---|
| `get_grinder_context` | Recall saved grinder settings for all profiles |
| `set_grinder_context` | Save current grinder setting for a profile |
| `read_diary` | Read the full shot diary |
| `append_diary_entry` | Log a shot with tasting notes |

---

## Shot data verbosity

Shot tools default to compact responses to keep context windows manageable:

| Option | What you get |
|---|---|
| `verbosity: "summary"` | Key metadata only |
| `verbosity: "compact"` | Metadata + sampled trace (default) |
| `verbosity: "full"` | Full raw payload |

---

## Full setup options

See **[LLM_SETUP.md](./LLM_SETUP.md)** for all installation paths — laptop, clone-and-build, and Raspberry Pi remote access.

---

## Project layout

```
meticulous-mcp-server/
├── src/
│   ├── server.ts          # All 25 MCP tools + machine logic
│   ├── index.ts           # stdio entry point (laptop / Claude Desktop / Claude Code)
│   └── http.ts            # HTTP entry point (Pi / Cloudflare / claude.ai)
├── dist/                  # Compiled output
├── LLM_SETUP.md           # Setup guide for all install paths
├── PI_SETUP_INSTRUCTIONS.md  # Full Pi + Cloudflare Tunnel walkthrough
├── Justfile               # Build, run, deploy, test commands
└── pi-setup.sh            # Pi dependency installer
```

---

## npm release checklist

When ready to publish so users can run `npx -y meticulous-mcp-server`:

```bash
npm whoami                          # confirm logged in
npm ci && npm run build             # clean build
npm version patch                   # bump version
npm publish --access public         # publish
npx -y meticulous-mcp-server        # smoke test
```
