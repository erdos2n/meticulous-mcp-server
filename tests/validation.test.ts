/**
 * Basic validation tests for Meticulous MCP profile schema.
 *
 * These run without a machine connection — pure unit tests.
 * Run with: npm test
 */

import { describe, it, expect } from "vitest";
import { validateProfile, repairProfile, UUID_REGEX } from "../src/validation.js";

// Minimal valid profile used as a baseline across tests
const validProfile = () => ({
  name: "Test Profile",
  id: "550e8400-e29b-41d4-a716-446655440000",
  author: "Rafael",
  author_id: "c1d2e3f4-a5b6-7890-cdef-1234567890ab",
  temperature: 90,
  final_weight: 32,
  version: 1,
  previous_authors: [],
  variables: [],
  stages: [
    {
      name: "Pre-infusion",
      key: "flow_0",
      type: "pressure",
      dynamics: {
        points: [[0, 2], [8, 2]],
        over: "time",
        interpolation: "linear",
      },
      exit_triggers: [{ type: "weight", value: 32, comparison: ">=", relative: false }],
    },
  ],
});

// ============================================================
// TEST 1: UUID validation rejects non-hex characters
// This is the exact bug that caused a corrupt profile on the machine
// when a UUID containing 'g' was accepted and saved.
// ============================================================
describe("UUID validation", () => {
  it("rejects a UUID containing non-hex characters (e.g. 'g')", () => {
    const profile = validProfile();
    profile.id = "b5c8d2e1-9f4a-4b8c-a7d6-3f2e1g0b9c8d"; // 'g' is invalid
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("'id'"))).toBe(true);
  });

  it("accepts a valid lowercase hex UUID", () => {
    const profile = validProfile();
    const result = validateProfile(profile);
    expect(result.valid).toBe(true);
  });

  it("auto-repair replaces a bad UUID with a valid one", () => {
    const profile = validProfile();
    profile.id = "b5c8d2e1-9f4a-4b8c-a7d6-3f2e1g0b9c8d";
    const repaired = repairProfile(profile);
    expect(UUID_REGEX.test(repaired.id as string)).toBe(true);
    expect(repaired.id).not.toBe("b5c8d2e1-9f4a-4b8c-a7d6-3f2e1g0b9c8d");
  });
});

// ============================================================
// TEST 2: Stage exit trigger validation
// Every stage must have at least one exit trigger, and the
// last stage must exit on weight.
// ============================================================
describe("Stage exit trigger validation", () => {
  it("rejects a stage with no exit triggers", () => {
    const profile = validProfile();
    (profile.stages[0] as any).exit_triggers = [];
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exit_triggers"))).toBe(true);
  });

  it("rejects when last stage does not exit on weight", () => {
    const profile = validProfile();
    (profile.stages[0] as any).exit_triggers = [{ type: "time", value: 30 }];
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("weight"))).toBe(true);
  });

  it("accepts a stage with a valid weight exit trigger", () => {
    const profile = validProfile();
    const result = validateProfile(profile);
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// TEST 3: Required top-level fields
// ============================================================
describe("Required field validation", () => {
  it("rejects a profile with no name", () => {
    const profile = validProfile();
    (profile as any).name = "";
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects a profile with temperature of 0", () => {
    const profile = validProfile();
    (profile as any).temperature = 0;
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("temperature"))).toBe(true);
  });

  it("rejects a profile with empty stages array", () => {
    const profile = validProfile();
    (profile as any).stages = [];
    const result = validateProfile(profile);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("stages"))).toBe(true);
  });
});
