#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
signing_root="${repo_root}/target/local-signing"
private_key="${signing_root}/linux-local.key"
password="ccsm-linux-local-test"

mkdir -p "${signing_root}"
cleanup() {
  rm -f -- "${private_key}" "${private_key}.pub"
}
trap cleanup EXIT

(
  cd "${repo_root}"
  pnpm --filter @ccsm/desktop tauri signer generate \
    --ci \
    --force \
    --password "${password}" \
    --write-keys "${private_key}" >/dev/null
)

export TAURI_SIGNING_PRIVATE_KEY="$(<"${private_key}")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${password}"
bash "${repo_root}/scripts/package-ubuntu.sh" "${1:-}"
