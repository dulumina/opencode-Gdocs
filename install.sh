#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"
CLIENT_PATH="$CONFIG_DIR/google-drive-client.json"
mkdir -p "$PLUGIN_DIR"

if [[ -f "$PLUGIN_DIR/google-drive.ts" ]]; then
  cp "$PLUGIN_DIR/google-drive.ts" "$PLUGIN_DIR/google-drive.ts.bak.$(date +%Y%m%d%H%M%S)"
  echo "Backed up existing plugin."
fi
cp "$ROOT/plugins/google-drive.ts" "$PLUGIN_DIR/google-drive.ts"

if [[ ! -f "$CLIENT_PATH" ]]; then
  CLIENT_JSON="${1:-}"
  if [[ -z "$CLIENT_JSON" ]]; then
    CLIENT_JSON="$(ls "$HOME"/Downloads/client_secret_*.json "$HOME"/Documents/client_secret_*.json 2>/dev/null | head -n1 || true)"
  fi
  if [[ -n "$CLIENT_JSON" && -f "$CLIENT_JSON" ]]; then
    cp "$CLIENT_JSON" "$CLIENT_PATH"
    echo "OAuth client saved to: $CLIENT_PATH"
  else
    echo "OAuth client JSON not found."
    echo "Download the Desktop app client JSON from Google Cloud Console, then run:"
    echo "  ./install.sh /path/to/client_secret.json"
  fi
fi
[[ -f "$CLIENT_PATH" ]] && chmod 600 "$CLIENT_PATH"

if [[ -f "$CONFIG_DIR/package.json" ]]; then
  echo "Existing $CONFIG_DIR/package.json found; leaving it unchanged."
  echo "Ensure it includes dependencies: \"@opencode/plugin\" (^2) and \"googleapis\" (^186)."
else
  cp "$ROOT/package.json" "$CONFIG_DIR/package.json"
fi

chmod 700 "$CONFIG_DIR"
chmod 600 "$PLUGIN_DIR/google-drive.ts"
echo
echo "Plugin copied to: $PLUGIN_DIR/google-drive.ts"
echo "Next: install dependencies in $CONFIG_DIR (see README.md), then restart OpenCode."
