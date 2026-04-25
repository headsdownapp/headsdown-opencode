import * as HeadsDownSDK from "@headsdown/sdk";
import { CalibrationTracker, ConfigStore, HeadsDownClient, ProposalStateStore } from "@headsdown/sdk";
import type { Contract, ScheduleResolution, Verdict } from "@headsdown/sdk";
import type { Permission } from "@opencode-ai/sdk";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { evaluateGate, isModificationTool } from "./policy.js";

const POLICY_CACHE_TTL_MS = 15_000;

export type PolicySnapshot = {
  contract: Contract | null;
  availability: ScheduleResolution;
  summary: string;
  wrapUpInstruction: string | null;
  fetchedAt: number;
};

export type ChatParamsOutput = {
  temperature: number;
  topP: number;
  topK: number;
  maxOutputTokens: number | undefined;
  options: Record<string, any>;
};

export type ChatHeadersOutput = {
  headers: Record<string, string>;
};

export type ShellEnvOutput = {
  env: Record<string, string>;
};

type CacheEntry = {
  expiresAt: number;
  snapshot: PolicySnapshot;
};

function authErrorMessage(): string {
  return "HeadsDown is not authenticated. Run headsdown_auth first.";
}

async function getAuthenticatedClient(): Promise<HeadsDownClient> {
  try {
    return await HeadsDownClient.fromCredentials();
  } catch {
    throw new Error(authErrorMessage());
  }
}

function resolveExecutionInstruction(input: {
  contract?: Contract | null;
  schedule?: ScheduleResolution | null;
  verdict?: Pick<Verdict, "decision" | "reason" | "wrapUpGuidance"> | null;
}): string | null {
  const describeExecutionDirective = (
    HeadsDownSDK as unknown as {
      describeExecutionDirective?: (value: {
        contract?: Contract | null;
        schedule?: ScheduleResolution | null;
        verdict?: Pick<Verdict, "decision" | "reason" | "wrapUpGuidance"> | null;
      }) => { primaryDirective?: string };
    }
  ).describeExecutionDirective;

  if (typeof describeExecutionDirective === "function") {
    const directive = describeExecutionDirective(input);
    return directive.primaryDirective ?? null;
  }

  const guidance = input.verdict?.wrapUpGuidance ?? input.schedule?.wrapUpGuidance;
  if (!guidance || !guidance.active) {
    return null;
  }

  let instruction = "";
  if (guidance.selectedMode === "wrap_up") {
    instruction =
      "Execution policy for this task: keep scope minimal, avoid starting new refactors, finish the current slice cleanly, and include clear handoff notes for deferred work.";
  } else if (guidance.selectedMode === "full_depth") {
    instruction =
      "Execution policy for this task: proceed with full implementation depth, include robust validation and tests, and do not shrink scope only because a deadline is near.";
  } else {
    instruction =
      "Execution policy for this task: follow the provided context to balance scope and depth, stay focused on the requested outcome, and avoid unnecessary expansion.";
  }

  const context: string[] = [];

  if (typeof guidance.remainingMinutes === "number") {
    context.push(`About ${guidance.remainingMinutes} minutes remain before the attention deadline.`);
  }

  if (guidance.reason) {
    context.push(`Reason: ${guidance.reason}`);
  }

  if (guidance.hints && guidance.hints.length > 0) {
    context.push(`Hints: ${guidance.hints.join("; ")}`);
  }

  return [instruction, ...context].join(" ");
}

