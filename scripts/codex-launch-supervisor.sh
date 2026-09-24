#!/bin/zsh
set -euo pipefail
zmodload zsh/datetime

SCRIPT_DIR="$(cd -- "$(dirname -- "${0}")" && pwd)"
BRIDGE_ROOT="${BRIDGE_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
BRIDGE_ENTRY="${BRIDGE_ROOT}/index.js"
PID_FILE="${BRIDGE_ROOT}/data/bridge.pid"
LOG_DIR="${BRIDGE_ROOT}/data/logs"
BRIDGE_STDOUT="${LOG_DIR}/bridge.stdout.log"
BRIDGE_STDERR="${LOG_DIR}/bridge.stderr.log"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
APP_SERVER_MISS_LIMIT="${APP_SERVER_MISS_LIMIT:-3}"
START_GRACE_SECONDS="${START_GRACE_SECONDS:-60}"
LOG_ROTATE_CHECK_INTERVAL="${LOG_ROTATE_CHECK_INTERVAL:-60}"
LOG_ROTATE_SCRIPT="${BRIDGE_ROOT}/scripts/rotate-bridge-logs.sh"
SUPERVISOR_ENV_FILE="${SUPERVISOR_ENV_FILE:-${BRIDGE_ROOT}/.env}"
SUPERVISOR_ALERT_FILE="${BRIDGE_ROOT}/data/supervisor-alert.json"
SUPERVISOR_ALERT_COOLDOWN=1800
ALERT_IN_FLIGHT=0

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
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Supervisor ready; node=${NODE_BIN}; codex=${CODEX_BIN}; version=${codex_version:-unknown}; health=bridge_child_app_server; miss_limit=${APP_SERVER_MISS_LIMIT}; start_grace=${START_GRACE_SECONDS}" >> "${BRIDGE_STDOUT}"

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
  bridge_started_at=${EPOCHREALTIME}
}

read_env_value() {
  local key="$1"
  [[ -r "${SUPERVISOR_ENV_FILE}" ]] || return 0
  sed -n -E "s/^${key}=(.*)$/\\1/p" "${SUPERVISOR_ENV_FILE}" | tail -n 1 | sed -E 's/^\"(.*)\"$/\\1/; s/^\\x27(.*)\\x27$/\\1/'
}

redact_alert_error() {
  local line="$1"
  printf '%s' "${line}" | sed -E 's|bot[0-9]+:[A-Za-z0-9_-]+|bot<REDACTED>|g; s|(https?://[^ ?]+)\?[^ ]*|\1?REDACTED|g' | tr '\n' ' ' | cut -c1-120
}

latest_bridge_error() {
  [[ -r "${BRIDGE_STDERR}" ]] || return 0
  local line
  line="$(grep -v '^[[:space:]]*$' "${BRIDGE_STDERR}" | tail -n 1 || true)"
  redact_alert_error "${line}"
}

alert_state_value() {
  local key="$1"
  [[ -r "${SUPERVISOR_ALERT_FILE}" ]] || return 0
  sed -n -E "s/.*\"${key}\"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p" "${SUPERVISOR_ALERT_FILE}" | head -n 1
}

alert_state_active() {
  [[ -r "${SUPERVISOR_ALERT_FILE}" ]] || return 0
  sed -n -E 's/.*"active"[[:space:]]*:[[:space:]]*(true|false).*/\1/p' "${SUPERVISOR_ALERT_FILE}" | head -n 1
}

write_alert_state() {
  local alerted_at="$1" failure_count="$2" active="${3:-true}"
  printf '{"alertedAt":%s,"failureCount":%s,"active":%s}\n' "${alerted_at}" "${failure_count}" "${active}" > "${SUPERVISOR_ALERT_FILE}"
}

send_supervisor_message() {
  local text="$1"
  local token allowlist chat sent=0
  token="$(read_env_value TELEGRAM_BOT_TOKEN)"
  allowlist="$(read_env_value TELEGRAM_ALLOWLIST)"
  [[ -n "${token}" && -n "${allowlist}" ]] || { echo "[$(date '+%Y-%m-%d %H:%M:%S')] Supervisor alert skipped: token or allowlist unavailable" >> "${BRIDGE_STDERR}"; return 1; }
  while IFS= read -r chat; do
    [[ -n "${chat}" && "${chat}" != -* && "${chat}" != 0 ]] || continue
    if printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "${token}" | \
      curl --silent --show-error --max-time 10 --config - \
        --data-urlencode "chat_id=${chat}" --data-urlencode "text=${text}" 2>&1 \
        | sed -E 's|bot[0-9]+:[A-Za-z0-9_-]+|bot<REDACTED>|g' >> "${BRIDGE_STDERR}"; then
      sent=1
    fi
  done <<< "$(printf '%s' "${allowlist}" | tr ',' '\n')"
  (( sent == 1 )) || { echo "[$(date '+%Y-%m-%d %H:%M:%S')] Supervisor alert delivery failed" >> "${BRIDGE_STDERR}"; return 1; }
  return 0
}

