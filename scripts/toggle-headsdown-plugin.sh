#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"

if [[ "$MODE" != "local" && "$MODE" != "published" ]]; then
  cat <<'USAGE'
Usage:
  scripts/toggle-headsdown-plugin.sh local
  scripts/toggle-headsdown-plugin.sh published

Modes:
  local      Use local dist build via .opencode/plugins shims in current project.
  published  Use npm plugins from opencode.json and remove local shims.
USAGE
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_DIR="$(pwd)"
CONFIG_FILE="$PROJECT_DIR/opencode.json"
PLUGIN_DIR="$PROJECT_DIR/.opencode/plugins"
SERVER_SHIM="$PLUGIN_DIR/headsdown-server.js"
TUI_SHIM="$PLUGIN_DIR/headsdown-tui.js"

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat > "$CONFIG_FILE" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": []
}
JSON
  echo "Created $CONFIG_FILE"
fi

BACKUP_FILE="$CONFIG_FILE.bak.$(date +%Y%m%d%H%M%S)"
cp "$CONFIG_FILE" "$BACKUP_FILE"

if [[ "$MODE" == "local" ]]; then
  mkdir -p "$PLUGIN_DIR"

  cat > "$SERVER_SHIM" <<EOF
import plugin from "$PLUGIN_REPO/dist/index.js";
export const HeadsDownLocalServerPlugin = plugin;
export default plugin;
EOF
  rm -f "$TUI_SHIM"

  node -e '
const fs = require("fs");
const file = process.argv[1];
const config = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(config.plugin)) config.plugin = [];

config.plugin = config.plugin.filter((entry) => {
  if (typeof entry === "string") {
    return entry !== "headsdown-opencode" &&
      entry !== "headsdown-opencode/tui" &&
      entry !== "@headsdown/opencode" &&
      entry !== "@headsdown/opencode/tui";
  }
  if (Array.isArray(entry) && typeof entry[0] === "string") {
    return entry[0] !== "headsdown-opencode" &&
      entry[0] !== "headsdown-opencode/tui" &&
      entry[0] !== "@headsdown/opencode" &&
      entry[0] !== "@headsdown/opencode/tui";
  }
  return true;
});

fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' "$CONFIG_FILE"

  echo "Switched to LOCAL plugin mode."
  echo "- Created/updated: $SERVER_SHIM"
  echo "- Removed TUI shim (local plugin auto-loading treats it as server-only): $TUI_SHIM"
  echo "- Removed published headsdown entries from: $CONFIG_FILE"
  echo "- Backup: $BACKUP_FILE"
  echo
  echo "Next step: run 'npm run dev' in $PLUGIN_REPO and restart OpenCode."
  exit 0
fi

rm -f "$SERVER_SHIM" "$TUI_SHIM"

node -e '
const fs = require("fs");
const file = process.argv[1];
const config = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(config.plugin)) config.plugin = [];

config.plugin = config.plugin.filter((entry) => {
  if (typeof entry === "string") {
    return entry !== "headsdown-opencode" &&
      entry !== "headsdown-opencode/tui" &&
      entry !== "@headsdown/opencode" &&
      entry !== "@headsdown/opencode/tui";
  }
  if (Array.isArray(entry) && typeof entry[0] === "string") {
    return entry[0] !== "headsdown-opencode" &&
      entry[0] !== "headsdown-opencode/tui" &&
      entry[0] !== "@headsdown/opencode" &&
      entry[0] !== "@headsdown/opencode/tui";
  }
  return true;
});

config.plugin.push("@headsdown/opencode", "@headsdown/opencode/tui");

fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' "$CONFIG_FILE"

echo "Switched to PUBLISHED plugin mode."
echo "- Removed local shims from: $PLUGIN_DIR"
echo "- Added published headsdown entries to: $CONFIG_FILE"
echo "- Backup: $BACKUP_FILE"
echo
echo "Next step: restart OpenCode."
