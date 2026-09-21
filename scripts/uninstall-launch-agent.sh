#!/bin/zsh
set -euo pipefail

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
  AGENT_LABEL="${BRIDGE_AGENT_LABEL:-com.sharenla.telegram-codex-bridge}"
  SERVICE_ROOT="${BRIDGE_SERVICE_ROOT:-${HOME}/Library/Application Support/telegram-codex-bridge-service}"
else
  AGENT_LABEL="${BRIDGE_AGENT_LABEL:-com.sharenla.telegram-codex-bridge.${INSTANCE_ID}}"
  SERVICE_ROOT="${BRIDGE_SERVICE_ROOT:-${HOME}/Library/Application Support/telegram-codex-bridge-${INSTANCE_ID}-service}"
fi
PLIST_PATH="${HOME}/Library/LaunchAgents/${AGENT_LABEL}.plist"

if [[ "${BRIDGE_LAUNCH_AGENT_DRY_RUN:-0}" != "1" ]]; then
  launchctl bootout "gui/${UID}" "${PLIST_PATH}" >/dev/null 2>&1 || true
  rm -f "${PLIST_PATH}"
  echo "Removed launch agent: ${AGENT_LABEL}"
else
  echo "Would remove launch agent (dry run): ${AGENT_LABEL}"
fi

echo "Preserved service data: ${SERVICE_ROOT}/data"
