import { HeadsDownClient, ProposalStateStore } from "@headsdown/sdk";
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

export const HeadsDownOpenCodePlugin: Plugin = async () => {
  const proposalStore = new ProposalStateStore();

  return {
    tool: {
      headsdown_status: tool({
        description: "Get the user's current HeadsDown status and availability.",
        args: {},
        async execute() {
          const client = await getAuthenticatedClient();
          const availability = await client.getAvailability();
          return JSON.stringify(availability, null, 2);
        }
      }),
      headsdown_propose: tool({
        description: "Submit a task proposal for verdict (approved/deferred).",
        args: {
          description: tool.schema.string().min(3).describe("What you plan to do."),
          estimated_files: tool.schema.number().int().positive().optional(),
          estimated_minutes: tool.schema.number().int().positive().optional()
        },
        async execute(args) {
          const client = await getAuthenticatedClient();
          const verdict = await client.submitProposal({
            agentRef: "opencode",
            framework: "opencode",
            description: args.description.trim(),
            estimatedFiles: args.estimated_files,
            estimatedMinutes: args.estimated_minutes
          });

          if (verdict.decision === "approved") {
            await proposalStore.recordApproval({
              id: verdict.proposalId,
              decision: "approved",
              description: args.description.trim(),
              evaluatedAt: verdict.evaluatedAt
            });
          }

          return JSON.stringify(verdict, null, 2);
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
