# headsdown-opencode

HeadsDown availability and task gating plugin for OpenCode.

## What it does

- Adds `headsdown_status`, `headsdown_propose`, and `headsdown_auth` tools to OpenCode
- Checks HeadsDown availability before write-like tool execution
- Allows edits immediately in `online` mode
- Requires an approved proposal in `busy` and `limited` mode
- Blocks edits in `offline` mode and locked contracts unless the user gives explicit permission

## Install

```bash
npm install headsdown-opencode
```

Then configure OpenCode in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["headsdown-opencode"]
}
```

## First-time auth

Inside OpenCode, run the `headsdown_auth` tool and complete the Device Flow.

After auth, use `headsdown_status` to confirm your current mode.

## Proposal workflow

When the user is in `busy` or `limited` mode and the agent needs to modify files:

1. Call `headsdown_propose`
2. If approved, continue the task
3. If deferred, summarize and ask the user whether to postpone or reduce scope

## Development

```bash
cd opencode
npm install
npm run build
npm test
```

## License

MIT
