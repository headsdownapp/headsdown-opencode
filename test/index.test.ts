import { describe, expect, it } from "vitest";
import type { Contract, ScheduleResolution } from "@headsdown/sdk";
import { shouldDisableAutoContinue } from "../src/index.js";

function contract(mode: Contract["mode"], overrides: Partial<Contract> = {}): Contract {
  return {
    id: "contract_123",
    mode,
    status: true,
    statusEmoji: "🔒",
    statusText: null,
    autoRespond: true,
    lock: false,
    duration: 60,
    ruleSetType: null,
    ruleSetParams: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    insertedAt: new Date().toISOString(),
    ...overrides,
  };
}

function availability(overrides: Partial<ScheduleResolution> = {}): ScheduleResolution {
  return {
    inReachableHours: true,
    activeWindow: null,
    nextWindow: null,
    nextTransitionAt: null,
    wrapUpGuidance: null,
    ...overrides,
  };
}

describe("shouldDisableAutoContinue", () => {
  it("returns false when no snapshot is available", () => {
    expect(shouldDisableAutoContinue(null)).toBe(false);
  });

  it("disables auto-continue when contract is locked", () => {
    const snapshot = {
      contract: contract("limited", { lock: true }),
      availability: availability(),
      summary: "",
      wrapUpInstruction: null,
      fetchedAt: Date.now(),
    };

    expect(shouldDisableAutoContinue(snapshot)).toBe(true);
  });

  it("disables auto-continue for wrap_up mode guidance", () => {
    const snapshot = {
      contract: contract("busy"),
      availability: availability({
        wrapUpGuidance: {
          active: true,
          selectedMode: "wrap_up",
          remainingMinutes: 12,
          reason: "Focus window ending",
          hints: ["Finish current task"],
        },
      }),
      summary: "",
      wrapUpInstruction: "Finish with handoff notes.",
      fetchedAt: Date.now(),
    };

    expect(shouldDisableAutoContinue(snapshot)).toBe(true);
  });

  it("keeps auto-continue enabled for full_depth guidance", () => {
    const snapshot = {
      contract: contract("busy"),
      availability: availability({
        wrapUpGuidance: {
          active: true,
          selectedMode: "full_depth",
          remainingMinutes: 45,
          reason: null,
          hints: [],
        },
      }),
      summary: "",
      wrapUpInstruction: "Proceed with full depth.",
      fetchedAt: Date.now(),
    };

    expect(shouldDisableAutoContinue(snapshot)).toBe(false);
  });
});
