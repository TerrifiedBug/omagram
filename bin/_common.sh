#!/bin/bash
# Sourced by every omarchy-omagram script. Resolves the plugin root, the state
# directory, and a Node runtime new enough for teleproto.

set -euo pipefail

TG_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TG_ROOT="$(dirname "$TG_BIN_DIR")"
TG_DAEMON_DIR="$TG_ROOT/daemon"
TG_STATE_DIR="${OMARCHY_OMAGRAM_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-omagram}"
TG_SOCKET="${OMARCHY_OMAGRAM_SOCKET:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/omarchy-omagram.sock}"

export OMARCHY_OMAGRAM_STATE="$TG_STATE_DIR"
export OMARCHY_OMAGRAM_SOCKET="$TG_SOCKET"

tg_die() {
  echo "omarchy-omagram: $*" >&2
  exit 1
}

# Version managers (mise, proto, fnm, nvm, volta) keep node off the default
# PATH of a systemd user unit, so probe their shim directories too.
tg_resolve_node() {
  if [[ -n ${OMARCHY_OMAGRAM_NODE:-} ]]; then
    printf '%s\n' "$OMARCHY_OMAGRAM_NODE"
    return 0
  fi

  local candidates=(
    "$(command -v node 2>/dev/null || true)"
    "$HOME/.local/share/mise/shims/node"
    "$HOME/.local/share/proto/shims/node"
    "$HOME/.local/share/fnm/aliases/default/bin/node"
    "$HOME/.volta/bin/node"
    "$HOME/.bun/bin/node"
    /usr/bin/node
    /usr/local/bin/node
  )

  local candidate major
  for candidate in "${candidates[@]}"; do
    [[ -n $candidate && -x $candidate ]] || continue
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if ((major >= 20)); then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

tg_node() {
  local node
  node="$(tg_resolve_node)" || tg_die "no Node.js >= 20 found. Install nodejs, or set OMARCHY_OMAGRAM_NODE=/path/to/node"
  printf '%s\n' "$node"
}

tg_ensure_deps() {
  [[ -d $TG_DAEMON_DIR/node_modules/teleproto ]] && return 0

  local node npm
  node="$(tg_node)"
  npm="$(dirname "$node")/npm"
  [[ -x $npm ]] || npm="$(command -v npm 2>/dev/null || true)"
  [[ -n $npm && -x $npm ]] || tg_die "npm not found; run: (cd $TG_DAEMON_DIR && npm ci)"

  echo "omarchy-omagram: installing daemon dependencies (first run only)..." >&2
  # --no-bin-links keeps the plugin folder free of symlinks, which Omarchy's
  # plugin validation rejects.
  (cd "$TG_DAEMON_DIR" &&
    PATH="$(dirname "$node"):$PATH" \
    "$npm" ci --omit=dev --no-bin-links --no-audit --no-fund) \
    || tg_die "dependency install failed"
  find "$TG_DAEMON_DIR/node_modules" -type l -delete 2>/dev/null || true
}

TG_UNIT_NAME="omarchy-omagram.service"
TG_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TG_BIN_LINK_DIR="$HOME/.local/bin"
TG_LIB_DIR="$HOME/.local/lib/omarchy-omagram"
TG_SWEEP_UNIT="omarchy-omagram-sweep.service"

tg_stop_service() {
  # A bar-widget disable unloads the QML component but does not know about
  # services started by the plugin. Keep the linked-device credentials so a
  # later re-enable can start the daemon again without another QR scan.
  systemctl --user disable --now "$TG_UNIT_NAME" >/dev/null 2>&1 || true
}

tg_ensure_cli() {
  mkdir -p "$TG_BIN_LINK_DIR"
  chmod +x "$TG_BIN_DIR"/* "$TG_DAEMON_DIR/ctl.js" 2>/dev/null || true
  local tool
  for tool in omarchy-omagram omarchy-omagram-ctl omarchy-omagram-focus omarchy-omagram-login omarchy-omagram-open omarchy-omagram-daemon; do
    ln -sfn "$TG_BIN_DIR/$tool" "$TG_BIN_LINK_DIR/$tool"
  done
}

tg_ensure_unit() {
  local node unit
  node="$(tg_node)"
  mkdir -p "$TG_UNIT_DIR"
  unit="$TG_UNIT_DIR/$TG_UNIT_NAME"
  sed -e "s|@PLUGIN_DIR@|$TG_ROOT|g" "$TG_ROOT/systemd/$TG_UNIT_NAME" >"$unit"
  if ! grep -q '^Environment=OMARCHY_OMAGRAM_NODE=' "$unit"; then
    sed -i "/^Environment=NODE_ENV=production/a Environment=OMARCHY_OMAGRAM_NODE=$node" "$unit"
  fi
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable "$TG_UNIT_NAME" >/dev/null 2>&1 || true
}

tg_ensure_sweep() {
  mkdir -p "$TG_LIB_DIR" "$TG_UNIT_DIR"
  cat >"$TG_LIB_DIR/sweep" <<'SWEEP'
#!/bin/bash
# Installed outside the plugin folder so it still runs after `omarchy plugin remove`.
set -euo pipefail
plugin="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins/io.github.terrifiedbug.omagram"
[[ -d $plugin ]] && exit 0
systemctl --user disable --now omarchy-omagram.service >/dev/null 2>&1 || true
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/omarchy-omagram.service"
rm -f "$HOME/.local/bin/omarchy-omagram" \
  "$HOME/.local/bin/omarchy-omagram-ctl" \
  "$HOME/.local/bin/omarchy-omagram-focus" \
  "$HOME/.local/bin/omarchy-omagram-login" \
  "$HOME/.local/bin/omarchy-omagram-open" \
  "$HOME/.local/bin/omarchy-omagram-daemon"
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/omarchy-omagram" \
  "${XDG_CACHE_HOME:-$HOME/.cache}/omarchy-omagram"
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/omarchy-omagram-sweep.service"
rm -rf "$HOME/.local/lib/omarchy-omagram"
systemctl --user daemon-reload >/dev/null 2>&1 || true
SWEEP
  chmod +x "$TG_LIB_DIR/sweep"
  cat >"$TG_UNIT_DIR/$TG_SWEEP_UNIT" <<EOF
[Unit]
Description=Remove leftover OmaGram bridge files if the plugin is gone
After=default.target

[Service]
Type=oneshot
ExecStart=$TG_LIB_DIR/sweep

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user enable "$TG_SWEEP_UNIT" >/dev/null 2>&1 || true
}

# Idempotent first-run setup so `omarchy plugin add --enable` is enough.
# The plugin manager never runs install.sh.
tg_ensure_setup() {
  chmod +x "$TG_BIN_DIR"/* "$TG_DAEMON_DIR/ctl.js" 2>/dev/null || true
  tg_ensure_deps
  tg_ensure_cli
  tg_ensure_unit
  tg_ensure_sweep
}

tg_purge_state() {
  rm -rf "$TG_STATE_DIR" \
    "${XDG_CACHE_HOME:-$HOME/.cache}/omarchy-omagram"
}

tg_uninstall() {
  systemctl --user disable --now "$TG_UNIT_NAME" >/dev/null 2>&1 || true
  systemctl --user disable --now "$TG_SWEEP_UNIT" >/dev/null 2>&1 || true
  rm -f "$TG_UNIT_DIR/$TG_UNIT_NAME" "$TG_UNIT_DIR/$TG_SWEEP_UNIT"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  local tool
  for tool in omarchy-omagram omarchy-omagram-ctl omarchy-omagram-focus omarchy-omagram-login omarchy-omagram-open omarchy-omagram-daemon; do
    [[ -L $TG_BIN_LINK_DIR/$tool || -f $TG_BIN_LINK_DIR/$tool ]] && rm -f "$TG_BIN_LINK_DIR/$tool"
  done
  tg_purge_state
  rm -rf "$TG_LIB_DIR"
}

tg_daemon_running() {
  [[ -S $TG_SOCKET ]] || return 1
  "$(tg_node)" "$TG_DAEMON_DIR/ctl.js" ping >/dev/null 2>&1
}
