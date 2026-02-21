# Meticulous Espresso MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude full control over your Meticulous home espresso machine. Works with Claude Desktop and Claude Code.

No Anthropic API key required — Claude handles all the AI reasoning. This server handles the machine.

## What it does

- **Generate recipes** from natural language ("a gentle blooming profile for a washed Ethiopian")
- **Tailor recipes** based on feedback ("too bitter, reduce temperature and shorten extraction")
- **Browse shot history** with filtering and analysis
- **Analyze shots** and get concrete recipe improvement suggestions
- **Manage profiles** on the machine (list, load, save, delete)
- **Control the machine** (start, stop, tare, preheat)
- **Validate recipes** — checks and auto-repairs malformed JSON before sending to the machine

## Setup

You only need your machine's local IP and one MCP server config entry.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `METICULOUS_IP` | **Yes** | Local IP of your Meticulous machine (find it in your router or the machine's settings) |
| `MACHINE_IP` | No | Alternative to `METICULOUS_IP` — used as fallback if `METICULOUS_IP` is not set |

### Recommended (easy sharing) — Auto install with `npx`

Use this when sharing with others so they only add config and Claude installs/launches automatically.

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "npx",
      "args": ["-y", "github:erdos2n/meticulous-mcp-server"],
      "env": {
        "METICULOUS_IP": "192.168.1.x"
      }
    }
  }
}
```

If published to npm, replace args with:

```json
["-y", "meticulous-mcp-server"]
```

### Option A — Local repo (current development)

If you have the repo cloned locally, first install and build:

```bash
cd /path/to/meticulous-mcp-server
npm install   # also runs the build via the prepare script
```

Then add to your Claude config:

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`

**Claude Code** — `~/.claude.json`

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "node",
      "args": ["/absolute/path/to/meticulous-mcp-server/dist/index.js"],
      "env": {
        "METICULOUS_IP": "192.168.1.x"
      }
    }
  }
}
```

Or skip the build step entirely using `tsx` (runs TypeScript directly):

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/meticulous-mcp-server/src/index.ts"],
      "env": {
        "METICULOUS_IP": "192.168.1.x"
      }
    }
  }
}
```

### Option B — Local repo via `npx` (no explicit build command)

This still runs locally, but through `npx`:

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "npx",
      "args": ["-y", "/absolute/path/to/meticulous-mcp-server"],
      "env": {
        "METICULOUS_IP": "192.168.1.x"
      }
    }
  }
}
```

### Option C — Zero install via GitHub

No cloning or manual build required:

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "npx",
      "args": ["-y", "github:erdos2n/meticulous-mcp-server"],
      "env": {
        "METICULOUS_IP": "192.168.1.x"
      }
    }
  }
}
```

The first time Claude starts, `npx` will download the repo, build it automatically, and launch the server. Subsequent starts are instant from cache.

Restart Claude and you should see the meticulous server in your MCP list.

---

## npm Release Checklist

Use this when you're ready to move from local/GitHub usage to `npx -y meticulous-mcp-server` for everyone.

1. Verify your npm account and login:

```bash
npm whoami
```

2. Build and sanity check locally:

```bash
npm ci
npm run build
METICULOUS_IP=192.168.1.x node dist/index.js
```

3. Bump version:

```bash
npm version patch
```

4. Publish package:

```bash
npm publish --access public
```

5. Smoke test exactly how users will run it:

```bash
METICULOUS_IP=192.168.1.x npx -y meticulous-mcp-server
```

6. Share this Claude MCP config with users:

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "npx",
      "args": ["-y", "meticulous-mcp-server"],
      "env": {
        "METICULOUS_IP": "192.168.1.x"
      }
    }
  }
}
```

If users already added a previous server definition, remove/re-add it so Claude picks up the new command.

---

## Available Tools

### Machine Control

| Tool | Description |
|------|-------------|
| `get_device_info` | Firmware, serial, model, software version |
| `execute_action` | start / stop / tare / preheat / reset / calibration |
| `get_settings` | Read machine settings |
| `update_setting` | Change machine settings |
| `get_notifications` | Pending or acknowledged machine notifications |

### Profile Management

| Tool | Description |
|------|-------------|
| `list_profiles` | All profiles stored on the machine |
| `get_all_profiles` | Full profile details for all stored recipes |
| `get_profile` | Single profile by UUID |
| `get_last_profile` | Currently active / last loaded profile |
| `get_default_profiles` | Factory + community profiles |
| `load_profile` | Set a recipe as active (temporary) |
| `load_profile_by_id` | Activate an existing profile by UUID |
| `save_profile` | Permanently save a recipe to the machine |
| `delete_profile` | Remove a profile by UUID |

### Shot History

| Tool | Description |
|------|-------------|
| `get_shot_history` | Recent shots with metadata |
| `search_history` | Filter by name, date, order, limit |
| `get_current_shot` | Real-time data for shot in progress |
| `get_last_shot` | Full sensor data for most recent shot |
| `get_shot_statistics` | Total shots, breakdown by profile |
| `rate_shot` | Mark a shot as like / dislike / null |
| `search_historical_profiles` | Find past versions of a profile |

### Shot output size controls

To avoid blowing up chat context windows, shot tools now default to compact responses:

- `get_last_shot` → `verbosity: "summary"` by default
- `get_current_shot` → `verbosity: "summary"` by default
- `get_shot_data_for_analysis` → `verbosity: "compact"` by default

Use these options when needed:

- `verbosity: "summary"` → key metadata only
- `verbosity: "compact"` → metadata + sampled trace preview
- `verbosity: "full"` → full raw payload (large)
- `max_points` → cap trace preview size for compact/summary outputs

### Recipe Tools

| Tool | Description |
|------|-------------|
| `validate_recipe` | Check schema + optional auto-fix for simple issues |
| `get_shot_data_for_analysis` | Fetch full shot + profile data for Claude to analyze |

### Grinder Context

| Tool | Description |
|------|-------------|
| `set_grinder_context` | Save grinder model and setting for a profile (persists across sessions) |
| `get_grinder_context` | Retrieve saved grinder model and setting for one or all profiles |

---

## Example prompts

```
Generate a recipe for a washed Ethiopian light roast, 18g dose, 1:2.5 ratio, and save it to the machine.
```

```
My last shot tasted too bitter and astringent. Pull the shot data and suggest changes to the recipe.
```

```
List all profiles on my machine and show me the stages for the one named "Classic Espresso".
```

```
I want to add a 30-second blooming phase to this recipe before the ramp. [paste recipe JSON]
```

```
Fix this recipe JSON, it has validation errors. [paste broken JSON]
```

---

## Recipe Schema Reference

The Meticulous machine uses a precise JSON profile format. Claude knows this schema and will generate valid profiles automatically.

Key rules:
- `name`, `id` (UUID v4), `author`, `author_id` (UUID v4) — all required
- `temperature` — Celsius (88-96 typical)
- `final_weight` — yield in grams
- `stages` — array of extraction phases, each with `type` (`"flow"` or `"pressure"`), `dynamics.points` (`[[time_sec, value], ...]`), and `exit_triggers`
- Last stage must exit on `weight` = `final_weight`
- `previous_authors` and `variables` — required arrays (can be empty `[]`)

`save_profile` and `load_profile` validate the schema automatically before sending to the machine.

---

## Project Structure

```
meticulous-mcp-server/
├── src/
│   └── index.ts      # All MCP tools
├── dist/             # Compiled output (after npm run build)
├── package.json
├── tsconfig.json
└── README.md
```
