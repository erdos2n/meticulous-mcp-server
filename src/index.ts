/**
 * Meticulous Espresso MCP Server
 *
 * A Model Context Protocol server that gives Claude Code full control over
 * your Meticulous home espresso machine — recipe generation, shot history,
 * machine control, and AI-powered recipe tailoring.
 *
 * Environment variables:
 *   METICULOUS_IP      - IP of your Meticulous machine (default: 192.168.5.251)
 *   ANTHROPIC_API_KEY  - Your Anthropic API key (for recipe generation/tailoring)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { z } from "zod";
import Api from "@meticulous-home/espresso-api";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";

// ============================================================
// CONFIG & CLIENTS
// ============================================================

const MACHINE_IP =
  process.env.METICULOUS_IP ||
  process.env.MACHINE_IP ||
  "192.168.5.251";

const BASE_URL = MACHINE_IP.startsWith("http")
  ? MACHINE_IP
  : `http://${MACHINE_IP}`;

// Fresh Api instance per call — avoids stale socket state
const getApi = () => new Api(undefined, BASE_URL);

// Claude client for recipe generation & tailoring
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// ============================================================
// RECIPE SCHEMA PROMPT
// This is what made Ollama fail — Claude handles it perfectly
// with this detailed, example-rich system prompt.
// ============================================================

const RECIPE_SYSTEM_PROMPT = `You are an expert barista and espresso recipe engineer for the Meticulous home espresso machine.

The machine uses a JSON "profile" to precisely control every aspect of extraction. You must generate or modify profiles that follow the EXACT schema below.

## Required JSON Structure (every field matters)

\`\`\`json
{
  "version": 1,
  "name": "Ethiopia Natural Bloom",
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "author": "AI Generated",
  "author_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "temperature": 94,
  "final_weight": 36,
  "previous_authors": [],
  "variables": [],
  "stages": [
    {
      "name": "Preinfusion",
      "key": "preinfusion",
      "type": "flow",
      "dynamics": {
        "points": [[0, 2.0], [8, 2.0]],
        "over": "time",
        "interpolation": "linear"
      },
      "exit_triggers": [
        {
          "type": "time",
          "value": 8,
          "relative": false,
          "comparison": ">="
        }
      ],
      "limits": [
        { "type": "pressure", "value": 3.0 }
      ]
    },
    {
      "name": "Ramp",
      "key": "ramp",
      "type": "pressure",
      "dynamics": {
        "points": [[0, 2.0], [10, 9.0]],
        "over": "time",
        "interpolation": "curve"
      },
      "exit_triggers": [
        { "type": "time", "value": 10, "relative": false, "comparison": ">=" }
      ]
    },
    {
      "name": "Extraction",
      "key": "extraction",
      "type": "pressure",
      "dynamics": {
        "points": [[0, 9.0], [30, 8.0]],
        "over": "time",
        "interpolation": "linear"
      },
      "exit_triggers": [
        { "type": "weight", "value": 36, "relative": false, "comparison": ">=" }
      ],
      "limits": [
        { "type": "flow", "value": 4.0 }
      ]
    }
  ]
}
\`\`\`

## STRICT Field Rules

**Top-level:**
- \`version\`: Always the number 1
- \`name\`: Human-readable descriptive name (string, required)
- \`id\`: A fresh UUID v4 — format "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx" (required)
- \`author\`: "AI Generated" unless user specifies (string, required)
- \`author_id\`: A fresh UUID v4 (required)
- \`temperature\`: Number in Celsius — 88-92 for dark roasts, 93-96 for light/medium (required)
- \`final_weight\`: Target yield in grams — typically dose × 2, common range 28-42 (required)
- \`previous_authors\`: Always an empty array \`[]\` (required)
- \`variables\`: Always an empty array \`[]\` (required)
- \`stages\`: Non-empty array of stage objects (required)

**Each Stage:**
- \`name\`: Descriptive name like "Preinfusion", "Bloom", "Ramp", "Extraction", "Decline"
- \`key\`: Lowercase slug matching the name — "preinfusion", "bloom", "ramp", "extraction", "decline"
- \`type\`: Either \`"flow"\` (ml/s control) or \`"pressure"\` (bar control)
- \`dynamics.points\`: Array of [time_seconds, value] pairs. MUST start at [0, value]. Flow 0-10 ml/s, Pressure 0-12 bar
- \`dynamics.over\`: Always \`"time"\`
- \`dynamics.interpolation\`: \`"linear"\` for straight lines, \`"curve"\` for smooth curves
- \`exit_triggers\`: Non-empty array. LAST stage MUST exit on \`"weight"\` = \`final_weight\`
- \`limits\` (optional): Safety caps — pressure limit on flow stages, flow limit on pressure stages

**Exit Triggers:**
- \`type\`: \`"time"\`, \`"weight"\`, \`"pressure"\`, or \`"flow"\`
- \`value\`: Numeric threshold
- \`relative\`: Always \`false\`
- \`comparison\`: Usually \`">="\` (exit when value reaches threshold)

## Design Principles

| Coffee | Temperature | Approach |
|--------|------------|---------|
| Light roast, washed | 94-96°C | Gentle bloom, slower extraction, flow control |
| Light roast, natural | 93-95°C | Extended preinfusion, declining pressure |
| Medium roast | 92-94°C | Classic preinfusion + pressure ramp |
| Dark roast | 88-92°C | Low temperature, avoid over-extraction |
| Espresso blend | 91-93°C | Classic Italian: fast ramp to 9 bar |

## Common Profiles

**Classic Italian:** Preinfusion (flow, 8s) → Ramp to 9 bar (10s) → Hold at 9 bar until weight
**Turbo:** Short preinfusion → Immediate 9 bar → High flow cap → Exit on weight fast
**Blooming:** Extended low-flow bloom (30-45s, very low pressure) → Ramp → Declining extraction
**Ristretto:** Lower final_weight, longer preinfusion, higher temperature

RETURN ONLY VALID JSON. No markdown. No code fences. No explanation. Just the JSON object.`;

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
    errors.push(
      "Missing or invalid 'final_weight' (must be a positive number)"
    );

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
      errors.push(
        "Last stage must have an exit_trigger of type 'weight' equal to final_weight"
      );
  }

  return { valid: errors.length === 0, errors };
}

function repairProfile(profile: Record<string, unknown>): Record<string, unknown> {
  // Auto-fill missing top-level fields
  if (!profile.id) profile.id = randomUUID();
  if (!profile.author_id) profile.author_id = randomUUID();
  if (!profile.author) profile.author = "AI Generated";
  if (!Array.isArray(profile.previous_authors)) profile.previous_authors = [];
  if (!Array.isArray(profile.variables)) profile.variables = [];
  if (profile.version === undefined) profile.version = 1;
  return profile;
}

// Call Claude for recipe generation or tailoring
async function callClaudeForRecipe(userPrompt: string): Promise<Record<string, unknown>> {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: RECIPE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text =
    response.content.find((b) => b.type === "text")?.text ?? "";

  // Extract JSON object from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `Claude did not return valid JSON. Response was:\n${text.slice(0, 500)}`
    );
  }

  let recipe: Record<string, unknown>;
  try {
    recipe = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse JSON from Claude's response: ${e}`);
  }

  // Auto-repair common omissions
  recipe = repairProfile(recipe);

  const validation = validateProfile(recipe);
  if (!validation.valid) {
    throw new Error(
      `Generated recipe has schema errors:\n${validation.errors.join("\n")}`
    );
  }

  return recipe;
}

// ============================================================
// MCP SERVER
// ============================================================

const server = new McpServer({
  name: "meticulous-espresso",
  version: "1.0.0",
  description:
    "Control your Meticulous espresso machine: generate recipes, browse shot history, tailor profiles with natural language, and manage your collection.",
});

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
      .describe(
        "Optional: specific setting key to retrieve (e.g. 'auto_preheat', 'enable_sounds')"
      ),
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
      .describe(
        "Partial settings object, e.g. { \"enable_sounds\": true, \"auto_preheat\": 1 }"
      ),
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
  "Get the built-in factory profiles and community profiles that ship with the machine. Good starting points for recipe creation.",
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
  "Load a profile JSON onto the machine as the active recipe (temporary — use save_profile to persist). The machine will use this recipe for the next shot.",
  {
    profile: z
      .record(z.unknown())
      .describe("Full profile JSON object to load onto the machine"),
  },
  async ({ profile }) => {
    // Validate before sending to avoid cryptic machine errors
    const repaired = repairProfile(profile as Record<string, unknown>);
    const validation = validateProfile(repaired);
    if (!validation.valid) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot load profile — schema validation failed:\n${validation.errors.join("\n")}\n\nUse validate_recipe to auto-fix, or generate_recipe to create a fresh one.`,
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
  "Permanently save a profile to the machine's internal storage. This persists the recipe across reboots.",
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
  "Get a short listing of past espresso shots (metadata only, no raw sensor data). Shows shot name, time, profile used, and rating.",
  {},
  async () => {
    const api = getApi();
    const res = await api.getHistoryShortListing();
    const history = res.data.history;
    // Return a clean summary
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
    query: z
      .string()
      .optional()
      .describe("Text search query (searches profile name)"),
    start_date: z
      .string()
      .optional()
      .describe("ISO date string for start of range, e.g. '2025-01-01'"),
    end_date: z
      .string()
      .optional()
      .describe("ISO date string for end of range, e.g. '2025-12-31'"),
    order_by: z
      .array(z.enum(["profile", "date"]))
      .optional()
      .describe("Sort fields"),
    sort: z
      .enum(["asc", "desc"])
      .optional()
      .default("desc")
      .describe("Sort direction"),
    max_results: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of results to return"),
    include_data: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Include full sensor data arrays (pressure, flow, weight per time). Warning: large response."
      ),
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
  "Get real-time data for the shot currently being brewed (returns null if no shot in progress). Includes pressure, flow, weight, and temperature curves.",
  {},
  async () => {
    const api = getApi();
    const res = await api.getCurrentShot();
    if (!res.data) {
      return {
        content: [
          { type: "text", text: "No shot currently in progress. Machine is idle." },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
    };
  }
);

server.tool(
  "get_last_shot",
  "Get the data from the most recently completed shot. Includes full sensor curves (pressure, flow, weight over time) and the profile used.",
  {},
  async () => {
    const api = getApi();
    const res = await api.getLastShot();
    if (!res.data) {
      return {
        content: [{ type: "text", text: "No shots found in history." }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
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
      .describe(
        "'like', 'dislike', or null to remove an existing rating"
      ),
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
    query: z
      .string()
      .describe("Profile name or partial name to search for"),
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
// AI RECIPE TOOLS (Claude-powered)
// ============================================================

server.tool(
  "generate_recipe",
  "Generate a new espresso recipe from a natural language description using Claude. Describe the coffee, desired flavor profile, brew ratio, or technique. Returns a complete, validated profile JSON ready to load onto the machine.",
  {
    description: z
      .string()
      .describe(
        "Natural language description of what you want. Examples: 'A washed Ethiopian light roast emphasizing florals and acidity, 1:2.5 ratio', 'Classic Italian espresso with a thick crema, 18g in 36g out', 'A gentle blooming profile for a natural Yirgacheffe', 'Turbo shot for a dark blend in under 25 seconds'"
      ),
    dose_grams: z
      .number()
      .optional()
      .describe("Coffee dose in grams (e.g. 18). Used to calculate yield if not specified in description."),
    yield_grams: z
      .number()
      .optional()
      .describe("Target espresso yield in grams (overrides ratio calculation)"),
  },
  async ({ description, dose_grams, yield_grams }) => {
    let prompt = description;
    if (dose_grams) prompt += `\n\nDose: ${dose_grams}g`;
    if (yield_grams) prompt += `\nTarget yield: ${yield_grams}g`;

    try {
      const recipe = await callClaudeForRecipe(prompt);
      return {
        content: [
          {
            type: "text",
            text: `Generated recipe: "${recipe.name}"\n\n${JSON.stringify(recipe, null, 2)}\n\nUse load_profile to activate this recipe on the machine, or save_profile to store it permanently.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to generate recipe: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "tailor_recipe",
  "Modify an existing espresso recipe based on natural language feedback. Describe what you want to change — flavor notes, extraction time, pressure curve, temperature, etc. Returns the updated recipe JSON.",
  {
    recipe: z
      .record(z.unknown())
      .describe("The current profile JSON to modify"),
    feedback: z
      .string()
      .describe(
        "What to change and why. Examples: 'The espresso tastes too bitter, reduce temperature by 2 degrees and shorten extraction', 'Add a longer bloom phase before the ramp', 'The shot is channeling, reduce the preinfusion flow to 1.5 ml/s', 'Make it sweeter — use a declining pressure curve in the extraction stage', 'Increase yield to 40g'"
      ),
  },
  async ({ recipe, feedback }) => {
    const currentRecipeStr = JSON.stringify(recipe, null, 2);
    const prompt = `Here is the current recipe:

\`\`\`json
${currentRecipeStr}
\`\`\`

Apply this change request and return the complete updated recipe:

${feedback}

Important:
- Keep all unchanged fields exactly as they are
- Generate a new UUID for the 'id' field since this is a modified version
- Update the 'name' to reflect the change if appropriate
- Ensure the last stage still exits on weight = final_weight
- Return ONLY the complete JSON, nothing else`;

    try {
      const updatedRecipe = await callClaudeForRecipe(prompt);
      return {
        content: [
          {
            type: "text",
            text: `Updated recipe: "${updatedRecipe.name}"\n\nChanges applied: ${feedback}\n\n${JSON.stringify(updatedRecipe, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to tailor recipe: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "validate_recipe",
  "Validate a recipe JSON against the Meticulous profile schema. Returns a list of errors if invalid, or confirms the recipe is ready to load. If auto_fix is true, attempts to repair common issues using Claude.",
  {
    recipe: z
      .record(z.unknown())
      .describe("The profile JSON to validate"),
    auto_fix: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, use Claude to repair schema errors and return a fixed version"
      ),
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
            text: `❌ Recipe has ${validation.errors.length} schema error(s):\n\n${errorList}\n\nRun again with auto_fix: true to attempt automatic repair.`,
          },
        ],
      };
    }

    // Auto-fix with Claude
    const prompt = `This espresso profile JSON has schema validation errors. Fix ALL errors and return a corrected, complete profile.

Current JSON:
\`\`\`json
${JSON.stringify(recipe, null, 2)}
\`\`\`

Errors to fix:
${errorList}

Rules:
- Preserve all existing correct data
- Only change what's needed to fix the errors
- Generate new UUIDs for any missing id/author_id fields
- Ensure every stage has exit_triggers
- Ensure the last stage exits on weight
- Return ONLY valid JSON, nothing else`;

    try {
      const fixedRecipe = await callClaudeForRecipe(prompt);
      return {
        content: [
          {
            type: "text",
            text: `Fixed recipe "${fixedRecipe.name}"\n\nErrors that were fixed:\n${errorList}\n\n${JSON.stringify(fixedRecipe, null, 2)}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Auto-fix failed: ${err instanceof Error ? err.message : String(err)}\n\nOriginal errors:\n${errorList}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "analyze_shot_and_suggest",
  "Analyze the data from a past shot and suggest recipe adjustments to improve the next extraction. Provide tasting notes or observations and get concrete recipe modifications.",
  {
    shot_db_key: z
      .number()
      .optional()
      .describe(
        "db_key of the shot to analyze (from get_shot_history). If omitted, the last shot is analyzed."
      ),
    tasting_notes: z
      .string()
      .optional()
      .describe(
        "Your tasting notes or observations. Examples: 'Too bitter and astringent', 'Sour and thin, weak body', 'Great but needed more sweetness', 'Channeled halfway through'"
      ),
    observations: z
      .string()
      .optional()
      .describe(
        "Machine observations. Examples: 'Pressure spike at 15s', 'Flow dropped at end', 'Weight target hit at 22s which is too fast'"
      ),
  },
  async ({ shot_db_key, tasting_notes, observations }) => {
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

    // Build summary of shot data for Claude (avoid sending full point array)
    const dataPoints = (shotData as Record<string, unknown> & { data?: unknown[] }).data;
    const shotSummary = {
      name: shotData.name,
      profile: (shotData as Record<string, unknown> & { profile?: { name: string; temperature: number; final_weight: number; stages: unknown[] } }).profile ? {
        name: (shotData as Record<string, unknown> & { profile: { name: string; temperature: number; final_weight: number; stages: unknown[] } }).profile.name,
        temperature: (shotData as Record<string, unknown> & { profile: { name: string; temperature: number; final_weight: number; stages: unknown[] } }).profile.temperature,
        final_weight: (shotData as Record<string, unknown> & { profile: { name: string; temperature: number; final_weight: number; stages: unknown[] } }).profile.final_weight,
        stages: (shotData as Record<string, unknown> & { profile: { name: string; temperature: number; final_weight: number; stages: unknown[] } }).profile.stages,
      } : null,
      total_data_points: Array.isArray(dataPoints) ? dataPoints.length : 0,
      // Sample key data points (start, middle, end)
      data_samples: Array.isArray(dataPoints) && dataPoints.length > 0
        ? [
            dataPoints[0],
            dataPoints[Math.floor(dataPoints.length / 4)],
            dataPoints[Math.floor(dataPoints.length / 2)],
            dataPoints[Math.floor((dataPoints.length * 3) / 4)],
            dataPoints[dataPoints.length - 1],
          ]
        : [],
    };

    const analysisPrompt = `Analyze this espresso shot and suggest specific recipe modifications.

Shot data summary:
\`\`\`json
${JSON.stringify(shotSummary, null, 2)}
\`\`\`

${tasting_notes ? `Tasting notes: ${tasting_notes}` : ""}
${observations ? `Machine observations: ${observations}` : ""}

Based on the shot data and feedback, provide:
1. A diagnosis of what went wrong or what could be improved
2. 3-5 specific, actionable recipe changes (temperature, pressure curves, preinfusion time, etc.)
3. If a profile is available above, output a complete modified profile JSON with your suggested changes applied

Be specific and technical. Reference actual values (e.g., "reduce temperature from 94°C to 92°C", "extend preinfusion from 8s to 12s at 1.5 ml/s").

If outputting a modified profile, put it in a JSON code block.`;

    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: `You are an expert espresso technician and barista with deep knowledge of extraction theory and the Meticulous machine's profile system. Give precise, actionable advice. ${RECIPE_SYSTEM_PROMPT}`,
      messages: [{ role: "user", content: analysisPrompt }],
    });

    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    return {
      content: [{ type: "text", text }],
    };
  }
);

// ============================================================
// NOTIFICATIONS TOOL
// ============================================================

server.tool(
  "get_notifications",
  "Get machine notifications. Notifications may include firmware update alerts, maintenance reminders, or error messages.",
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
// START SERVER
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`Meticulous MCP server started — connected to machine at ${BASE_URL}`);
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
