#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-}"
if [[ -z "${version}" ]]; then
  version="$(cd "${repo_root}" && node -p "require('./package.json').version")"
fi
if [[ ! "${version}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid release version: ${version}" >&2
  exit 1
fi

target_root="${CARGO_TARGET_DIR:-${repo_root}/target}"
release_root="${target_root}/release"
bundle_root="${release_root}/bundle"
output_root="$(realpath -m "${CCSM_PACKAGE_OUTPUT_DIR:-${release_root}/dist}")"

if [[ "${CCSM_SKIP_BUILD:-0}" != "1" ]]; then
  (
    cd "${repo_root}"
    pnpm desktop:build:release
  )
fi

single_file() {
  local directory="$1"
  local pattern="$2"
  local files=()
  mapfile -t files < <(find "${directory}" -maxdepth 1 -type f -name "${pattern}" -print | sort)
  if [[ "${#files[@]}" -ne 1 ]]; then
    echo "Expected one ${pattern} in ${directory}, found ${#files[@]}" >&2
    exit 1
  fi
  printf '%s\n' "${files[0]}"
}

deb_path="$(single_file "${bundle_root}/deb" "*_${version}_amd64.deb")"
deb_signature="${deb_path}.sig"
appimage_path="$(single_file "${bundle_root}/appimage" "*_${version}_amd64.AppImage")"
appimage_signature="${appimage_path}.sig"

for required_file in "${deb_signature}" "${appimage_signature}"; do
  if [[ ! -f "${required_file}" ]]; then
    echo "Missing signed updater artifact: ${required_file}" >&2
    exit 1
  fi
done

dpkg-deb --info "${deb_path}" >/dev/null
file "${appimage_path}" | grep -q 'ELF'

mkdir -p "${output_root}"
deb_name="CCSM-${version}-linux-x86_64.deb"
appimage_name="CCSM-${version}-linux-x86_64.AppImage"

install -m 0644 "${deb_path}" "${output_root}/${deb_name}"
install -m 0644 "${deb_signature}" "${output_root}/${deb_name}.sig"
install -m 0755 "${appimage_path}" "${output_root}/${appimage_name}"
install -m 0644 "${appimage_signature}" "${output_root}/${appimage_name}.sig"

(
  cd "${output_root}"
  sha256sum "${deb_name}" "${appimage_name}" \
    >"SHA256SUMS-linux-x86_64.txt"
)

printf 'DEB: %s\n' "${output_root}/${deb_name}"
printf 'AppImage: %s\n' "${output_root}/${appimage_name}"
printf 'Updater: %s\n' "${output_root}/${appimage_name}"
printf 'Checksums: %s\n' "${output_root}/SHA256SUMS-linux-x86_64.txt"
