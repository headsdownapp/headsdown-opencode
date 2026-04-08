import type { Contract } from "@headsdown/sdk";

export interface GateInput {
  toolName: string;
  toolArgs: Record<string, unknown> | undefined;
  contract: Contract | null;
  hasApprovedProposal: boolean;
}

export type GateDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string };

const MODIFICATION_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "bash"]);

const SAFE_BASH_COMMAND_PATTERNS = [
  /^git\s+status(\s|$)/,
  /^git\s+diff(\s|$)/,
  /^git\s+log(\s|$)/,
  /^git\s+show(\s|$)/,
  /^git\s+branch(\s|$)/,
  /^git\s+rev-parse(\s|$)/,
  /^ls(\s|$)/,
  /^pwd(\s|$)/,
  /^cat(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^wc(\s|$)/,
  /^echo(\s|$)/,
  /^grep(\s|$)/,
  /^rg(\s|$)/,
  /^find(\s|$)/,
  /^fd(\s|$)/
];

export function isModificationTool(toolName: string, toolArgs: Record<string, unknown> | undefined): boolean {
  if (!MODIFICATION_TOOLS.has(toolName)) return false;
  if (toolName !== "bash") return true;
  const command = `${toolArgs?.command ?? ""}`.trim();
  if (!command) return true;
  return !SAFE_BASH_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function statusSuffix(contract: Contract): string {
  return contract.statusText ? ` (${contract.statusText})` : "";
}

export function evaluateGate(input: GateInput): GateDecision {
  if (!isModificationTool(input.toolName, input.toolArgs)) return { action: "allow" };
  if (!input.contract || input.contract.mode === "online") return { action: "allow" };
  if (input.hasApprovedProposal) return { action: "allow" };

  const suffix = statusSuffix(input.contract);
  if (input.contract.lock || input.contract.mode === "offline") {
    return {
      action: "deny",
      reason: `[HeadsDown] User is in ${input.contract.mode.toUpperCase()} mode${suffix}. Status is locked or user is offline. Ask for explicit permission before proceeding.`
    };
  }

  if (input.contract.mode === "busy" || input.contract.mode === "limited") {
    return {
      action: "deny",
      reason: `[HeadsDown] User is in ${input.contract.mode.toUpperCase()} mode${suffix}. Submit a task proposal with headsdown_propose before modifying files.`
    };
  }

  return { action: "allow" };
}