queue_supervisor_alert() {
  local count="$1" now alerted_at text error
  (( ALERT_IN_FLIGHT == 0 )) || return 0
  alerted_at="$(alert_state_value alertedAt)"
  now="$(date '+%s')"
  if [[ "$(alert_state_active)" == "true" ]]; then return 0; fi
  if [[ -n "${alerted_at}" ]] && (( now - alerted_at < SUPERVISOR_ALERT_COOLDOWN )); then return 0; fi
  error="$(latest_bridge_error)"
  text="⚠️ ${BRIDGE_INSTANCE_ID:-telegram-codex-bridge} 连续 ${count} 次启动失败，app-server 没能起来。最近错误：${error:-未知错误}。supervisor 会继续重试。"
  write_alert_state "${now}" "${count}"
  ALERT_IN_FLIGHT=1
  ( send_supervisor_message "${text}" || rm -f "${SUPERVISOR_ALERT_FILE}" ) &!
}

queue_supervisor_recovery() {
  local count alerted_at text
  alerted_at="$(alert_state_value alertedAt)"
  [[ -n "${alerted_at}" ]] || return 0
  count="$(alert_state_value failureCount)"
  text="✅ ${BRIDGE_INSTANCE_ID:-telegram-codex-bridge} 已恢复运行（之前连续 ${count:-0} 次启动失败）"
  if send_supervisor_message "${text}"; then
    write_alert_state "${alerted_at}" "${count:-0}" "false"
  fi
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

wait_for_bridge_stop() {
  local attempt
  for attempt in {1..50}; do
    if [[ -z "$(bridge_pids)" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

last_log_rotation_epoch=0
rotate_logs_if_due() {
  local now_epoch
  local restart_after_rotation=0
  now_epoch="$(date '+%s')"
  if (( now_epoch - last_log_rotation_epoch < LOG_ROTATE_CHECK_INTERVAL )); then
    return
  fi
  last_log_rotation_epoch="${now_epoch}"

  if [[ ! -x "${LOG_ROTATE_SCRIPT}" ]]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Log rotation script is missing or not executable: ${LOG_ROTATE_SCRIPT}" >> "${BRIDGE_STDERR}"
    return
  fi

  if BRIDGE_ROOT="${BRIDGE_ROOT}" "${LOG_ROTATE_SCRIPT}" --needs-rotation; then
    if [[ -n "$(bridge_pids)" ]]; then
      stop_bridge
      if ! wait_for_bridge_stop; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bridge log rotation skipped because the bridge did not stop cleanly" >> "${BRIDGE_STDERR}"
        return
      fi
      restart_after_rotation=1
    fi
  fi

  if ! BRIDGE_ROOT="${BRIDGE_ROOT}" "${LOG_ROTATE_SCRIPT}"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bridge log rotation failed" >> "${BRIDGE_STDERR}"
  fi
  if (( restart_after_rotation )); then
    start_bridge
  fi
}

cleanup() {
  stop_bridge
  exit 0
}

trap cleanup INT TERM

app_server_misses=0
consecutive_unhealthy_restarts=0
current_start_grace=${START_GRACE_SECONDS}
bridge_started_at=${EPOCHREALTIME}
while true; do
  rotate_logs_if_due
  if [[ -z "$(bridge_pids)" ]]; then
    start_bridge
    app_server_misses=0
  elif bridge_app_server_running; then
    if [[ -r "${SUPERVISOR_ALERT_FILE}" ]]; then
      queue_supervisor_recovery
    fi
    if (( app_server_misses > 0 || consecutive_unhealthy_restarts > 0 )); then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bridge app-server healthy; reset misses=${app_server_misses}; consecutive=0; start_grace=${START_GRACE_SECONDS}" >> "${BRIDGE_STDOUT}"
    fi
    app_server_misses=0
    consecutive_unhealthy_restarts=0
    current_start_grace=${START_GRACE_SECONDS}
  else
    if (( EPOCHREALTIME - bridge_started_at < current_start_grace )); then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bridge startup grace: skip missing app-server; grace=${current_start_grace}" >> "${BRIDGE_STDOUT}"
      sleep "${POLL_INTERVAL}"
      continue
    fi
    (( app_server_misses += 1 ))
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bridge app-server miss=${app_server_misses}/${APP_SERVER_MISS_LIMIT}" >> "${BRIDGE_STDOUT}"
    if (( app_server_misses >= APP_SERVER_MISS_LIMIT )); then
      (( consecutive_unhealthy_restarts += 1 ))
      # Three fixed levels: 60 / 120 / 300 by default, scaled for a custom base.
      if (( consecutive_unhealthy_restarts == 1 )); then
        current_start_grace=$(( START_GRACE_SECONDS * 2 ))
      else
        current_start_grace=$(( START_GRACE_SECONDS * 5 ))
      fi
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bridge app-server unhealthy for ${app_server_misses} checks; restarting; consecutive=${consecutive_unhealthy_restarts}; next_grace=${current_start_grace}" >> "${BRIDGE_STDERR}"
      if (( consecutive_unhealthy_restarts >= 3 )); then
        queue_supervisor_alert "${consecutive_unhealthy_restarts}"
      fi
      stop_bridge
      if wait_for_bridge_stop; then
        start_bridge
      fi
      app_server_misses=0
    fi
  fi

  sleep "${POLL_INTERVAL}"
done
