#!/usr/bin/env node

/**
 * Meticulous Espresso MCP Server
 *
 * A Model Context Protocol server that gives Claude full control over
 * your Meticulous home espresso machine — recipe generation, shot history,
 * machine control, and profile management.
 *
 * No API key required. Claude (Desktop or Code) handles all AI reasoning;
 * this server handles all machine communication.
 *
 * Environment variables:
 *   METICULOUS_IP  - IP of your Meticulous machine on your local network (required)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Api from "@meticulous-home/espresso-api";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

type ApiConstructor = new (options?: unknown, base_url?: string) => any;
const ApiClient = (Api as unknown as { default?: ApiConstructor }).default ?? (Api as unknown as ApiConstructor);

// ============================================================
// CONFIG & CLIENTS
// ============================================================

const MACHINE_IP = process.env.METICULOUS_IP || process.env.MACHINE_IP;
if (!MACHINE_IP) {
  console.error(
    "Error: METICULOUS_IP environment variable is required.\n" +
    "Set it to your machine's local IP address, e.g.:\n" +
    "  export METICULOUS_IP=192.168.1.x"
  );
  process.exit(1);
}

const BASE_URL = MACHINE_IP.startsWith("http")
  ? MACHINE_IP
  : `http://${MACHINE_IP}`;

// Fresh Api instance per call — avoids stale socket state
const getApi = () => new ApiClient(undefined, BASE_URL);

// ============================================================
// RECIPE SCHEMA REFERENCE
//
// When generating or modifying profiles, Claude should follow
// these rules. They are also embedded in the tool descriptions
// for save_profile and load_profile.
//
// Required top-level fields:
//   version: 1
//   name: string
//   id: UUID v4
//   author: string
//   author_id: UUID v4
//   temperature: number (Celsius, 88-96 typical)
//   final_weight: number (yield grams, e.g. 36)
//   previous_authors: []
//   variables: []
//   stages: array (non-empty)
//
// Each stage:
//   name, key, type ("flow" | "pressure")
//   dynamics.points: [[time_sec, value], ...]  — starts at [0, x]
//   dynamics.over: "time"
//   dynamics.interpolation: "linear" | "curve"
//   exit_triggers: array (non-empty)
//   limits: optional safety caps
//
// Last stage MUST exit on: { type: "weight", value: <final_weight> }
// ============================================================

// ============================================================
// RECIPE VALIDATION & REPAIR
// ============================================================

function validateProfile(profile: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!profile.name || typeof profile.name !== "string")
    errors.push("Missing or invalid 'name' (must be a non-empty string)");
  if (!profile.id || typeof profile.id !== "string")
    errors.push("Missing or invalid 'id' (must be a UUID string)");
  if (!profile.author || typeof profile.author !== "string")
    errors.push("Missing or invalid 'author'");
  if (!profile.author_id || typeof profile.author_id !== "string")
    errors.push("Missing or invalid 'author_id' (must be a UUID string)");
  if (typeof profile.temperature !== "number" || profile.temperature <= 0)
    errors.push("Missing or invalid 'temperature' (must be a positive number)");
  if (typeof profile.final_weight !== "number" || profile.final_weight <= 0)
    errors.push("Missing or invalid 'final_weight' (must be a positive number)");

  if (!Array.isArray(profile.stages) || (profile.stages as unknown[]).length === 0) {
    errors.push("'stages' must be a non-empty array");
  } else {
    (profile.stages as Record<string, unknown>[]).forEach((stage, i) => {
      const prefix = `Stage[${i}] "${stage.name || "unnamed"}"`;
      if (!stage.name) errors.push(`${prefix}: missing 'name'`);
      if (!stage.key) errors.push(`${prefix}: missing 'key'`);
      if (!["flow", "pressure"].includes(stage.type as string))
        errors.push(`${prefix}: 'type' must be "flow" or "pressure"`);

      const dyn = stage.dynamics as Record<string, unknown> | undefined;
      if (!dyn || !Array.isArray(dyn.points) || (dyn.points as unknown[]).length === 0)
        errors.push(`${prefix}: 'dynamics.points' must be a non-empty array`);
      if (dyn && dyn.over !== "time")
        errors.push(`${prefix}: 'dynamics.over' must be "time"`);

      if (!Array.isArray(stage.exit_triggers) || (stage.exit_triggers as unknown[]).length === 0)
        errors.push(`${prefix}: 'exit_triggers' must be a non-empty array`);
    });

    // Last stage must exit on weight
    const lastStage = (profile.stages as Record<string, unknown>[]).at(-1);
    const triggers = lastStage?.exit_triggers as Record<string, unknown>[] | undefined;
    const hasWeightExit = triggers?.some((t) => t.type === "weight");
    if (!hasWeightExit)
      errors.push("Last stage must have an exit_trigger of type 'weight' equal to final_weight");
  }

  return { valid: errors.length === 0, errors };
}

// Fills in structurally missing fields that don't require human judgment
function repairProfile(profile: Record<string, unknown>): Record<string, unknown> {
  if (!profile.id) profile.id = randomUUID();
  if (!profile.author_id) profile.author_id = randomUUID();
  if (!profile.author) profile.author = "AI Generated";
  if (!Array.isArray(profile.previous_authors)) profile.previous_authors = [];
  if (!Array.isArray(profile.variables)) profile.variables = [];
  if (profile.version === undefined) profile.version = 1;
  return profile;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function downsample<T>(items: T[], maxPoints: number): T[] {
  if (maxPoints <= 0 || items.length <= maxPoints) return items;
  if (maxPoints === 1) return [items[items.length - 1]];

  const sampled: T[] = [];
  const step = (items.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(items[Math.round(i * step)]);
  }
  return sampled;
}

function buildShotSummary(
  shotData: Record<string, unknown>,
  options?: { includeTrace?: boolean; maxTracePoints?: number }
): Record<string, unknown> {
  const includeTrace = options?.includeTrace ?? true;
  const maxTracePoints = options?.maxTracePoints ?? 80;

  const rows = Array.isArray(shotData.data) ? (shotData.data as Record<string, unknown>[]) : [];
  const firstRow = rows[0] ?? {};
  const lastRow = rows.at(-1) ?? {};
  const firstShot = (firstRow.shot ?? {}) as Record<string, unknown>;
  const lastShot = (lastRow.shot ?? {}) as Record<string, unknown>;
  const profile = (shotData.profile ?? {}) as Record<string, unknown>;

  const summary: Record<string, unknown> = {
    id: shotData.id ?? null,
    db_key: shotData.db_key ?? null,
    name: shotData.name ?? null,
    time: shotData.time ?? null,
    time_iso:
      typeof shotData.time === "number" ? new Date((shotData.time as number) * 1000).toISOString() : null,
    file: shotData.file ?? null,
    rating: shotData.rating ?? null,
    profile: {
      id: profile.id ?? null,
      name: profile.name ?? null,
      temperature: profile.temperature ?? null,
      final_weight: profile.final_weight ?? null,
      stage_count: Array.isArray(profile.stages) ? profile.stages.length : 0,
    },
    metrics: {
      sample_count: rows.length,
      duration_s: asNumber(lastRow.time),
      profile_duration_s: asNumber(lastRow.profile_time),
      final_status: (lastRow.status as string | undefined) ?? null,
      start_pressure_bar: asNumber(firstShot.pressure),
      start_flow_ml_s: asNumber(firstShot.flow),
      start_weight_g: asNumber(firstShot.weight),
      final_pressure_bar: asNumber(lastShot.pressure),
      final_flow_ml_s: asNumber(lastShot.flow),
      final_weight_g: asNumber(lastShot.weight),
    },
  };

  if (includeTrace) {
    const trace = rows.map((row) => {
      const shot = (row.shot ?? {}) as Record<string, unknown>;
      return {
        time: asNumber(row.time),
        profile_time: asNumber(row.profile_time),
        pressure_bar: asNumber(shot.pressure),
        flow_ml_s: asNumber(shot.flow),
        weight_g: asNumber(shot.weight),
      };
    });

    summary.trace_preview = downsample(trace, maxTracePoints);
    summary.trace_points_returned = (summary.trace_preview as unknown[]).length;
    summary.trace_points_total = rows.length;
  }

  return summary;
}

// ============================================================
// MCP SERVER
// ============================================================

const PROFILE_SCHEMA_HINT = `Profile JSON must include: name (string), id (UUID v4), author (string), author_id (UUID v4), temperature (number, Celsius), final_weight (number, yield grams), previous_authors ([]), variables ([]), version (1), stages (array). Each stage needs: name, key, type ("flow"|"pressure"), dynamics.points ([[time,value],...] starting at [0,x]), dynamics.over ("time"), dynamics.interpolation ("linear"|"curve"), exit_triggers (array). Last stage must exit on {type:"weight", value:<final_weight>}.`;

const INSTRUCTIONS = `
You are connected to a Meticulous home espresso machine via MCP.

## Your role
Help the user dial in their espresso by analyzing shots, interpreting tasting feedback, and generating or tweaking recipes. You handle all the machine interaction — the user just pulls shots and tells you how they taste.

## Dial-in workflow
1. Call get_grinder_context to recall the current grinder and setting for each profile.
2. After a shot, call get_shot_data_for_analysis (or get_last_shot) to pull sensor data.
3. Combine sensor data + tasting notes to diagnose the extraction.
4. Propose specific recipe changes (temperature, pressure curve, yield, preinfusion) and explain why.
5. Use load_profile to push changes to the machine for the next shot. Save with save_profile once the user is happy.
6. Update grinder context with set_grinder_context whenever the grind setting changes.

## Recipe generation rules
- Always base new recipes on get_default_profiles or the user's existing profiles — don't invent from scratch.
- Light roasts / washed Ethiopians: lower temperature (87–90°C), gentler pressure (6–7.5 bar), longer contact time.
- Medium/dark roasts / blends: standard temperature (90–93°C), higher pressure (8–9 bar).
- Anaerobic / natural process coffees: be conservative with temperature to preserve delicate fruit notes.
- Always validate with validate_recipe before loading or saving.
- Last stage must exit on weight = final_weight.

## Tasting diagnosis cheat sheet
- Sour / sharp / thin → under-extracted: increase temperature, slow down flow, coarser grind
- Bitter / dry / harsh → over-extracted: decrease temperature, reduce pressure, finer grind or shorter yield
- Flat / no sweetness → increase extraction: finer grind, longer preinfusion, slightly higher temp
- Channeling / spiky pressure → puck issue, not a recipe issue — tell the user

## Grinder tracking
Always check grinder context at the start of a session. When the user changes grind setting, call set_grinder_context to persist it. Include current grinder/setting when discussing extraction changes.

## Profile schema key rules
- stages[].dynamics.points starts at [0, value]
- dynamics.over must be "time"
- exit_triggers must be non-empty on every stage
- Last stage exit trigger: { type: "weight", value: <final_weight> }
`.trim();

const server = new McpServer(
  {
    name: "meticulous-espresso",
    version: "1.0.0",
    description:
      "Control your Meticulous espresso machine: manage recipes, browse shot history, and control the machine. Generate and modify recipes by asking Claude — then use save_profile or load_profile to push them to the machine.",
  },
  { instructions: INSTRUCTIONS }
);

// ============================================================
// MACHINE INFO TOOLS
// ============================================================

server.tool(
  "get_device_info",
  "Get hardware info about the Meticulous machine: firmware version, model, serial number, software version, and current status.",
  {},
  async () => {
    const api = getApi();
    const res = await api.getDeviceInfo();
    if ("error" in res.data) {
      return {
        content: [{ type: "text", text: `Error: ${res.data.error} — ${res.data.description}` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "execute_action",
  "Send a control action to the machine. Actions: 'start' (begin shot), 'stop' (abort shot), 'continue' (resume), 'reset' (reset machine state), 'tare' (tare scale), 'preheat' (start heating), 'calibration' (run calibration), 'scale_master_calibration'.",
  {
    action: z
      .enum([
        "start",
        "stop",
        "continue",
        "reset",
        "tare",
        "preheat",
        "calibration",
        "scale_master_calibration",
      ])
      .describe("The action to execute on the machine"),
  },
  async ({ action }) => {
    const api = getApi();
    const res = await api.executeAction(action);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "get_settings",
  "Read the current machine settings (auto-preheat, auto-start shot, purge after shot, sounds, timezone, heating timeout, etc.). Optionally filter to a specific setting key.",
  {
    setting_name: z
      .string()
      .optional()
      .describe("Optional: specific setting key to retrieve (e.g. 'auto_preheat', 'enable_sounds')"),
  },
  async ({ setting_name }) => {
    const api = getApi();
    const res = await api.getSettings(setting_name);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "update_setting",
  "Update one or more machine settings. Pass a partial Settings object with only the keys you want to change. Available keys: auto_preheat (number), auto_purge_after_shot (bool), auto_start_shot (bool), enable_sounds (bool), heating_timeout (number), partial_retraction (number), ssh_enabled (bool), update_channel (string).",
  {
    settings: z
      .record(z.unknown())
      .describe("Partial settings object, e.g. { \"enable_sounds\": true, \"auto_preheat\": 1 }"),
  },
  async ({ settings }) => {
    const api = getApi();
    const res = await api.updateSetting(settings as Parameters<typeof api.updateSetting>[0]);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

// ============================================================
// PROFILE / RECIPE MANAGEMENT TOOLS
// ============================================================

server.tool(
  "list_profiles",
  "List all espresso profiles (recipes) currently stored on the machine. Returns an array of profile identifiers with their names and IDs.",
  {},
  async () => {
    const api = getApi();
    const res = await api.listProfiles();
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "get_all_profiles",
  "Fetch all profiles stored on the machine with full details (all stages, dynamics, triggers). Use this when you need to inspect or compare complete recipes.",
  {},
  async () => {
    const api = getApi();
    const res = await api.fetchAllProfiles();
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "get_profile",
  "Get the full details of a specific profile by its UUID.",
  {
    profile_id: z.string().describe("UUID of the profile to retrieve"),
  },
  async ({ profile_id }) => {
    const api = getApi();
    const res = await api.getProfile(profile_id);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "get_last_profile",
  "Get the most recently loaded (active) profile on the machine, along with the time it was last loaded.",
  {},
  async () => {
    const api = getApi();
    const res = await api.getLastProfile();
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "get_default_profiles",
  "Get the built-in factory profiles and community profiles that ship with the machine. Good starting points for recipe creation or modification.",
  {},
  async () => {
    const api = getApi();
    const res = await api.getDefaultProfiles();
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "load_profile",
  `Load a profile JSON onto the machine as the active recipe (temporary — use save_profile to persist). Validates the schema before sending. ${PROFILE_SCHEMA_HINT}`,
  {
    profile: z
      .record(z.unknown())
      .describe("Full profile JSON object to load onto the machine"),
  },
  async ({ profile }) => {
    const repaired = repairProfile(profile as Record<string, unknown>);
    const validation = validateProfile(repaired);
    if (!validation.valid) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot load profile — schema validation failed:\n${validation.errors.join("\n")}\n\nUse validate_recipe to check and repair the profile first.`,
          },
        ],
      };
    }

    const api = getApi();
    const res = await api.loadProfileFromJSON(repaired as Parameters<typeof api.loadProfileFromJSON>[0]);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "load_profile_by_id",
  "Activate an existing profile on the machine by its UUID (profile must already be saved on the machine).",
  {
    profile_id: z.string().describe("UUID of the profile to activate"),
  },
  async ({ profile_id }) => {
    const api = getApi();
    const res = await api.loadProfileByID(profile_id);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "save_profile",
  `Permanently save a profile to the machine's internal storage. Validates the schema before saving. ${PROFILE_SCHEMA_HINT}`,
  {
    profile: z
      .record(z.unknown())
      .describe("Full profile JSON object to save permanently on the machine"),
  },
  async ({ profile }) => {
    const repaired = repairProfile(profile as Record<string, unknown>);
    const validation = validateProfile(repaired);
    if (!validation.valid) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot save profile — schema validation failed:\n${validation.errors.join("\n")}`,
          },
        ],
      };
    }

    const api = getApi();
    const res = await api.saveProfile(repaired as Parameters<typeof api.saveProfile>[0]);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "delete_profile",
  "Delete a profile from the machine's internal storage by UUID.",
  {
    profile_id: z.string().describe("UUID of the profile to delete"),
  },
  async ({ profile_id }) => {
    const api = getApi();
    const res = await api.deleteProfile(profile_id);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

// ============================================================
// SHOT HISTORY TOOLS
// ============================================================

server.tool(
  "get_shot_history",
  "Get a listing of past espresso shots (metadata only). Shows shot name, time, profile used, and rating.",
  {},
  async () => {
    const api = getApi();
    const res = await api.getHistoryShortListing();
    const history = res.data.history;
    const summary = history.map((h) => ({
      db_key: h.db_key,
      id: h.id,
      name: h.name,
      time: new Date(h.time * 1000).toISOString(),
      profile_name: h.profile?.name,
      profile_id: h.profile?.id,
      rating: h.rating ?? "unrated",
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

server.tool(
  "search_history",
  "Search shot history with flexible filters. All parameters are optional.",
  {
    query: z.string().optional().describe("Text search query (searches profile name)"),
    start_date: z.string().optional().describe("ISO date string for start of range, e.g. '2025-01-01'"),
    end_date: z.string().optional().describe("ISO date string for end of range, e.g. '2025-12-31'"),
    order_by: z.array(z.enum(["profile", "date"])).optional().describe("Sort fields"),
    sort: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort direction"),
    max_results: z.number().optional().default(20).describe("Maximum number of results to return"),
    include_data: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include full sensor data arrays (pressure, flow, weight per time). Warning: large response."),
  },
  async ({ query, start_date, end_date, order_by, sort, max_results, include_data }) => {
    const api = getApi();
    const params: Record<string, unknown> = {
      sort: sort ?? "desc",
      max_results: max_results ?? 20,
      dump_data: include_data ?? false,
    };
    if (query) params.query = query;
    if (start_date) params.start_date = start_date;
    if (end_date) params.end_date = end_date;
    if (order_by) params.order_by = order_by;

    const res = await api.searchHistory(params as Parameters<typeof api.searchHistory>[0]);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "get_current_shot",
  "Get data for the shot currently being brewed (returns null if no shot is in progress). Defaults to a compact summary to avoid huge responses.",
  {
    verbosity: z
      .enum(["summary", "full"])
      .optional()
      .default("summary")
      .describe("'summary' (default) returns compact metadata and sampled trace; 'full' returns raw shot payload."),
    max_points: z
      .number()
      .optional()
      .default(40)
      .describe("Maximum number of points in summary trace preview."),
  },
  async ({ verbosity, max_points }) => {
    const api = getApi();
    const res = await api.getCurrentShot();
    if (!res.data) {
      return {
        content: [{ type: "text", text: "No shot currently in progress. Machine is idle." }],
      };
    }

    if (verbosity === "full") {
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }

    const summary = buildShotSummary(res.data as Record<string, unknown>, {
      includeTrace: true,
      maxTracePoints: max_points ?? 40,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

server.tool(
  "get_last_shot",
  "Get the most recently completed shot. Defaults to a compact summary to avoid token overflow.",
  {
    verbosity: z
      .enum(["summary", "full"])
      .optional()
      .default("summary")
      .describe("'summary' (default) returns compact metadata and sampled trace; 'full' returns raw shot payload."),
    max_points: z
      .number()
      .optional()
      .default(80)
      .describe("Maximum number of points in summary trace preview."),
  },
  async ({ verbosity, max_points }) => {
    const api = getApi();
    const res = await api.getLastShot();
    if (!res.data) {
      return {
        content: [{ type: "text", text: "No shots found in history." }],
      };
    }

    if (verbosity === "full") {
      return {
        content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
      };
    }

    const summary = buildShotSummary(res.data as Record<string, unknown>, {
      includeTrace: true,
      maxTracePoints: max_points ?? 80,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

server.tool(
  "get_shot_statistics",
  "Get aggregate statistics: total shots pulled, shots per profile, and profile version counts.",
  {},
  async () => {
    const api = getApi();
    const res = await api.getHistoryStatistics();
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "rate_shot",
  "Rate a completed shot as 'like', 'dislike', or null (remove rating). Use db_key from shot history.",
  {
    shot_db_key: z
      .number()
      .describe("The db_key of the shot to rate (from shot history listing)"),
    rating: z
      .enum(["like", "dislike"])
      .nullable()
      .describe("'like', 'dislike', or null to remove an existing rating"),
  },
  async ({ shot_db_key, rating }) => {
    const api = getApi();
    const res = await api.rateShot(shot_db_key, rating);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "search_historical_profiles",
  "Search for historical versions of profiles by name. Useful for finding old recipe iterations.",
  {
    query: z.string().describe("Profile name or partial name to search for"),
  },
  async ({ query }) => {
    const api = getApi();
    const res = await api.searchHistoricalProfiles(query);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

// ============================================================
// RECIPE TOOLS
// ============================================================

server.tool(
  "validate_recipe",
  "Validate a recipe JSON against the Meticulous profile schema. Returns a list of errors if invalid. If auto_fix is true, automatically fills in simple missing fields (id, author_id, version, previous_authors, variables) — structural errors like missing stages must be corrected manually.",
  {
    recipe: z.record(z.unknown()).describe("The profile JSON to validate"),
    auto_fix: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, auto-fills simple missing fields and returns the repaired profile"),
  },
  async ({ recipe, auto_fix }) => {
    const repaired = repairProfile(recipe as Record<string, unknown>);
    const validation = validateProfile(repaired);

    if (validation.valid) {
      return {
        content: [
          {
            type: "text",
            text: `✅ Recipe "${repaired.name}" is valid and ready to load onto the machine.\n\n${JSON.stringify(repaired, null, 2)}`,
          },
        ],
      };
    }

    const errorList = validation.errors.map((e) => `• ${e}`).join("\n");

    if (!auto_fix) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Recipe has ${validation.errors.length} schema error(s):\n\n${errorList}\n\nRun again with auto_fix: true to repair simple issues, or correct structural errors manually.`,
          },
        ],
      };
    }

    // Re-validate after repair to see if auto-fix resolved everything
    const revalidation = validateProfile(repaired);
    if (revalidation.valid) {
      return {
        content: [
          {
            type: "text",
            text: `✅ Recipe repaired and valid: "${repaired.name}"\n\n${JSON.stringify(repaired, null, 2)}`,
          },
        ],
      };
    }

    const remaining = revalidation.errors.map((e) => `• ${e}`).join("\n");
    return {
      content: [
        {
          type: "text",
          text: `⚠️ Auto-fix applied simple repairs, but ${revalidation.errors.length} error(s) remain that need manual correction:\n\n${remaining}\n\nPartially repaired profile:\n${JSON.stringify(repaired, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "get_shot_data_for_analysis",
  "Fetch shot data and profile for analysis. Defaults to compact output with a sampled trace to stay within chat context limits.",
  {
    shot_db_key: z
      .number()
      .optional()
      .describe("db_key of the shot to fetch (from get_shot_history). If omitted, fetches the last shot."),
    verbosity: z
      .enum(["summary", "compact", "full"])
      .optional()
      .default("compact")
      .describe("'summary' returns key metadata only, 'compact' includes sampled trace, 'full' returns raw payload."),
    max_points: z
      .number()
      .optional()
      .default(120)
      .describe("Maximum number of points in compact trace preview."),
  },
  async ({ shot_db_key, verbosity, max_points }) => {
    const api = getApi();

    let shotData;
    if (shot_db_key) {
      const res = await api.searchHistory({ ids: [shot_db_key], dump_data: true });
      shotData = res.data.history[0];
    } else {
      const res = await api.getLastShot();
      shotData = res.data;
    }

    if (!shotData) {
      return {
        content: [{ type: "text", text: "No shot data found." }],
      };
    }

    if (verbosity === "full") {
      return {
        content: [{ type: "text", text: JSON.stringify(shotData, null, 2) }],
      };
    }

    const summary = buildShotSummary(shotData as Record<string, unknown>, {
      includeTrace: verbosity !== "summary",
      maxTracePoints: max_points ?? 120,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// ============================================================
// NOTIFICATIONS TOOL
// ============================================================

server.tool(
  "get_notifications",
  "Get machine notifications (firmware updates, maintenance reminders, error messages).",
  {
    acknowledged: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, returns already-acknowledged notifications. If false, returns pending ones."),
  },
  async ({ acknowledged }) => {
    const api = getApi();
    const res = await api.getNotifications(acknowledged ?? false);
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

// ============================================================
// GRINDER CONTEXT
// ============================================================

const GRINDER_STORE_DIR = join(homedir(), ".meticulous-mcp");
const GRINDER_STORE_PATH = join(GRINDER_STORE_DIR, "grinder.json");

interface GrinderEntry {
  grinder: string;
  setting: number;
  notes?: string;
  updated: string;
}

interface GrinderStore {
  profiles: Record<string, GrinderEntry>;
}

function readGrinderStore(): GrinderStore {
  if (!existsSync(GRINDER_STORE_PATH)) return { profiles: {} };
  try {
    return JSON.parse(readFileSync(GRINDER_STORE_PATH, "utf-8")) as GrinderStore;
  } catch {
    return { profiles: {} };
  }
}

function writeGrinderStore(store: GrinderStore): void {
  if (!existsSync(GRINDER_STORE_DIR)) mkdirSync(GRINDER_STORE_DIR, { recursive: true });
  writeFileSync(GRINDER_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

server.tool(
  "set_grinder_context",
  "Save the grinder model and setting for a profile. Call this whenever you change your grind size so Claude remembers it next session.",
  {
    profile_name: z.string().describe("The profile name to associate this grinder setting with"),
    grinder: z.string().describe("Grinder model (e.g. 'DF83 V3')"),
    setting: z.number().describe("Grinder setting / number"),
    notes: z.string().optional().describe("Optional notes (e.g. 'too coarse, dropping to 10.5 next')"),
  },
  async ({ profile_name, grinder, setting, notes }) => {
    const store = readGrinderStore();
    store.profiles[profile_name] = {
      grinder,
      setting,
      ...(notes ? { notes } : {}),
      updated: new Date().toISOString().split("T")[0],
    };
    writeGrinderStore(store);
    return {
      content: [{ type: "text", text: `Saved: ${profile_name} → ${grinder} @ ${setting}${notes ? ` (${notes})` : ""}` }],
    };
  }
);

server.tool(
  "get_grinder_context",
  "Get the saved grinder model and setting for one or all profiles. Call this at the start of a session to recall where you left off.",
  {
    profile_name: z.string().optional().describe("Profile name to look up. Omit to get all profiles."),
  },
  async ({ profile_name }) => {
    const store = readGrinderStore();
    if (profile_name) {
      const entry = store.profiles[profile_name];
      if (!entry) {
        return { content: [{ type: "text", text: `No grinder context saved for "${profile_name}".` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ [profile_name]: entry }, null, 2) }] };
    }
    if (Object.keys(store.profiles).length === 0) {
      return { content: [{ type: "text", text: "No grinder context saved yet." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(store.profiles, null, 2) }] };
  }
);

// ============================================================
// START SERVER
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Meticulous MCP server started — connected to machine at ${BASE_URL}`);
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
