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
APP_SERVER_MISS_LIMIT="${APP_SERVER_MISS_LIMIT:-3}"

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

if [[ -z "${CODEX_BIN:-}" || ! -x "${CODEX_BIN}" ]]; then
  echo "codex binary not found or not executable: ${CODEX_BIN:-<empty>}" >&2
  exit 1
fi

codex_version="$("${CODEX_BIN}" --version 2>&1 | head -n 1 || true)"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Supervisor ready; node=${NODE_BIN}; codex=${CODEX_BIN}; version=${codex_version:-unknown}; health=bridge_child_app_server; miss_limit=${APP_SERVER_MISS_LIMIT}" >> "${BRIDGE_STDOUT}"

bridge_pids() {
  pgrep -f "${BRIDGE_ENTRY}" || true
}

bridge_app_server_running() {
  local bridge_pid
  while IFS= read -r bridge_pid; do
    [[ -n "${bridge_pid}" ]] || continue
    if pgrep -P "${bridge_pid}" -f "${CODEX_BIN} app-server .*--listen stdio://" >/dev/null 2>&1; then
      return 0
    fi
  done <<< "$(bridge_pids)"
  return 1
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

app_server_misses=0
while true; do
  if [[ -z "$(bridge_pids)" ]]; then
    start_bridge
    app_server_misses=0
  elif bridge_app_server_running; then
    app_server_misses=0
  else
    (( app_server_misses += 1 ))
    if (( app_server_misses >= APP_SERVER_MISS_LIMIT )); then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bridge app-server unhealthy for ${app_server_misses} checks; restarting" >> "${BRIDGE_STDERR}"
      stop_bridge
      start_bridge
      app_server_misses=0
    fi
  fi

  sleep "${POLL_INTERVAL}"
done
