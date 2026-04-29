import { describe, expect, it } from "vitest";
import type { PolicyUiState } from "../dist/tui.js";
import { detectPolicyTransitions } from "../dist/tui.js";

function state(overrides: Partial<PolicyUiState> = {}): PolicyUiState {
  return {
    mode: "online",
    lock: false,
    wrapUpActive: false,
    wrapUpMode: null,
    remainingMinutes: null,
    ...overrides,
  };
}

describe("detectPolicyTransitions", () => {
  it("returns no transitions on initial snapshot", () => {
    expect(detectPolicyTransitions(null, state())).toEqual([]);
  });

  it("reports mode change", () => {
    const messages = detectPolicyTransitions(state({ mode: "online" }), state({ mode: "busy" }));
    expect(messages).toContain("HeadsDown mode changed to BUSY.");
  });

  it("reports lock enablement", () => {
    const messages = detectPolicyTransitions(state({ lock: false }), state({ lock: true }));
    expect(messages.some((message) => message.includes("lock is enabled"))).toBe(true);
  });

  it("reports wrap-up activation with timing", () => {
    const messages = detectPolicyTransitions(
      state({ wrapUpActive: false }),
      state({ wrapUpActive: true, remainingMinutes: 10, wrapUpMode: "wrap_up" }),
    );
    expect(messages).toContain("Wrap-Up guidance is active (10 minutes remaining).");
  });
});
