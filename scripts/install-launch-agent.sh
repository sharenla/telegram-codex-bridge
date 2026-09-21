#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${0}")" && pwd)"
BRIDGE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
INSTANCE_ID="${1:-${BRIDGE_INSTANCE_ID:-default}}"
if (( $# > 1 )); then
  echo "usage: ${0:t} [instance-id]" >&2
  exit 2
fi
if [[ ! "${INSTANCE_ID}" =~ '^[a-z0-9][a-z0-9-]*$' ]]; then
  echo "instance-id must match ^[a-z0-9][a-z0-9-]*$: ${INSTANCE_ID}" >&2
  exit 2
fi

if [[ "${INSTANCE_ID}" == "default" ]]; then
  DEFAULT_SERVICE_ROOT="${HOME}/Library/Application Support/telegram-codex-bridge-service"
  DEFAULT_AGENT_LABEL="com.sharenla.telegram-codex-bridge"
else
  DEFAULT_SERVICE_ROOT="${HOME}/Library/Application Support/telegram-codex-bridge-${INSTANCE_ID}-service"
  DEFAULT_AGENT_LABEL="com.sharenla.telegram-codex-bridge.${INSTANCE_ID}"
fi

SERVICE_ROOT="${BRIDGE_SERVICE_ROOT:-${DEFAULT_SERVICE_ROOT}}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
AGENT_LABEL="${BRIDGE_AGENT_LABEL:-${DEFAULT_AGENT_LABEL}}"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${AGENT_LABEL}.plist"
SUPERVISOR_PATH="${SERVICE_ROOT}/scripts/codex-launch-supervisor.sh"
LAUNCH_LOG_DIR="${SERVICE_ROOT}/data/logs"
ENV_SOURCE="${BRIDGE_ENV_FILE:-}"
ROLE_SOURCE="${BRIDGE_ROLE_FILE:-}"
DRY_RUN="${BRIDGE_LAUNCH_AGENT_DRY_RUN:-0}"

if [[ -z "${ENV_SOURCE}" && "${INSTANCE_ID}" == "default" ]]; then
  ENV_SOURCE="${BRIDGE_ROOT}/.env"
fi
if [[ -n "${ENV_SOURCE}" && ! -f "${ENV_SOURCE}" ]]; then
  echo "bridge env file not found: ${ENV_SOURCE}" >&2
  exit 1
fi
if [[ -z "${ENV_SOURCE}" && ! -f "${SERVICE_ROOT}/.env" ]]; then
  echo "BRIDGE_ENV_FILE is required for a new named instance: ${INSTANCE_ID}" >&2
  exit 1
fi
if [[ -n "${ROLE_SOURCE}" && ! -f "${ROLE_SOURCE}" ]]; then
  echo "Codex role file not found: ${ROLE_SOURCE}" >&2
  exit 1
fi
if [[ "${INSTANCE_ID}" != "default" && -z "${ROLE_SOURCE}" && ! -f "${SERVICE_ROOT}/data/codex-home/AGENTS.md" ]]; then
  echo "BRIDGE_ROLE_FILE is required for a new named instance: ${INSTANCE_ID}" >&2
  exit 1
fi

env_value() {
  local key="$1"
  awk -v wanted="${key}" '
    index($0, wanted "=") == 1 {
      sub(/^[^=]*=/, "")
      gsub(/^[[:space:]\"]+|[[:space:]\"]+$/, "")
      print
      exit
    }
  ' "${ENV_SOURCE}"
}

if [[ -n "${ENV_SOURCE}" ]]; then
  BOT_TOKEN_VALUE="$(env_value TELEGRAM_BOT_TOKEN)"
  ALLOWLIST_VALUE="$(env_value TELEGRAM_ALLOWLIST)"
  if [[ -z "${BOT_TOKEN_VALUE}" || "${BOT_TOKEN_VALUE}" == *replace_me* ]]; then
    echo "TELEGRAM_BOT_TOKEN is missing or still a placeholder in ${ENV_SOURCE}" >&2
    exit 1
  fi
  if [[ -z "${ALLOWLIST_VALUE}" || "${ALLOWLIST_VALUE}" == *replace_me* ]]; then
    echo "TELEGRAM_ALLOWLIST is missing or still a placeholder in ${ENV_SOURCE}" >&2
    exit 1
  fi
  unset BOT_TOKEN_VALUE ALLOWLIST_VALUE
fi

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LAUNCH_LOG_DIR}" "${SERVICE_ROOT}"

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
if [[ -n "${CODEX_BIN:-}" ]]; then
  CODEX_BIN="${CODEX_BIN}"
elif [[ -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]]; then
  CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
elif [[ -x "${HOME}/.npm-global/bin/codex" ]]; then
  CODEX_BIN="${HOME}/.npm-global/bin/codex"
else
  CODEX_BIN="$(command -v codex || true)"
fi
if [[ -z "${CODEX_BIN}" || ! -x "${CODEX_BIN}" ]]; then
  echo "codex binary not found or not executable: ${CODEX_BIN:-<empty>}" >&2
  exit 1
fi

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'data/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '*.log' \
  "${BRIDGE_ROOT}/" "${SERVICE_ROOT}/"

mkdir -p "${SERVICE_ROOT}/data/codex-home" "${LAUNCH_LOG_DIR}"
if [[ -n "${ENV_SOURCE}" ]]; then
  cp "${ENV_SOURCE}" "${SERVICE_ROOT}/.env"
  chmod 600 "${SERVICE_ROOT}/.env"
fi
if [[ -n "${ROLE_SOURCE}" ]]; then
  cp "${ROLE_SOURCE}" "${SERVICE_ROOT}/data/codex-home/AGENTS.md"
  chmod 600 "${SERVICE_ROOT}/data/codex-home/AGENTS.md"
fi
chmod +x "${SUPERVISOR_PATH}" "${SERVICE_ROOT}/scripts/uninstall-launch-agent.sh" "${SERVICE_ROOT}/scripts/install-launch-agent.sh"
chmod +x "${SERVICE_ROOT}/scripts/rotate-bridge-logs.sh"

cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${AGENT_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>${SUPERVISOR_PATH}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>BRIDGE_ROOT</key>
      <string>${SERVICE_ROOT}</string>
      <key>BRIDGE_INSTANCE_ID</key>
      <string>${INSTANCE_ID}</string>
      <key>NODE_BIN</key>
      <string>${NODE_BIN}</string>
      <key>CODEX_BIN</key>
      <string>${CODEX_BIN}</string>
      <key>STORE_PATH</key>
      <string>${SERVICE_ROOT}/data/store.json</string>
      <key>CODEX_HOME</key>
      <string>${SERVICE_ROOT}/data/codex-home</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${SERVICE_ROOT}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LAUNCH_LOG_DIR}/launchd.stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${LAUNCH_LOG_DIR}/launchd.stderr.log</string>
  </dict>
</plist>
PLIST

chmod +x "${SUPERVISOR_PATH}"
if [[ "${DRY_RUN}" != "1" ]]; then
  launchctl bootout "gui/${UID}" "${PLIST_PATH}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
  launchctl kickstart -k "gui/${UID}/${AGENT_LABEL}"
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "Prepared launch agent (dry run): ${AGENT_LABEL}"
else
  echo "Installed launch agent: ${AGENT_LABEL}"
fi
echo "Instance: ${INSTANCE_ID}"
echo "Plist: ${PLIST_PATH}"
echo "Repo root: ${BRIDGE_ROOT}"
echo "Service root: ${SERVICE_ROOT}"
echo "Node: ${NODE_BIN}"
echo "Codex: ${CODEX_BIN}"
