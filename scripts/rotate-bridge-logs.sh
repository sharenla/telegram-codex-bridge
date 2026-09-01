#!/bin/zsh
set -euo pipefail

umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${0}")" && pwd)"
BRIDGE_ROOT="${BRIDGE_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
LOG_DIR="${BRIDGE_LOG_DIR:-${BRIDGE_ROOT}/data/logs}"
STDOUT_LOG="${BRIDGE_STDOUT_LOG:-${LOG_DIR}/bridge.stdout.log}"
STDERR_LOG="${BRIDGE_STDERR_LOG:-${LOG_DIR}/bridge.stderr.log}"

STDOUT_MAX_BYTES="${BRIDGE_STDOUT_MAX_BYTES:-10485760}"
STDERR_MAX_BYTES="${BRIDGE_STDERR_MAX_BYTES:-26214400}"
RETAIN_FILES="${BRIDGE_LOG_RETAIN_FILES:-7}"
MAX_AGE_DAYS="${BRIDGE_LOG_MAX_AGE_DAYS:-14}"
TOTAL_MAX_BYTES="${BRIDGE_LOG_TOTAL_MAX_BYTES:-209715200}"
LOCK_DIR="${LOG_DIR}/.rotation.lock"
LOCK_PID_FILE="${LOCK_DIR}/pid"
TMP_ARCHIVE=""
MODE="${1:-rotate}"

if (( $# > 1 )) || [[ "${MODE}" != "rotate" && "${MODE}" != "--needs-rotation" ]]; then
  echo "usage: ${0:t} [--needs-rotation]" >&2
  exit 2
fi

require_uint() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ '^[0-9]+$' ]]; then
    echo "${name} must be a non-negative integer: ${value}" >&2
    exit 2
  fi
}

for setting in \
  "BRIDGE_STDOUT_MAX_BYTES:${STDOUT_MAX_BYTES}" \
  "BRIDGE_STDERR_MAX_BYTES:${STDERR_MAX_BYTES}" \
  "BRIDGE_LOG_RETAIN_FILES:${RETAIN_FILES}" \
  "BRIDGE_LOG_MAX_AGE_DAYS:${MAX_AGE_DAYS}" \
  "BRIDGE_LOG_TOTAL_MAX_BYTES:${TOTAL_MAX_BYTES}"; do
  require_uint "${setting%%:*}" "${setting#*:}"
done

mkdir -p "${LOG_DIR}"

file_size_bytes() {
  local file_path="$1"
  if [[ ! -f "${file_path}" ]]; then
    echo 0
    return
  fi
  stat -f '%z' "${file_path}"
}

if [[ "${MODE}" == "--needs-rotation" ]]; then
  if (( $(file_size_bytes "${STDERR_LOG}") > STDERR_MAX_BYTES )) \
    || (( $(file_size_bytes "${STDOUT_LOG}") > STDOUT_MAX_BYTES )); then
    exit 0
  fi
  exit 1
fi

acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    printf '%s\n' "$$" > "${LOCK_PID_FILE}"
    return 0
  fi

  local owner_pid=""
  if [[ -f "${LOCK_PID_FILE}" ]]; then
    owner_pid="$(<"${LOCK_PID_FILE}")"
  fi
  if [[ "${owner_pid}" =~ '^[0-9]+$' ]] && kill -0 "${owner_pid}" 2>/dev/null; then
    return 1
  fi

  rm -f -- "${LOCK_PID_FILE}"
  rmdir "${LOCK_DIR}" 2>/dev/null || return 1
  mkdir "${LOCK_DIR}"
  printf '%s\n' "$$" > "${LOCK_PID_FILE}"
}

if ! acquire_lock; then
  exit 0
fi

cleanup() {
  if [[ -n "${TMP_ARCHIVE}" ]]; then
    rm -f -- "${TMP_ARCHIVE}"
  fi
  rm -f -- "${LOCK_PID_FILE}"
  rmdir "${LOCK_DIR}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sanitize_log_stream() {
  local file_path="$1"
  sed -E \
    -e 's#https://api\.telegram\.org/bot[^/[:space:]]+#https://api.telegram.org/bot<redacted>#g' \
    -e 's#([Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+)[^[:space:]"]+#\1<redacted>#g' \
    -e 's#((TELEGRAM_BOT_TOKEN|CODEX_LB_API_KEY|OPENAI_API_KEY)=)[^[:space:]]+#\1<redacted>#g' \
    "${file_path}"
}

rotate_if_oversized() {
  local log_file="$1"
  local max_bytes="$2"
  local size_bytes
  size_bytes="$(file_size_bytes "${log_file}")"
  if (( size_bytes <= max_bytes )); then
    return
  fi

  local timestamp
  timestamp="$(date '+%Y%m%d-%H%M%S')"
  local archive_path="${log_file}.${timestamp}.$$.gz"
  TMP_ARCHIVE="${archive_path}.tmp"
  sanitize_log_stream "${log_file}" | gzip -c > "${TMP_ARCHIVE}"
  mv -f -- "${TMP_ARCHIVE}" "${archive_path}"
  TMP_ARCHIVE=""
  : > "${log_file}"
}

prune_by_age() {
  find "${LOG_DIR}" -type f \
    \( -name 'bridge.stdout.log.*.gz' -o -name 'bridge.stderr.log.*.gz' \) \
    -mtime "+${MAX_AGE_DAYS}" -exec rm -f -- {} +
}

prune_by_count() {
  local log_file="$1"
  local archive
  local count=0
  while IFS= read -r archive; do
    [[ -n "${archive}" ]] || continue
    (( count += 1 ))
    if (( count > RETAIN_FILES )); then
      rm -f -- "${archive}"
    fi
  done < <(find "${LOG_DIR}" -maxdepth 1 -type f -name "${log_file:t}.*.gz" -print | LC_ALL=C sort -r)
}

log_dir_size_bytes() {
  find "${LOG_DIR}" -type f -exec stat -f '%z' {} \; | awk '{ total += $1 } END { print total + 0 }'
}

prune_to_total_cap() {
  local total_bytes
  local oldest_archive
  total_bytes="$(log_dir_size_bytes)"
  while (( total_bytes > TOTAL_MAX_BYTES )); do
    oldest_archive="$(find "${LOG_DIR}" -maxdepth 1 -type f \
      \( -name 'bridge.stdout.log.*.gz' -o -name 'bridge.stderr.log.*.gz' \) \
      -print | LC_ALL=C sort | head -n 1)"
    if [[ -z "${oldest_archive}" ]]; then
      break
    fi
    rm -f -- "${oldest_archive}"
    total_bytes="$(log_dir_size_bytes)"
  done
}

rotate_if_oversized "${STDERR_LOG}" "${STDERR_MAX_BYTES}"
rotate_if_oversized "${STDOUT_LOG}" "${STDOUT_MAX_BYTES}"
prune_by_age
prune_by_count "${STDERR_LOG}"
prune_by_count "${STDOUT_LOG}"
prune_to_total_cap
