import { HeadsDownClient } from "@headsdown/sdk";
import type { Contract, ScheduleResolution } from "@headsdown/sdk";
import type { TuiPlugin, TuiToast } from "@opencode-ai/plugin/tui";

const POLICY_POLL_INTERVAL_MS = 60_000;
const LAST_STATE_KEY = "headsdown.tui.last_state";
const STATUS_LINE_KEY = "headsdown.tui.status_line";
const AUTH_TOAST_KEY = "headsdown.tui.auth_toast";

export type PolicyUiState = {
  mode: Contract["mode"] | "unknown";
  lock: boolean;
  wrapUpActive: boolean;
  wrapUpMode: "wrap_up" | "full_depth" | "auto" | null;
  remainingMinutes: number | null;
};

function derivePolicyUiState(contract: Contract | null, availability: ScheduleResolution | null): PolicyUiState {
  const wrap = availability?.wrapUpGuidance;
  return {
    mode: contract?.mode ?? "unknown",
    lock: Boolean(contract?.lock),
    wrapUpActive: Boolean(wrap?.active),
    wrapUpMode: wrap?.selectedMode ?? null,
    remainingMinutes: typeof wrap?.remainingMinutes === "number" ? wrap.remainingMinutes : null,
  };
}

function formatStatusLine(state: PolicyUiState): string {
  const parts = [state.mode.toUpperCase()];
  if (state.lock) parts.push("LOCKED");
  if (state.wrapUpActive) {
    const timing = state.remainingMinutes === null ? "wrap-up" : `${state.remainingMinutes}m`;
    parts.push(`${timing}:${state.wrapUpMode ?? "auto"}`);
  }
  return parts.join(" • ");
}

export function detectPolicyTransitions(previous: PolicyUiState | null, next: PolicyUiState): string[] {
  if (!previous) {
    return [];
  }

  const changes: string[] = [];

  if (previous.mode !== next.mode) {
    changes.push(`HeadsDown mode changed to ${next.mode.toUpperCase()}.`);
  }

  if (!previous.lock && next.lock) {
    changes.push("HeadsDown lock is enabled. File modifications now require explicit user permission.");
  }

  if (!previous.wrapUpActive && next.wrapUpActive) {
    if (next.remainingMinutes !== null) {
      changes.push(`Wrap-Up guidance is active (${next.remainingMinutes} minutes remaining).`);
    } else {
      changes.push("Wrap-Up guidance is active.");
    }
  }

  return changes;
}

function safeJsonParse(value: string | undefined): PolicyUiState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PolicyUiState>;
    if (!parsed || typeof parsed !== "object") return null;

    const mode = typeof parsed.mode === "string" ? parsed.mode : "unknown";
    const lock = Boolean(parsed.lock);
    const wrapUpActive = Boolean(parsed.wrapUpActive);
    const wrapUpMode =
      parsed.wrapUpMode === "auto" || parsed.wrapUpMode === "wrap_up" || parsed.wrapUpMode === "full_depth"
        ? parsed.wrapUpMode
        : null;
    const remainingMinutes = typeof parsed.remainingMinutes === "number" ? parsed.remainingMinutes : null;

    return {
      mode: mode as PolicyUiState["mode"],
      lock,
      wrapUpActive,
      wrapUpMode,
      remainingMinutes,
    };
  } catch {
    return null;
  }
}

function toToast(message: string, variant: TuiToast["variant"] = "info"): TuiToast {
  return {
    variant,
    title: "HeadsDown",
    message,
  };
}

export const HeadsDownOpenCodeTuiPlugin: TuiPlugin = async (api) => {
  const notify = (toast: TuiToast) => api.ui.toast(toast);

  const readLastState = (): PolicyUiState | null => {
    const raw = api.kv.get<string | undefined>(LAST_STATE_KEY, undefined);
    return safeJsonParse(raw);
  };

  const writeLastState = (state: PolicyUiState): void => {
    api.kv.set(LAST_STATE_KEY, JSON.stringify(state));
    api.kv.set(STATUS_LINE_KEY, formatStatusLine(state));
  };

  const refreshPolicy = async (announce = false): Promise<void> => {
    let client: HeadsDownClient;
    try {
      client = await HeadsDownClient.fromCredentials();
    } catch {
      const alreadyNotified = api.kv.get<boolean>(AUTH_TOAST_KEY, false);
      if (!alreadyNotified) {
        notify(toToast("HeadsDown is not authenticated. Run headsdown_auth to enable live policy hints.", "warning"));
        api.kv.set(AUTH_TOAST_KEY, true);
      }
      api.kv.set(STATUS_LINE_KEY, "AUTH REQUIRED");
      return;
    }

    api.kv.set(AUTH_TOAST_KEY, false);

    const { contract, schedule } = await client.getAvailability();
    const nextState = derivePolicyUiState(contract, schedule);
    const previousState = readLastState();
    const transitions = detectPolicyTransitions(previousState, nextState);

    writeLastState(nextState);

    if (announce) {
      notify(toToast(`Policy: ${formatStatusLine(nextState)}`));
    }

    for (const transition of transitions) {
      const variant: TuiToast["variant"] = transition.includes("lock") ? "warning" : "info";
      notify(toToast(transition, variant));
    }
  };

  const unregisterCommands = api.command.register(() => {
    const current = readLastState();
    const statusLine = api.kv.get<string>(STATUS_LINE_KEY, "UNKNOWN");
    return [
      {
        title: "HeadsDown: Refresh policy",
        value: "headsdown.refresh-policy",
        description: `Fetch current HeadsDown mode and show status. Current: ${statusLine}`,
        category: "HeadsDown",
        slash: { name: "headsdown-policy-refresh" },
        onSelect: () => {
          void refreshPolicy(true);
        },
      },
      {
        title: "HeadsDown: Show policy",
        value: "headsdown.show-policy",
        description: current ? formatStatusLine(current) : "No cached policy yet.",
        category: "HeadsDown",
        suggested: true,
        slash: { name: "headsdown-policy" },
        onSelect: () => {
          const latest = readLastState();
          if (!latest) {
            notify(toToast("No policy cached yet. Run HeadsDown: Refresh policy.", "warning"));
            return;
          }
          notify(toToast(`Policy: ${formatStatusLine(latest)}`));
        },
      },
    ];
  });

  const disposeSessionStatus = api.event.on("session.status", (event) => {
    if (event.properties.status.type === "idle") {
      void refreshPolicy(false);
    }
  });

  const intervalHandle = (globalThis as unknown as { setInterval: (cb: () => void, ms: number) => unknown }).setInterval(() => {
    void refreshPolicy(false);
  }, POLICY_POLL_INTERVAL_MS);

  api.lifecycle.onDispose(() => {
    (globalThis as unknown as { clearInterval: (handle: unknown) => void }).clearInterval(intervalHandle);
    disposeSessionStatus();
    unregisterCommands();
  });

  await refreshPolicy(false);
};

export default HeadsDownOpenCodeTuiPlugin;
