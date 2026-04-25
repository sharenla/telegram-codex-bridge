#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${0}")" && pwd)"
BRIDGE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVICE_ROOT="${HOME}/Library/Application Support/telegram-codex-bridge-service"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
AGENT_LABEL="com.sharenla.telegram-codex-bridge"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${AGENT_LABEL}.plist"
SUPERVISOR_PATH="${SERVICE_ROOT}/scripts/codex-launch-supervisor.sh"
LAUNCH_LOG_DIR="${SERVICE_ROOT}/data/logs"

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LAUNCH_LOG_DIR}" "${SERVICE_ROOT}"

resolve_node_bin() {
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
elif [[ -x "/Applications/Codex.app/Contents/Resources/codex" ]]; then
  CODEX_BIN="/Applications/Codex.app/Contents/Resources/codex"
else
  CODEX_BIN="$(command -v codex || true)"
fi
if [[ -z "${CODEX_BIN}" ]]; then
  echo "codex binary not found" >&2
  exit 1
fi

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'data/' \
  --exclude '*.log' \
  "${BRIDGE_ROOT}/" "${SERVICE_ROOT}/"

mkdir -p "${SERVICE_ROOT}/data" "${LAUNCH_LOG_DIR}"
chmod +x "${SUPERVISOR_PATH}" "${SERVICE_ROOT}/scripts/uninstall-launch-agent.sh" "${SERVICE_ROOT}/scripts/install-launch-agent.sh"

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
launchctl bootout "gui/${UID}" "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
launchctl kickstart -k "gui/${UID}/${AGENT_LABEL}"

echo "Installed launch agent: ${AGENT_LABEL}"
echo "Plist: ${PLIST_PATH}"
echo "Repo root: ${BRIDGE_ROOT}"
echo "Service root: ${SERVICE_ROOT}"
echo "Node: ${NODE_BIN}"
echo "Codex: ${CODEX_BIN}"
