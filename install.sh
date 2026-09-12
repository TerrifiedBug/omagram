#!/bin/bash
# Installs omarchy-omagram: copies the plugin into the user plugin directory
# (when run from a source checkout), installs the daemon's dependencies, sets up
# the user service, and enables the bar widget.
#
# Safe to re-run. --uninstall also deletes credentials and the chat cache.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PLUGIN_ID="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE_DIR/manifest.json" | head -1)"
PLUGINS_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
PLUGIN_DIR="$PLUGINS_ROOT/$PLUGIN_ID"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BIN_DIR="$HOME/.local/bin"
UNIT_NAME="omarchy-omagram.service"

skip_service=0
skip_enable=0

die() {
  echo "install: $*" >&2
  exit 1
}

say() { echo "==> $*"; }

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --no-service   skip the systemd user service (start the daemon yourself)
  --no-enable    skip adding the widget to the bar
  --uninstall    stop the service, delete credentials, and remove a copied install
  -h, --help     this message

Credentials live in ~/.local/state/omarchy-omagram and are deleted on --uninstall.
EOF
}

uninstall() {
  source "$SOURCE_DIR/bin/_common.sh"
  say "Stopping the service and deleting local credentials"
  tg_uninstall

  if command -v omarchy >/dev/null 2>&1; then
    say "Removing the bar widget"
    omarchy plugin disable "$PLUGIN_ID" --yes 2>/dev/null || true
  fi

  if [[ -d $PLUGIN_DIR && $PLUGIN_DIR != "$SOURCE_DIR" ]]; then
    say "Removing $PLUGIN_DIR"
    rm -rf "$PLUGIN_DIR"
  fi

  command -v omarchy-shell >/dev/null 2>&1 && omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
  say "Uninstalled. The bar entry is gone after: omarchy plugin remove $PLUGIN_ID"
  exit 0
}

while (($# > 0)); do
  case $1 in
  --no-service) skip_service=1 ;;
  --no-enable) skip_enable=1 ;;
  --uninstall) uninstall ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) die "unknown option: $1" ;;
  esac
  shift
done

[[ -n $PLUGIN_ID ]] || die "could not read the plugin id from manifest.json"

source "$SOURCE_DIR/bin/_common.sh"
NODE="$(tg_node)"
say "Using Node $("$NODE" -v) at $NODE"

# ── 1. Place the plugin ─────────────────────────────────────────────────────
if [[ $(readlink -f "$SOURCE_DIR") == $(readlink -f "$PLUGIN_DIR") ]]; then
  say "Already installed at $PLUGIN_DIR (in-place setup)"
else
  say "Installing to $PLUGIN_DIR"
  mkdir -p "$PLUGIN_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.git' \
      --exclude 'node_modules' \
      --exclude '*.tmp' \
      "$SOURCE_DIR"/ "$PLUGIN_DIR"/
  else
    # tar keeps the excludes working without rsync installed.
    tar -C "$SOURCE_DIR" --exclude='.git' --exclude='node_modules' -cf - . \
      | tar -C "$PLUGIN_DIR" -xf -
  fi
fi

chmod +x "$PLUGIN_DIR"/bin/* "$PLUGIN_DIR"/daemon/ctl.js "$PLUGIN_DIR"/install.sh 2>/dev/null || true

# After a copy, helpers must resolve the *installed* plugin path.
source "$PLUGIN_DIR/bin/_common.sh"

say "Installing daemon dependencies, CLI, and the user service"
tg_ensure_setup
if ((skip_service)); then
  say "Skipping the user service start"
else
  systemctl --user restart "$TG_UNIT_NAME"
  say "Service started"
fi

# ── 5. Register with the shell ──────────────────────────────────────────────
if command -v omarchy-shell >/dev/null 2>&1; then
  say "Rescanning plugins"
  omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
fi

if ((skip_enable)); then
  say "Skipping bar enablement"
elif command -v omarchy >/dev/null 2>&1; then
  say "Enabling the bar widget"
  omarchy plugin enable "$PLUGIN_ID" --yes 2>/dev/null \
    || omarchy plugin enable "$PLUGIN_ID" 2>/dev/null \
    || echo "    (could not enable automatically; run: omarchy plugin enable $PLUGIN_ID)"
fi

cat <<EOF

Done. Next:

  1. Create a Telegram app at https://my.telegram.org/apps under API development tools.
  2. Link your account:   omarchy-omagram login
     (or click the OmaGram icon in the bar and scan the QR there)
  3. Click the icon to read and reply; right-click for Telegram Desktop.

Service:  systemctl --user status $UNIT_NAME
Logs:     journalctl --user -u $UNIT_NAME -f
EOF
