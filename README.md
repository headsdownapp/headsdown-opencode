# headsdown-opencode

HeadsDown availability-awareness and task-gating plugin for OpenCode.

## What it does

- Adds `headsdown_policy`, `headsdown_approve`, `headsdown_digest`, `headsdown_outcome`, and `headsdown_auth` tools to OpenCode
- Injects HeadsDown execution guidance into system prompts on every turn
- Enforces policy through both permission mediation and pre-tool hard gates
- Applies mode-aware model shaping via `chat.params`, `chat.headers`, and `shell.env`
- Shapes tool definitions with mode-aware HeadsDown constraints
- Persists policy context during session compaction and can disable auto-continue in strict Wrap-Up windows
- Tracks approved proposals and reports outcomes for calibration

## Install

```bash
npm install headsdown-opencode
```

Then configure OpenCode in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["headsdown-opencode", "headsdown-opencode/tui"]
}
```

`headsdown-opencode` loads server-side policy hooks and tools.
`headsdown-opencode/tui` adds TUI-only status toasts and command palette actions.

## First-time auth

Inside OpenCode, run the `headsdown_auth` tool and complete the Device Flow.

After auth, use `headsdown_policy` to confirm your current mode, schedule state, and execution guidance.

## Proposal and outcome workflow

When the user is in `busy` or `limited` mode and the agent needs to modify files:

1. Call `headsdown_approve`
2. If approved, continue the task
3. If deferred, summarize and ask the user whether to postpone or reduce scope
4. After completion/failure, call `headsdown_outcome` with the outcome

Use `headsdown_digest` at session start or when asked "what did I miss?" to review updates that arrived during focus mode.

## TUI features

The TUI plugin adds:

- `HeadsDown: Refresh policy` command (`/headsdown-policy-refresh`)
- `HeadsDown: Show policy` command (`/headsdown-policy`)
- Transition toasts when mode changes or Wrap-Up/lock state becomes active

## Development

```bash
cd headsdown-opencode
npm install
npm run build
npm test
```

## License

MIT
