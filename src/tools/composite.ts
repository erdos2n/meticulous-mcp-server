/**
 * Composite MCP tools — multi-step operations that chain multiple API calls.
 *
 * These tools are intentionally separate from the atomic wrappers in server.ts.
 * Each tool here orchestrates multiple API calls and contains non-trivial logic
 * that deserves to be visible and deliberate rather than buried alongside
 * single-endpoint wrappers.
 *
 * To add a new composite tool:
 *   1. Write it here using the same server.tool() pattern.
 *   2. Export a registerCompositeTools(server, getApi, helpers) function.
 *   3. Call it once from createServer() in server.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type GetApiFn = () => any;
type ValidateProfileFn = (profile: Record<string, unknown>) => { valid: boolean; errors: string[] };
type RepairProfileFn = (profile: Record<string, unknown>) => Record<string, unknown>;

export function registerCompositeTools(
  server: McpServer,
  getApi: GetApiFn,
  validateProfile: ValidateProfileFn,
  repairProfile: RepairProfileFn
) {

  // ============================================================
  // update_profile
  //
  // Problem this solves:
  //   The Meticulous API has no PATCH/PUT endpoint for profiles.
  //   save_profile is a full overwrite — if you pass a new profile
  //   object, you lose the existing display.image (the profile photo)
  //   and risk creating a duplicate if you use a new UUID.
  //
  // What this tool does (get → merge → save):
  //   1. Fetch the existing profile by ID to capture its current state,
  //      especially display.image (which is a server-side file hash we
  //      cannot regenerate).
  //   2. Deep-merge the caller's changes on top of the fetched profile,
  //      always preserving: id, display.image, previous_authors.
  //   3. Validate the merged result.
  //   4. Save it back — same UUID = overwrite in place, not a new profile.
  // ============================================================

  server.tool(
    "update_profile",
    "Update an existing profile in place by ID. Fetches the current profile, merges your changes on top, and saves back — preserving the profile image and avoiding duplicates. Pass only the fields you want to change in `updates`; everything else is kept from the existing profile.",
    {
      profile_id: z
        .string()
        .describe("UUID of the profile to update"),
      updates: z
        .record(z.unknown())
        .describe(
          "Partial profile object with only the fields you want to change. " +
          "E.g. { \"temperature\": 91 } or { \"display\": { \"description\": \"...\" } }. " +
          "The profile id and display.image are always preserved from the existing profile."
        ),
    },
    async ({ profile_id, updates }) => {
      const api = getApi();

      // Step 1: fetch existing profile
      let existing: Record<string, unknown>;
      try {
        const res = await api.getProfile(profile_id);
        if ("error" in res.data) {
          return {
            content: [{
              type: "text",
              text: `Failed to fetch profile ${profile_id}: ${res.data.error} — ${res.data.description}`
            }],
          };
        }
        existing = res.data as Record<string, unknown>;
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Error fetching profile ${profile_id}: ${String(err)}`
          }],
        };
      }

      // Step 2: deep-merge updates onto existing profile
      // For nested objects (like display{}), merge one level deep so callers
      // can update e.g. display.description without wiping display.image.
      const merged: Record<string, unknown> = { ...existing };

      for (const [key, value] of Object.entries(updates)) {
        if (
          key === "id" ||
          key === "previous_authors"
        ) {
          // Never let the caller overwrite these — id must stay stable,
          // previous_authors is machine-managed lineage.
          continue;
        }

        if (
          key === "display" &&
          typeof value === "object" &&
          value !== null &&
          typeof existing.display === "object" &&
          existing.display !== null
        ) {
          // Shallow-merge display{} so display.image is preserved
          // unless the caller explicitly passes a new image value.
          const existingDisplay = existing.display as Record<string, unknown>;
          const incomingDisplay = value as Record<string, unknown>;
          merged.display = {
            ...existingDisplay,
            ...incomingDisplay,
            // Always keep the existing image unless caller explicitly provides one
            image: incomingDisplay.image ?? existingDisplay.image,
          };
        } else {
          merged[key] = value;
        }
      }

      // Step 3: repair + validate
      const repaired = repairProfile(merged);
      const validation = validateProfile(repaired);
      if (!validation.valid) {
        return {
          content: [{
            type: "text",
            text: `Cannot save updated profile — schema validation failed:\n${validation.errors.map(e => `• ${e}`).join("\n")}\n\nMerged (invalid) profile:\n${JSON.stringify(repaired, null, 2)}`
          }],
        };
      }

      // Step 4: save back — same UUID = overwrite in place
      try {
        const res = await api.saveProfile(repaired as Parameters<typeof api.saveProfile>[0]);
        if ("error" in res.data) {
          return {
            content: [{
              type: "text",
              text: `Profile merged and validated but save failed: ${res.data.error} — ${res.data.description}`
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: `Updated profile "${repaired.name}" (${profile_id}).\nPreserved image: ${(repaired.display as Record<string, unknown>)?.image ?? "none"}\n\n${JSON.stringify(res.data, null, 2)}`
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Error saving updated profile: ${String(err)}`
          }],
        };
      }
    }
  );
}
