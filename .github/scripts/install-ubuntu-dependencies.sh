#!/usr/bin/env bash

set -euo pipefail

readonly apt_mirror="${CCSM_APT_MIRROR:-https://archive.ubuntu.com/ubuntu/}"
readonly apt_mirror_file="${CCSM_APT_MIRROR_FILE:-/etc/apt/apt-mirrors.txt}"
readonly apt_max_attempts="${CCSM_APT_MAX_ATTEMPTS:-2}"
readonly apt_retry_delay_seconds="${CCSM_APT_RETRY_DELAY_SECONDS:-5}"
readonly apt_update_timeout_seconds="${CCSM_APT_UPDATE_TIMEOUT_SECONDS:-60}"
readonly apt_download_timeout_seconds="${CCSM_APT_DOWNLOAD_TIMEOUT_SECONDS:-180}"
readonly apt_get_command="${CCSM_APT_GET_COMMAND:-apt-get}"
readonly timeout_command="${CCSM_TIMEOUT_COMMAND:-timeout}"

if [[ $# -eq 0 ]]; then
  echo "::error title=Ubuntu dependency list is empty::Pass at least one package to install."
  exit 2
fi

if [[ "${EUID}" -ne 0 && "${CCSM_APT_ALLOW_NON_ROOT:-0}" != "1" ]]; then
  echo "::error title=Ubuntu dependency installer needs root::Run this script through sudo."
  exit 2
fi

require_positive_integer() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error title=Invalid ${name}::Expected a positive integer, received '${value}'."
    exit 2
  fi
}

require_non_negative_integer() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "::error title=Invalid ${name}::Expected a non-negative integer, received '${value}'."
    exit 2
  fi
}

require_positive_integer "CCSM_APT_MAX_ATTEMPTS" "$apt_max_attempts"
require_non_negative_integer "CCSM_APT_RETRY_DELAY_SECONDS" "$apt_retry_delay_seconds"
require_positive_integer "CCSM_APT_UPDATE_TIMEOUT_SECONDS" "$apt_update_timeout_seconds"
require_positive_integer "CCSM_APT_DOWNLOAD_TIMEOUT_SECONDS" "$apt_download_timeout_seconds"

if [[ ! -f "$apt_mirror_file" ]]; then
  echo "::error title=APT mirror list is unavailable::Expected runner mirror list at '${apt_mirror_file}'."
  exit 2
fi

printf '%s\tpriority:1\n' "$apt_mirror" >"$apt_mirror_file"
echo "Selected Ubuntu APT mirror: ${apt_mirror}"
echo "APT network policy: attempts=${apt_max_attempts}, update-timeout=${apt_update_timeout_seconds}s, download-timeout=${apt_download_timeout_seconds}s"

readonly -a apt_options=(
  -o "Acquire::Retries=2"
  -o "Acquire::http::Timeout=20"
  -o "Acquire::https::Timeout=20"
  -o "Acquire::ForceIPv4=true"
  -o "Dpkg::Use-Pty=0"
)

run_network_phase() {
  local phase="$1"
  local timeout_seconds="$2"
  shift 2

  local attempt
  local exit_code
  for ((attempt = 1; attempt <= apt_max_attempts; attempt += 1)); do
    echo "::group::APT ${phase} (attempt ${attempt}/${apt_max_attempts})"
    if "$timeout_command" \
      --signal=TERM \
      --kill-after=10s \
      "${timeout_seconds}s" \
      "$apt_get_command" "${apt_options[@]}" "$@"; then
      echo "::endgroup::"
      return 0
    else
      exit_code=$?
    fi
    echo "::endgroup::"

    if ((attempt < apt_max_attempts)); then
      echo "::warning title=APT ${phase} will retry::Attempt ${attempt}/${apt_max_attempts} exited with code ${exit_code}."
      sleep "$apt_retry_delay_seconds"
    fi
  done

  echo "::error title=APT ${phase} exhausted retries::${apt_max_attempts} attempts completed; last exit code was ${exit_code}."
  return "$exit_code"
}

export DEBIAN_FRONTEND=noninteractive

run_network_phase "index update" "$apt_update_timeout_seconds" update
run_network_phase \
  "package download" \
  "$apt_download_timeout_seconds" \
  install \
  --download-only \
  -y \
  --no-install-recommends \
  "$@"

echo "::group::Install downloaded Ubuntu packages"
"$apt_get_command" \
  "${apt_options[@]}" \
  install \
  --no-download \
  -y \
  --no-install-recommends \
  "$@"
echo "::endgroup::"
