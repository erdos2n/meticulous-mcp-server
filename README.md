# Meticulous Espresso MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude Code full control over your Meticulous home espresso machine.

## What it does

- **Generate recipes** from natural language ("a gentle blooming profile for a washed Ethiopian")
- **Tailor recipes** based on feedback ("too bitter, reduce temperature and shorten extraction")
- **Browse shot history** with filtering and analysis
- **Analyze shots** and get concrete recipe improvement suggestions
- **Manage profiles** on the machine (list, load, save, delete)
- **Control the machine** (start, stop, tare, preheat)
- **Fix broken recipes** — auto-repairs malformed JSON against the official schema

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/meticulous-mcp-server.git
cd meticulous-mcp-server
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `METICULOUS_IP` | **Yes** | IP address of your Meticulous machine on your local network |
| `ANTHROPIC_API_KEY` | Yes (for AI tools) | Your Anthropic API key — get one at [console.anthropic.com](https://console.anthropic.com) |

### 4. Add to Claude Code

Add to your `~/.claude/claude_code_config.json` (or wherever your Claude Code MCP config lives):

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "node",
      "args": ["/absolute/path/to/meticulous-mcp-server/dist/index.js"],
      "env": {
        "METICULOUS_IP": "192.168.1.x",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Or run directly from source during development (no build needed):

```json
{
  "mcpServers": {
    "meticulous": {
      "command": "npx",
      "args": [
        "tsx",
        "/absolute/path/to/meticulous-mcp-server/src/index.ts"
      ],
      "env": {
        "METICULOUS_IP": "192.168.1.x",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Then restart Claude Code. You should see the meticulous server in your MCP list.

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

### AI Recipe Tools

| Tool | Description |
|------|-------------|
| `generate_recipe` | Natural language → validated profile JSON |
| `tailor_recipe` | Modify a recipe based on feedback |
| `validate_recipe` | Check schema + optional auto-fix |
| `analyze_shot_and_suggest` | Shot data + tasting notes → recipe improvements |

---

## Example Claude Code prompts

```
Generate a recipe for a washed Ethiopian light roast, 18g dose, 1:2.5 ratio.
```

```
My last shot tasted too bitter and astringent. Analyze it and suggest changes to the recipe.
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

The Meticulous machine uses a precise JSON profile format. Key rules:

- `name`, `id` (UUID v4), `author`, `author_id` (UUID v4) — all required
- `temperature` — Celsius (88-96 typical)
- `final_weight` — yield in grams
- `stages` — array of extraction phases:
  - `type`: `"flow"` (ml/s) or `"pressure"` (bar)
  - `dynamics.points`: `[[time_sec, value], ...]` — control curve
  - `exit_triggers` — required, last stage must exit on `weight`
- `previous_authors` and `variables` — required arrays (can be empty `[]`)

The AI tools enforce this schema automatically and validate before loading to the machine.

---

## Project Structure

```
meticulous-mcp-server/
├── src/
│   └── index.ts      # All 20 MCP tools
├── dist/             # Compiled output (after npm run build)
├── package.json
├── tsconfig.json
└── README.md
```
