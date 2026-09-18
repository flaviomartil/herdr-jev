#!/usr/bin/env bash
# Automated installer and Herdr configurator for Herdr-Jev plugin.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERDR_CONFIG_DIR="$HOME/.config/herdr"
HERDR_CONFIG_FILE="$HERDR_CONFIG_DIR/config.toml"
BIN_TARGET="$HOME/.local/bin/herdr-jev"

echo "=== Herdr-Jev Automated Setup ==="
echo "Target directory: $REPO_DIR"

# 1. Verify Bun is installed
if ! command -v bun >/dev/null 2>&1; then
  echo "Error: Bun is required but not found in PATH." >&2
  exit 1
fi

# 2. Install dependencies
echo ">> Installing dependencies with Bun..."
(cd "$REPO_DIR" && bun install)

# 3. Create global CLI symlink
echo ">> Setting up global binary at $BIN_TARGET..."
mkdir -p "$HOME/.local/bin"
chmod +x "$REPO_DIR/bin/herdr-jev.js" "$REPO_DIR/src/cli.ts"
ln -sf "$REPO_DIR/bin/herdr-jev.js" "$BIN_TARGET"

# 4. Link plugin into Herdr
if command -v herdr >/dev/null 2>&1; then
  echo ">> Linking plugin to Herdr..."
  herdr plugin link "$REPO_DIR"
else
  echo "Warning: herdr binary not found in PATH. Skipping 'herdr plugin link'."
fi

# 5. Configure Herdr Keybindings in config.toml
if [ -f "$HERDR_CONFIG_FILE" ]; then
  if grep -q "herdr-jev" "$HERDR_CONFIG_FILE"; then
    echo ">> Keybindings already present in $HERDR_CONFIG_FILE."
  else
    echo ">> Appending default keybindings to $HERDR_CONFIG_FILE..."
    cat << 'EOF' >> "$HERDR_CONFIG_FILE"

# Herdr-Jev Keybindings
[[keys.command]]
key = "prefix+j"
type = "plugin_action"
command = "herdr-jev.route"
description = "Jev: Route Task"

[[keys.command]]
key = "prefix+J"
type = "plugin_action"
command = "herdr-jev.triad"
description = "Jev: Full Triad Pipeline"

[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "herdr-jev.models"
description = "Jev: Models and Cascades"

[[keys.command]]
key = "prefix+s"
type = "plugin_action"
command = "herdr-jev.status"
description = "Jev: Status"
EOF
    echo ">> Keybindings successfully added."
  fi
else
  echo "Notice: $HERDR_CONFIG_FILE does not exist yet. Create it after running Herdr."
fi

# 6. Install Agent Skill for AI Coding Assistants (Claude Code, Codex, AntiGravity)
echo ">> Installing Agent Skill..."
AGENTS_SKILLS_DIR="$HOME/.agents/skills"
GEMINI_SKILLS_DIR="$HOME/.gemini/config/skills"

mkdir -p "$AGENTS_SKILLS_DIR"
ln -sfn "$REPO_DIR/skills/herdr-jev" "$AGENTS_SKILLS_DIR/herdr-jev"

if [ -d "$GEMINI_SKILLS_DIR" ]; then
  ln -sfn "$REPO_DIR/skills/herdr-jev" "$GEMINI_SKILLS_DIR/herdr-jev"
fi
echo ">> Skill herdr-jev registered for AI agents."

# 7. Probing installed harnesses and model quotas
echo
echo ">> Probing installed AI harnesses and model quotas..."
"$BIN_TARGET" detect

if [ "${1:-}" = "--auto-config" ] || [ "${AUTO_CONFIG:-}" = "1" ]; then
  echo ">> Auto-configuring environment based on detected healthy harnesses..."
  "$BIN_TARGET" detect --auto-config
fi

# 8. Verification
echo
echo ">> Verifying installation..."
"$BIN_TARGET" status

echo
echo "=== Herdr-Jev installation completed successfully! ==="