function formatAvailabilitySummary(contract: Contract | null, availability: ScheduleResolution): string {
  const parts: string[] = [];

  if (!contract) {
    parts.push("No active availability contract.");
  } else {
    parts.push(`Mode: ${contract.mode}`);

    if (contract.statusText) {
      const emoji = contract.statusEmoji ? `${contract.statusEmoji} ` : "";
      parts.push(`Status: ${emoji}${contract.statusText}`);
    }

    if (contract.expiresAt) {
      const expires = new Date(contract.expiresAt);
      const now = new Date();
      const minutesLeft = Math.round((expires.getTime() - now.getTime()) / 60000);
      if (minutesLeft > 0) {
        parts.push(`Time remaining: ${minutesLeft} minutes`);
      }
    }

    if (contract.lock) parts.push("Status is locked");
    if (contract.autoRespond) parts.push("Auto-respond enabled");
  }

  parts.push(availability.inReachableHours ? "Currently in available hours" : "Currently outside available hours");

  if (availability.activeWindow) {
    parts.push(`Active availability window: ${availability.activeWindow.label} (${availability.activeWindow.mode})`);
  }

  if (availability.wrapUpGuidance?.active) {
    const remaining = availability.wrapUpGuidance.remainingMinutes;
    const timing = typeof remaining === "number" ? `${remaining}m remaining` : "active";
    parts.push(`Wrap-Up guidance: ${timing} (${availability.wrapUpGuidance.selectedMode})`);
  }

  const wrapUpInstruction = resolveExecutionInstruction({
    contract,
    schedule: availability,
  });
  if (wrapUpInstruction) {
    parts.push(`Wrap-Up instruction: ${wrapUpInstruction}`);
  }

  if (availability.nextWindow) {
    parts.push(`Next availability window: ${availability.nextWindow.label} (${availability.nextWindow.mode})`);
  }

  if (availability.nextTransitionAt) {
    parts.push(`Next availability transition at: ${availability.nextTransitionAt}`);
  }

  return parts.join("\n");
}

function buildSystemGuidance(input: { snapshot: PolicySnapshot; hasApprovedProposal: boolean }): string[] {
  const { snapshot, hasApprovedProposal } = input;
  const lines = [
    "HeadsDown policy is active for this session.",
    `Current mode: ${snapshot.contract?.mode ?? "online"}.`,
  ];

  if (!snapshot.contract || snapshot.contract.mode === "online") {
    lines.push("You may proceed normally while keeping edits intentional and scoped.");
  } else if (snapshot.contract.lock || snapshot.contract.mode === "offline") {
    lines.push("Do not perform file modifications unless the user gives explicit permission in this session.");
  } else if (!hasApprovedProposal && (snapshot.contract.mode === "busy" || snapshot.contract.mode === "limited")) {
    lines.push("Before modifying files, submit a plan with headsdown_approve and wait for approval.");
  }

  if (snapshot.wrapUpInstruction) {
    lines.push(snapshot.wrapUpInstruction);
  }

  return lines;
}

export function applyPolicyToChatParams(snapshot: PolicySnapshot | null, output: ChatParamsOutput): void {
  if (!snapshot) return;

  const guidance = snapshot.availability.wrapUpGuidance;
  if (guidance?.active && guidance.selectedMode === "wrap_up") {
    output.temperature = Math.min(output.temperature, 0.2);
    output.topP = Math.min(output.topP, 0.8);
  }

  output.options = {
    ...output.options,
    headsdown: {
      mode: snapshot.contract?.mode ?? "online",
      lock: Boolean(snapshot.contract?.lock),
      wrapUp: {
        active: Boolean(guidance?.active),
        selectedMode: guidance?.selectedMode ?? null,
        remainingMinutes: typeof guidance?.remainingMinutes === "number" ? guidance.remainingMinutes : null,
      },
    },
  };
}

export function applyPolicyToChatHeaders(snapshot: PolicySnapshot | null, output: ChatHeadersOutput): void {
  if (!snapshot) return;

  const guidance = snapshot.availability.wrapUpGuidance;
  output.headers["x-headsdown-mode"] = snapshot.contract?.mode ?? "online";
  output.headers["x-headsdown-lock"] = snapshot.contract?.lock ? "1" : "0";
  output.headers["x-headsdown-wrapup"] = guidance?.active ? guidance.selectedMode : "none";
}

export function applyPolicyToShellEnv(snapshot: PolicySnapshot | null, output: ShellEnvOutput): void {
  if (!snapshot) return;

  const guidance = snapshot.availability.wrapUpGuidance;
  output.env.HEADSDOWN_MODE = snapshot.contract?.mode ?? "online";
  output.env.HEADSDOWN_LOCKED = snapshot.contract?.lock ? "1" : "0";
  output.env.HEADSDOWN_WRAPUP_ACTIVE = guidance?.active ? "1" : "0";
  output.env.HEADSDOWN_WRAPUP_MODE = guidance?.active ? guidance.selectedMode : "none";
  output.env.HEADSDOWN_WRAPUP_MINUTES =
    guidance?.active && typeof guidance.remainingMinutes === "number" ? `${guidance.remainingMinutes}` : "";
}

export function buildToolExecutionMetadata(input: {
  snapshot: PolicySnapshot | null;
  hasApprovedProposal: boolean;
}): {
  mode: Contract["mode"] | "unknown";
  lock: boolean;
  hasApprovedProposal: boolean;
} {
  return {
    mode: input.snapshot?.contract?.mode ?? "unknown",
    lock: Boolean(input.snapshot?.contract?.lock),
    hasApprovedProposal: input.hasApprovedProposal,
  };
}

