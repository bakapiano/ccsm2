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
output_root="$(realpath -m "${CCSM_PACKAGE_OUTPUT_DIR:-${release_root}}")"
package_name="CCSM-${version}-ubuntu-24.04-x86_64"
stage_root="${release_root}/package/${package_name}"
archive_path="${output_root}/${package_name}.tar.gz"

if [[ "${CCSM_SKIP_BUILD:-0}" != "1" ]]; then
  (
    cd "${repo_root}"
    pnpm desktop:build:release
  )
fi

required_files=(
  "${release_root}/ccsm-desktop"
  "${repo_root}/README.md"
  "${repo_root}/LICENSE"
  "${repo_root}/scripts/ubuntu-release-README.md"
  "${repo_root}/scripts/ubuntu-release-run.sh"
  "${repo_root}/crates/ccsm-platform/vendor/portable-pty/LICENSE.md"
  "${repo_root}/crates/ccsm-platform/vendor/HERDR-APACHE-2.0.txt"
  "${repo_root}/crates/ccsm-platform/vendor/NOTICE.md"
)
for required_file in "${required_files[@]}"; do
  if [[ ! -f "${required_file}" ]]; then
    echo "Missing release artifact: ${required_file}" >&2
    exit 1
  fi
done

case "${stage_root}" in
  "${release_root}"/package/CCSM-*) ;;
  *)
    echo "Refusing to replace unexpected staging path: ${stage_root}" >&2
    exit 1
    ;;
esac

rm -rf -- "${stage_root}"
rm -f -- "${archive_path}" "${archive_path}.sha256"
mkdir -p "${stage_root}/THIRD-PARTY-NOTICES"

install -m 0755 "${release_root}/ccsm-desktop" "${stage_root}/ccsm-desktop"
install -m 0755 "${repo_root}/scripts/ubuntu-release-run.sh" "${stage_root}/run.sh"
sed "s/__VERSION__/${version}/g" \
  "${repo_root}/scripts/ubuntu-release-README.md" \
  >"${stage_root}/README-UBUNTU.md"
chmod 0644 "${stage_root}/README-UBUNTU.md"
install -m 0644 "${repo_root}/README.md" "${stage_root}/README.md"
install -m 0644 "${repo_root}/LICENSE" "${stage_root}/LICENSE"
install -m 0644 \
  "${repo_root}/crates/ccsm-platform/vendor/portable-pty/LICENSE.md" \
  "${stage_root}/THIRD-PARTY-NOTICES/portable-pty-LICENSE.md"
install -m 0644 \
  "${repo_root}/crates/ccsm-platform/vendor/HERDR-APACHE-2.0.txt" \
  "${stage_root}/THIRD-PARTY-NOTICES/HERDR-APACHE-2.0.txt"
install -m 0644 \
  "${repo_root}/crates/ccsm-platform/vendor/NOTICE.md" \
  "${stage_root}/THIRD-PARTY-NOTICES/VENDORED-COMPONENTS.md"

source_revision="$(git -C "${repo_root}" describe --always --dirty)"
binary_sha256="$(sha256sum "${stage_root}/ccsm-desktop" | cut -d' ' -f1)"
{
  printf 'Package: %s\n' "${package_name}"
  printf 'Source: %s\n' "${source_revision}"
  printf 'Built on: %s\n' "$(. /etc/os-release && printf '%s %s' "${NAME}" "${VERSION_ID}")"
  printf 'Architecture: %s\n' "$(uname -m)"
  printf 'ccsm-desktop SHA256: %s\n' "${binary_sha256}"
} >"${stage_root}/BUILD-INFO.txt"

mkdir -p "${output_root}"
tar -C "${release_root}/package" -czf "${archive_path}" "${package_name}"
archive_sha256="$(sha256sum "${archive_path}" | cut -d' ' -f1)"
printf '%s  %s\n' "${archive_sha256}" "$(basename "${archive_path}")" >"${archive_path}.sha256"

printf 'Archive: %s\n' "${archive_path}"
printf 'Bytes: %s\n' "$(stat -c %s "${archive_path}")"
printf 'SHA256: %s\n' "${archive_sha256}"
