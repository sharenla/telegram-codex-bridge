#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${0}")" && pwd)"
BRIDGE_ROOT="${BRIDGE_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
BRIDGE_ENTRY="${BRIDGE_ROOT}/index.js"
PID_FILE="${BRIDGE_ROOT}/data/bridge.pid"
LOG_DIR="${BRIDGE_ROOT}/data/logs"
BRIDGE_STDOUT="${LOG_DIR}/bridge.stdout.log"
BRIDGE_STDERR="${LOG_DIR}/bridge.stderr.log"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
CODEX_PROCESS_PATTERN="${CODEX_PROCESS_PATTERN:-/Applications/Codex.app/Contents/MacOS/Codex}"

mkdir -p "${LOG_DIR}" "${BRIDGE_ROOT}/data"

resolve_node_bin() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    echo "${NODE_BIN}"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi

  if [[ -x "/opt/homebrew/bin/node" ]]; then
    echo "/opt/homebrew/bin/node"
    return
  fi

  if [[ -x "/usr/local/bin/node" ]]; then
    echo "/usr/local/bin/node"
    return
  fi

  echo "node binary not found" >&2
  exit 1
}

NODE_BIN="$(resolve_node_bin)"

is_codex_running() {
  pgrep -f "${CODEX_PROCESS_PATTERN}" >/dev/null 2>&1
}

bridge_pids() {
  pgrep -f "${BRIDGE_ENTRY}" || true
}

start_bridge() {
  if [[ -n "$(bridge_pids)" ]]; then
    return
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Telegram Codex bridge" >> "${BRIDGE_STDOUT}"
  "${NODE_BIN}" "${BRIDGE_ENTRY}" >> "${BRIDGE_STDOUT}" 2>> "${BRIDGE_STDERR}" &
  echo $! > "${PID_FILE}"
}

stop_bridge() {
  local pids
  pids="$(bridge_pids)"
  if [[ -z "${pids}" ]]; then
    rm -f "${PID_FILE}"
    return
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Stopping Telegram Codex bridge" >> "${BRIDGE_STDOUT}"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill "${pid}" 2>/dev/null || true
  done <<< "${pids}"
  rm -f "${PID_FILE}"
}

cleanup() {
  stop_bridge
  exit 0
}

trap cleanup INT TERM

while true; do
  if is_codex_running; then
    start_bridge
  else
    stop_bridge
  fi

  sleep "${POLL_INTERVAL}"
done
