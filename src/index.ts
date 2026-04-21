import { CalibrationTracker, ConfigStore, HeadsDownClient, ProposalStateStore } from "@headsdown/sdk";
import type { Contract, ScheduleResolution } from "@headsdown/sdk";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { evaluateGate } from "./policy.js";

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

  if (availability.nextWindow) {
    parts.push(`Next availability window: ${availability.nextWindow.label} (${availability.nextWindow.mode})`);
  }

  if (availability.nextTransitionAt) {
    parts.push(`Next availability transition at: ${availability.nextTransitionAt}`);
  }

  return parts.join("\n");
}

export const HeadsDownOpenCodePlugin: Plugin = async () => {
  const proposalStore = new ProposalStateStore();
  let activeTracker: CalibrationTracker | null = null;

  return {
    tool: {
      headsdown_status: tool({
        description: "Get the user's current HeadsDown status and availability state.",
        args: {},
        async execute() {
          const client = await getAuthenticatedClient();
          const { contract, schedule: availability } = await client.getAvailability();
          return JSON.stringify(
            {
              authenticated: true,
              contract,
              availability,
              summary: formatAvailabilitySummary(contract, availability)
            },
            null,
            2
          );
        }
      }),
      headsdown_propose: tool({
        description: "Submit a task proposal for verdict (approved/deferred).",
        args: {
          description: tool.schema.string().min(3).describe("What you plan to do."),
          estimated_files: tool.schema.number().int().positive().optional(),
          estimated_minutes: tool.schema.number().int().positive().optional(),
          scope_summary: tool.schema.string().min(3).optional(),
          source_ref: tool.schema.string().min(2).optional(),
          delivery_mode: tool.schema.enum(["auto", "wrap_up", "full_depth"]).optional()
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
            deliveryMode: args.delivery_mode
          });

          if (verdict.decision === "approved") {
            await proposalStore.recordApproval({
              id: verdict.proposalId,
              decision: "approved",
              description: args.description.trim(),
              evaluatedAt: verdict.evaluatedAt
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

          return JSON.stringify(
            {
              decision: verdict.decision,
              reason: verdict.reason,
              proposalId: verdict.proposalId,
              evaluatedAt: verdict.evaluatedAt,
              wrapUpGuidance: verdict.wrapUpGuidance
            },
            null,
            2
          );
        }
      }),
      headsdown_digest: tool({
        description: "View the user's HeadsDown digest of updates that arrived during focus mode.",
        args: {
          latest: tool.schema.number().int().positive().optional()
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
                  : `${summaries.length} digest ${summaries.length === 1 ? "summary" : "summaries"} available.`
            },
            null,
            2
          );
        }
      }),
      headsdown_report: tool({
        description: "Report task outcome for a previously approved proposal.",
        args: {
          outcome: tool.schema.enum(["completed", "failed", "partially_completed", "cancelled", "timed_out"]),
          error_category: tool.schema.string().min(2).optional(),
          tests_passed: tool.schema.boolean().optional()
        },
        async execute(args) {
          if (!activeTracker || !activeTracker.isActive) {
            throw new Error("No active calibration session. Submit a proposal via headsdown_propose first.");
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
              message: "Outcome recorded for calibration."
            },
            null,
            2
          );
        }
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
            { label: "OpenCode Plugin" }
          );
          const profile = await client.getProfile();
          if (verificationUri) {
            return `Authenticated as ${profile.email}. Verification URL: ${verificationUri}`;
          }
          return `Authenticated as ${profile.email}`;
        }
      })
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
          hasApprovedProposal
        });

        if (gate.action === "deny") {
          throw new Error(gate.reason);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[HeadsDown]")) {
          throw error;
        }
      }
    }
  };
};

export default HeadsDownOpenCodePlugin;