export function shouldDisableAutoContinue(snapshot: PolicySnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.contract?.lock || snapshot.contract?.mode === "offline") return true;

  const guidance = snapshot.availability.wrapUpGuidance;
  if (!guidance || !guidance.active) return false;

  return guidance.selectedMode === "wrap_up";
}

function getToolPolicyNote(snapshot: PolicySnapshot | null, hasApprovedProposal: boolean): string | null {
  if (!snapshot) return null;

  const contract = snapshot.contract;
  if (!contract || contract.mode === "online") {
    return "HeadsDown policy: proceed with normal scope discipline.";
  }

  if (contract.lock || contract.mode === "offline") {
    return "HeadsDown policy: do not modify files unless the user gives explicit permission.";
  }

  if (!hasApprovedProposal && (contract.mode === "busy" || contract.mode === "limited")) {
    return "HeadsDown policy: call headsdown_approve before any file-modifying action.";
  }

  return "HeadsDown policy: proposal approved; keep work aligned with the approved scope.";
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function extractPermissionTool(input: Permission): { toolName: string; toolArgs: Record<string, unknown> } | null {
  const metadata = toRecord(input.metadata);

  const toolNameCandidates = [
    metadata.tool,
    metadata.toolName,
    metadata.tool_name,
    metadata.name,
    typeof input.pattern === "string" ? input.pattern : undefined,
  ];

  const toolName = toolNameCandidates.find((value): value is string => typeof value === "string" && value.length > 0);
  if (!toolName) return null;

  const args = toRecord(metadata.args);
  if (Object.keys(args).length > 0) {
    return { toolName, toolArgs: args };
  }

  const command = metadata.command;
  if (typeof command === "string") {
    return { toolName, toolArgs: { command } };
  }

  return { toolName, toolArgs: {} };
}

export function applyPermissionPolicy(input: {
  permission: Permission;
  snapshot: PolicySnapshot | null;
  hasApprovedProposal: boolean;
  output: { status: "ask" | "deny" | "allow" };
}): void {
  if (!input.snapshot) return;

  const permissionTool = extractPermissionTool(input.permission);
  if (!permissionTool) {
    if (input.snapshot.contract?.lock || input.snapshot.contract?.mode === "offline") {
      input.output.status = "ask";
    }
    return;
  }

  const decision = evaluateGate({
    toolName: permissionTool.toolName,
    toolArgs: permissionTool.toolArgs,
    contract: input.snapshot.contract,
    hasApprovedProposal: input.hasApprovedProposal,
  });

  if (decision.action === "deny") {
    input.output.status = "deny";
  }
}

export const HeadsDownOpenCodePlugin: Plugin = async () => {
  const proposalStore = new ProposalStateStore();
  const policyCache = new Map<string, CacheEntry>();
  const toolTelemetry = new Map<string, { lastTool: string; lastAt: number }>();
  let activeTracker: CalibrationTracker | null = null;

  const fetchPolicySnapshot = async (cacheKey = "global"): Promise<PolicySnapshot | null> => {
    const now = Date.now();
    const cached = policyCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.snapshot;
    }

    try {
      const client = await HeadsDownClient.fromCredentials();
      const { contract, schedule: availability } = await client.getAvailability();
      const snapshot: PolicySnapshot = {
        contract,
        availability,
        summary: formatAvailabilitySummary(contract, availability),
        wrapUpInstruction: resolveExecutionInstruction({ contract, schedule: availability }),
        fetchedAt: now,
      };
      policyCache.set(cacheKey, { snapshot, expiresAt: now + POLICY_CACHE_TTL_MS });
      return snapshot;
    } catch {
      return null;
    }
  };

  return {
    tool: {
      headsdown_policy: tool({
        description: "Get the active HeadsDown policy snapshot, including mode and execution guidance.",
        args: {},
        async execute() {
          const client = await getAuthenticatedClient();
          const { contract, schedule: availability } = await client.getAvailability();
          const wrapUpInstruction = resolveExecutionInstruction({
            contract,
            schedule: availability,
          });
          return JSON.stringify(
            {
              authenticated: true,
              contract,
              availability,
              summary: formatAvailabilitySummary(contract, availability),
              wrapUpInstruction,
            },
            null,
            2,
          );
        },
      }),
      headsdown_approve: tool({
        description: "Submit a work plan to HeadsDown and return an allow/defer decision.",
        args: {
          description: tool.schema.string().min(3).describe("What you plan to do."),
          estimated_files: tool.schema.number().int().positive().optional(),
          estimated_minutes: tool.schema.number().int().positive().optional(),
          scope_summary: tool.schema.string().min(3).optional(),
          source_ref: tool.schema.string().min(2).optional(),
          delivery_mode: tool.schema.enum(["auto", "wrap_up", "full_depth"]).optional(),
        },
        async execute(args) {
          const client = await getAuthenticatedClient();
          const verdict = await client.submitProposal({
            agentRef: "opencode",
            framework: "opencode",
            description: args.description.trim(),
            estimatedFiles: args.estimated_files,
            estimatedMinutes: args.estimated_minutes,
            scopeSummary: args.scope_summary,
            sourceRef: args.source_ref,
            deliveryMode: args.delivery_mode,
          });

          if (verdict.decision === "approved") {
            await proposalStore.recordApproval({
              id: verdict.proposalId,
              decision: "approved",
              description: args.description.trim(),
              evaluatedAt: verdict.evaluatedAt,
            });

            try {
              const config = new ConfigStore();
              const configData = await config.load();
              if (configData.calibration !== false) {
                if (activeTracker) {
                  activeTracker.dispose();
                  activeTracker = null;
                }
                activeTracker = new CalibrationTracker(client, verdict.proposalId, { enabled: true });
                activeTracker.start();
              }
            } catch {
              // Do not fail the tool when calibration setup fails
            }
          }

          policyCache.clear();
          const wrapUpInstruction = resolveExecutionInstruction({
            verdict: {
              decision: verdict.decision,
              reason: verdict.reason,
              wrapUpGuidance: verdict.wrapUpGuidance,
            },
          });
          return JSON.stringify(
            {
              decision: verdict.decision,
              reason: verdict.reason,
              proposalId: verdict.proposalId,
              evaluatedAt: verdict.evaluatedAt,
              wrapUpGuidance: verdict.wrapUpGuidance,
              wrapUpInstruction,
            },
            null,
            2,
          );
        },
      }),
      headsdown_digest: tool({
        description: "View the user's HeadsDown digest of updates that arrived during focus mode.",
        args: {
          latest: tool.schema.number().int().positive().optional(),
        },
        async execute(args) {
          const client = await getAuthenticatedClient();
          const summaries = await client.listDigestSummaries({ latest: args.latest ?? 20 });

          return JSON.stringify(
            {
              summaries,
              total: summaries.length,
              message:
                summaries.length === 0
                  ? "No digest entries. Nothing arrived while the user was in focus mode."
                  : `${summaries.length} digest ${summaries.length === 1 ? "summary" : "summaries"} available.`,
            },
            null,
            2,
          );
        },
      }),
      headsdown_outcome: tool({
        description: "Report task outcome for a previously approved proposal.",
        args: {
          outcome: tool.schema.enum(["completed", "failed", "partially_completed", "cancelled", "timed_out"]),
          error_category: tool.schema.string().min(2).optional(),
          tests_passed: tool.schema.boolean().optional(),
        },
        async execute(args) {
          if (!activeTracker || !activeTracker.isActive) {
            throw new Error("No active calibration session. Submit a proposal via headsdown_approve first.");
          }

          const extras: Record<string, unknown> = {};
          if (args.error_category) extras.errorCategory = args.error_category;
          if (args.tests_passed !== undefined) extras.testsPassed = args.tests_passed;

          await activeTracker.complete(args.outcome, extras);
          activeTracker = null;

          return JSON.stringify(
            {
              reported: true,
              outcome: args.outcome,
              message: "Outcome recorded for calibration.",
            },
            null,
            2,
          );
        },
      }),
      headsdown_auth: tool({
        description: "Authenticate with HeadsDown via Device Flow.",
        args: {},
        async execute() {
          let verificationUri = "";
          const client = await HeadsDownClient.authenticate(
            async (auth) => {
              verificationUri = auth.verificationUriComplete;
            },
            { label: "OpenCode Plugin" },
          );
          const profile = await client.getProfile();
          if (verificationUri) {
            return `Authenticated as ${profile.email}. Verification URL: ${verificationUri}`;
          }
          return `Authenticated as ${profile.email}`;
        },
      }),
    },
    "experimental.chat.system.transform": async (input, output) => {
      const snapshot = await fetchPolicySnapshot(input.sessionID ?? "global");
      if (!snapshot) return;

      const hasApprovedProposal = await proposalStore.hasApprovedProposal();
      output.system.push(...buildSystemGuidance({ snapshot, hasApprovedProposal }));
    },
    "permission.ask": async (input, output) => {
      const snapshot = await fetchPolicySnapshot(input.sessionID);
      const hasApprovedProposal = await proposalStore.hasApprovedProposal();
      applyPermissionPolicy({ permission: input, snapshot, hasApprovedProposal, output });
    },
    "chat.params": async (input, output) => {
      const snapshot = await fetchPolicySnapshot(input.sessionID);
      applyPolicyToChatParams(snapshot, output);
    },
    "chat.headers": async (input, output) => {
      const snapshot = await fetchPolicySnapshot(input.sessionID);
      applyPolicyToChatHeaders(snapshot, output);
    },
    "tool.definition": async (input, output) => {
      if (input.toolID.startsWith("headsdown_")) return;
      if (!isModificationTool(input.toolID, undefined)) return;

      const snapshot = await fetchPolicySnapshot("global");
      const hasApprovedProposal = await proposalStore.hasApprovedProposal();
      const note = getToolPolicyNote(snapshot, hasApprovedProposal);
      if (!note) return;

      if (!output.description.includes("HeadsDown policy:")) {
        output.description = `${output.description}\n\n${note}`;
      }
    },
    "experimental.session.compacting": async (input, output) => {
      const snapshot = await fetchPolicySnapshot(input.sessionID);
      if (!snapshot) return;

      const hasApprovedProposal = await proposalStore.hasApprovedProposal();
      output.context.push(
        "## HeadsDown Policy State",
        snapshot.summary,
        `Approved proposal on record: ${hasApprovedProposal ? "yes" : "no"}`,
      );
      if (snapshot.wrapUpInstruction) {
        output.context.push(`Execution directive: ${snapshot.wrapUpInstruction}`);
      }
    },
    "experimental.compaction.autocontinue": async (_input, output) => {
      const snapshot = await fetchPolicySnapshot("global");
      if (shouldDisableAutoContinue(snapshot)) {
        output.enabled = false;
      }
    },
    "tool.execute.before": async (input, output) => {
      if (!input.tool.startsWith("headsdown_") && activeTracker) {
        activeTracker.recordTurn();
      }

      if (input.tool.startsWith("headsdown_")) return;

      try {
        const client = await HeadsDownClient.fromCredentials();
        const { contract } = await client.getAvailability();
        const hasApprovedProposal = await proposalStore.hasApprovedProposal();
        const gate = evaluateGate({
          toolName: input.tool,
          toolArgs: output.args,
          contract,
          hasApprovedProposal,
        });

        if (gate.action === "deny") {
          throw new Error(gate.reason);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[HeadsDown]")) {
          throw error;
        }
      }
    },
    "command.execute.before": async (input) => {
      if (activeTracker) {
        activeTracker.recordTurn();
      }

      toolTelemetry.set(input.sessionID, {
        lastTool: `command:${input.command}`,
        lastAt: Date.now(),
      });
    },
    "tool.execute.after": async (input, output) => {
      const snapshot = await fetchPolicySnapshot(input.sessionID);
      const hasApprovedProposal = await proposalStore.hasApprovedProposal();

      toolTelemetry.set(input.sessionID, {
        lastTool: input.tool,
        lastAt: Date.now(),
      });

      const headsdownMeta = buildToolExecutionMetadata({ snapshot, hasApprovedProposal });

      output.metadata = {
        ...(toRecord(output.metadata)),
        headsdown: headsdownMeta,
      };

      if (snapshot?.availability.wrapUpGuidance?.active && isModificationTool(input.tool, input.args)) {
        output.title = `[HeadsDown Wrap-Up] ${output.title}`;
      }
    },
    "shell.env": async (input, output) => {
      const snapshot = await fetchPolicySnapshot(input.sessionID ?? input.cwd);
      applyPolicyToShellEnv(snapshot, output);
    },
    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        policyCache.delete(event.properties.sessionID);
      }
      if (event.type === "session.deleted") {
        toolTelemetry.delete(event.properties.info.id);
        policyCache.delete(event.properties.info.id);
      }
    },
  };
};

export default HeadsDownOpenCodePlugin;
