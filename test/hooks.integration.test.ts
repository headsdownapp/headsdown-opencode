import { describe, expect, it } from "vitest";
import type { Contract, ScheduleResolution } from "@headsdown/sdk";
import type { Permission } from "@opencode-ai/sdk";
import {
  applyPermissionPolicy,
  applyPolicyToChatHeaders,
  applyPolicyToChatParams,
  applyPolicyToShellEnv,
  buildToolExecutionMetadata,
  type ChatHeadersOutput,
  type ChatParamsOutput,
  type PolicySnapshot,
  type ShellEnvOutput,
} from "../dist/index.js";

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

function snapshot(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  const defaultContract = contract("online");
  return {
    contract: defaultContract,
    availability: availability(),
    summary: "Mode: online",
    wrapUpInstruction: null,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

function permission(metadata: Record<string, unknown>): Permission {
  return {
    id: "perm_1",
    type: "tool.execute",
    sessionID: "sess_1",
    messageID: "msg_1",
    callID: "call_1",
    title: "Run tool",
    metadata,
    time: {
      created: Date.now(),
    },
  };
}

describe("policy hook integration helpers", () => {
  it("denies modifying permission requests in busy mode without approved proposal", () => {
    const output = { status: "allow" as const | "ask" | "deny" };
    applyPermissionPolicy({
      permission: permission({ tool: "edit", args: { filePath: "src/index.ts" } }),
      snapshot: snapshot({ contract: contract("busy") }),
      hasApprovedProposal: false,
      output,
    });

    expect(output.status).toBe("deny");
  });

  it("marks unknown permission requests as ask when contract is locked", () => {
    const output = { status: "allow" as const | "ask" | "deny" };
    applyPermissionPolicy({
      permission: permission({ random: "value" }),
      snapshot: snapshot({ contract: contract("limited", { lock: true }) }),
      hasApprovedProposal: true,
      output,
    });

    expect(output.status).toBe("ask");
  });

  it("applies wrap-up chat parameter constraints and structured options", () => {
    const output: ChatParamsOutput = {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: undefined,
      options: {},
    };

    applyPolicyToChatParams(
      snapshot({
        contract: contract("busy"),
        availability: availability({
          wrapUpGuidance: {
            active: true,
            selectedMode: "wrap_up",
            remainingMinutes: 8,
            reason: "Meeting soon",
            hints: ["Prefer minimal edits"],
          },
        }),
      }),
      output,
    );

    expect(output.temperature).toBe(0.2);
    expect(output.topP).toBe(0.8);
    expect(output.options.headsdown.mode).toBe("busy");
    expect(output.options.headsdown.wrapUp.selectedMode).toBe("wrap_up");
  });

  it("writes headers and shell env for policy-aware downstream integrations", () => {
    const snap = snapshot({
      contract: contract("limited", { lock: true }),
      availability: availability({
        wrapUpGuidance: {
          active: true,
          selectedMode: "wrap_up",
          remainingMinutes: 12,
          reason: null,
          hints: [],
        },
      }),
    });

    const headers: ChatHeadersOutput = { headers: {} };
    const env: ShellEnvOutput = { env: {} };

    applyPolicyToChatHeaders(snap, headers);
    applyPolicyToShellEnv(snap, env);

    expect(headers.headers["x-headsdown-mode"]).toBe("limited");
    expect(headers.headers["x-headsdown-lock"]).toBe("1");
    expect(headers.headers["x-headsdown-wrapup"]).toBe("wrap_up");

    expect(env.env.HEADSDOWN_MODE).toBe("limited");
    expect(env.env.HEADSDOWN_LOCKED).toBe("1");
    expect(env.env.HEADSDOWN_WRAPUP_ACTIVE).toBe("1");
    expect(env.env.HEADSDOWN_WRAPUP_MINUTES).toBe("12");
  });

  it("builds tool execution metadata for telemetry", () => {
    const meta = buildToolExecutionMetadata({
      snapshot: snapshot({ contract: contract("offline", { lock: true }) }),
      hasApprovedProposal: false,
    });
    expect(meta.mode).toBe("offline");
    expect(meta.lock).toBe(true);
    expect(meta.hasApprovedProposal).toBe(false);
  });
});
