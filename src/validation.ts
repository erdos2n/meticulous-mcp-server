/**
 * Meticulous MCP Server — Profile Validation
 *
 * Extracted from server.ts so tests can import without
 * pulling in MCP server dependencies or requiring a machine connection.
 */

import { randomUUID } from "crypto";

// UUIDs must be strictly hex (0-9, a-f).
// Non-hex chars like 'g' produce profiles the machine stores
// but cannot retrieve or delete via the API.
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateProfile(profile: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!profile.name || typeof profile.name !== "string")
    errors.push("Missing or invalid 'name' (must be a non-empty string)");
  if (!profile.id || typeof profile.id !== "string" || !UUID_REGEX.test(profile.id as string))
    errors.push("Missing or invalid 'id' (must be a valid UUID — hex chars 0-9 and a-f only)");
  if (!profile.author || typeof profile.author !== "string")
    errors.push("Missing or invalid 'author'");
  if (!profile.author_id || typeof profile.author_id !== "string" || !UUID_REGEX.test(profile.author_id as string))
    errors.push("Missing or invalid 'author_id' (must be a valid UUID — hex chars 0-9 and a-f only)");
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

    const lastStage = (profile.stages as Record<string, unknown>[]).at(-1);
    const triggers = lastStage?.exit_triggers as Record<string, unknown>[] | undefined;
    const hasWeightExit = triggers?.some((t) => t.type === "weight");
    if (!hasWeightExit)
      errors.push("Last stage must have an exit_trigger of type 'weight' equal to final_weight");
  }

  return { valid: errors.length === 0, errors };
}

export function repairProfile(profile: Record<string, unknown>): Record<string, unknown> {
  if (!profile.id || typeof profile.id !== "string" || !UUID_REGEX.test(profile.id as string)) {
    profile.id = randomUUID();
  }
  if (!profile.author_id || typeof profile.author_id !== "string" || !UUID_REGEX.test(profile.author_id as string)) {
    profile.author_id = randomUUID();
  }
  if (!profile.author) profile.author = "AI Generated";
  if (!Array.isArray(profile.previous_authors)) profile.previous_authors = [];
  if (!Array.isArray(profile.variables)) profile.variables = [];
  if (profile.version === undefined) profile.version = 1;
  return profile;
}
