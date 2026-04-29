import { describe, expect, it } from "vitest";
import type { Contract } from "@headsdown/sdk";
import { evaluateGate, isModificationTool } from "../dist/policy.js";

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
    ...overrides
  };
}

describe("isModificationTool", () => {
  it("flags file edit tools as modification tools", () => {
    expect(isModificationTool("edit", {})).toBe(true);
    expect(isModificationTool("write", {})).toBe(true);
    expect(isModificationTool("apply_patch", {})).toBe(true);
  });

  it("treats read-like bash commands as non-modifying", () => {
    expect(isModificationTool("bash", { command: "git status --short" })).toBe(false);
    expect(isModificationTool("bash", { command: "rg HeadsDown src" })).toBe(false);
  });

  it("treats mutating bash commands as modifying", () => {
    expect(isModificationTool("bash", { command: "git commit -m \"x\"" })).toBe(true);
    expect(isModificationTool("bash", { command: "npm install" })).toBe(true);
  });
});

describe("evaluateGate", () => {
  it("allows modification tools when no contract exists", () => {
    const result = evaluateGate({
      toolName: "edit",
      toolArgs: {},
      contract: null,
      hasApprovedProposal: false
    });
    expect(result.action).toBe("allow");
  });

  it("denies busy mode without approved proposal", () => {
    const result = evaluateGate({
      toolName: "edit",
      toolArgs: {},
      contract: contract("busy", { statusText: "Deep work" }),
      hasApprovedProposal: false
    });
    expect(result.action).toBe("deny");
    if (result.action === "deny") {
      expect(result.reason).toContain("BUSY");
      expect(result.reason).toContain("headsdown_approve");
    }
  });

  it("allows busy mode with approved proposal", () => {
    const result = evaluateGate({
      toolName: "edit",
      toolArgs: {},
      contract: contract("busy"),
      hasApprovedProposal: true
    });
    expect(result.action).toBe("allow");
  });

  it("denies offline mode without approved proposal", () => {
    const result = evaluateGate({
      toolName: "edit",
      toolArgs: {},
      contract: contract("offline"),
      hasApprovedProposal: false
    });
    expect(result.action).toBe("deny");
    if (result.action === "deny") {
      expect(result.reason).toContain("OFFLINE");
      expect(result.reason).toContain("explicit permission");
    }
  });

  it("denies offline mode even with approved proposal", () => {
    const result = evaluateGate({
      toolName: "edit",
      toolArgs: {},
      contract: contract("offline"),
      hasApprovedProposal: true
    });
    expect(result.action).toBe("deny");
  });

  it("denies locked contracts without approved proposal", () => {
    const result = evaluateGate({
      toolName: "edit",
      toolArgs: {},
      contract: contract("limited", { lock: true }),
      hasApprovedProposal: false
    });
    expect(result.action).toBe("deny");
  });
});
