#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-}"
dist_root="${2:-${repo_root}/target/release/dist}"
if [[ -z "${version}" ]]; then
  echo "Usage: test-linux-packages.sh <version> [dist-directory]" >&2
  exit 2
fi
live_ccsm_processes() {
  ps -C ccsm-desktop -o pid=,stat=,args= 2>/dev/null |
    awk '$2 !~ /^Z/ { print }'
}

wait_for_no_live_ccsm() {
  for _attempt in $(seq 1 50); do
    if [[ -z "$(live_ccsm_processes)" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if ! wait_for_no_live_ccsm; then
  echo "Refusing package smoke with a pre-existing ccsm-desktop process" >&2
  live_ccsm_processes >&2
  exit 1
fi

deb="${dist_root}/CCSM-${version}-linux-x86_64.deb"
appimage="${dist_root}/CCSM-${version}-linux-x86_64.AppImage"
package_name="$(dpkg-deb -f "${deb}" Package)"
data_root="${CCSM_PACKAGE_SMOKE_DATA_DIR:-${repo_root}/target/package-smoke-data}"
log_root="${CCSM_PACKAGE_SMOKE_LOG_DIR:-${data_root}}"
candidate_version="${CCSM_UPDATE_E2E_CANDIDATE_VERSION:-}"
candidate_root="${CCSM_UPDATE_E2E_CANDIDATE_ROOT:-}"
endpoint_port="${CCSM_UPDATE_E2E_ENDPOINT_PORT:-0}"
driver_port_base="${CCSM_UPDATE_E2E_DRIVER_PORT_BASE:-0}"
package_installed=0

run_dpkg() {
  if [[ "${EUID}" -eq 0 ]]; then
    dpkg "$@"
  else
    sudo dpkg "$@"
  fi
}

cleanup() {
  if [[ "${package_installed}" == "1" ]]; then
    run_dpkg -r "${package_name}" >/dev/null
  fi
}
trap cleanup EXIT

mkdir -p "${data_root}/deb" "${data_root}/appimage" "${log_root}"
if [[ -n "${candidate_version}" ]]; then
  if [[ -z "${candidate_root}" || "${endpoint_port}" == "0" || "${driver_port_base}" == "0" ]]; then
    echo "Candidate root, endpoint port and driver port base are required for updater E2E" >&2
    exit 2
  fi
  candidate_deb="${candidate_root}/CCSM-${candidate_version}-linux-x86_64.deb"
  candidate_appimage="${candidate_root}/CCSM-${candidate_version}-linux-x86_64.AppImage"
  for candidate_file in \
    "${candidate_deb}" "${candidate_deb}.sig" \
    "${candidate_appimage}" "${candidate_appimage}.sig"; do
    test -f "${candidate_file}"
  done

  update_output="${log_root}/installed-update"
  mkdir -p "${update_output}"
  run_dpkg -i "${deb}"
  package_installed=1
  test -x /usr/bin/ccsm-desktop
  xvfb-run -a --server-args="-screen 0 1440x900x24" \
    node "${repo_root}/apps/desktop/scripts/run-installed-update-e2e.mjs" \
      --app-binary /usr/bin/ccsm-desktop \
      --update-artifact "${candidate_deb}" \
      --update-signature "${candidate_deb}.sig" \
      --target linux-x86_64-deb \
      --base-version "${version}" \
      --candidate-version "${candidate_version}" \
      --endpoint-port "${endpoint_port}" \
      --driver-port "${driver_port_base}" \
      --data-dir "${data_root}/deb" \
      --output-dir "${update_output}" \
      --variant linux-deb
  installed_version="$(dpkg-query -W -f='${Version}' "${package_name}")"
  if [[ "${installed_version}" != "${candidate_version}" ]]; then
    echo "Expected DEB version ${candidate_version}, received ${installed_version}" >&2
    exit 1
  fi
  run_dpkg -r "${package_name}" >/dev/null
  package_installed=0

  installed_appimage="${data_root}/appimage/CCSM.AppImage"
  install -m 0755 "${appimage}" "${installed_appimage}"
  xvfb-run -a --server-args="-screen 0 1440x900x24" \
    node "${repo_root}/apps/desktop/scripts/run-installed-update-e2e.mjs" \
      --app-binary "${installed_appimage}" \
      --update-artifact "${candidate_appimage}" \
      --update-signature "${candidate_appimage}.sig" \
      --target linux-x86_64-appimage \
      --base-version "${version}" \
      --candidate-version "${candidate_version}" \
      --endpoint-port "${endpoint_port}" \
      --driver-port "$((driver_port_base + 1))" \
      --data-dir "${data_root}/appimage" \
      --output-dir "${update_output}" \
      --variant linux-appimage
  if [[ "$(sha256sum "${installed_appimage}" | cut -d' ' -f1)" != \
        "$(sha256sum "${candidate_appimage}" | cut -d' ' -f1)" ]]; then
    echo "Updated AppImage bytes differ from the signed candidate" >&2
    exit 1
  fi
  if ! wait_for_no_live_ccsm; then
    echo "Installed updater E2E left a ccsm-desktop process running" >&2
    live_ccsm_processes >&2
    exit 1
  fi
  printf 'package=%s base=%s candidate=%s deb_update=passed appimage_update=passed\n' \
    "${package_name}" "${version}" "${candidate_version}"
  exit 0
fi

run_dpkg -i "${deb}"
package_installed=1
test -x /usr/bin/ccsm-desktop

set +e
timeout --kill-after=5s 12s xvfb-run -a --server-args="-screen 0 1440x900x24" \
  env CCSM_DATA_DIR="${data_root}/deb" LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  /usr/bin/ccsm-desktop >"${log_root}/deb.log" 2>&1
deb_status=$?
set -e
if [[ "${deb_status}" -ne 124 ]]; then
  cat "${log_root}/deb.log" >&2
  exit "${deb_status}"
fi

run_dpkg -i "${deb}" >/dev/null
dpkg-query -W -f='${db:Status-Status}\n' "${package_name}" | grep -Fx installed
run_dpkg -r "${package_name}" >/dev/null
package_installed=0
chmod +x "${appimage}"
set +e
timeout --kill-after=5s 12s xvfb-run -a --server-args="-screen 0 1440x900x24" \
  env CCSM_DATA_DIR="${data_root}/appimage" LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  "${appimage}" >"${log_root}/appimage.log" 2>&1
appimage_status=$?
set -e
if [[ "${appimage_status}" -ne 124 ]]; then
  cat "${log_root}/appimage.log" >&2
  exit "${appimage_status}"
fi

if ! wait_for_no_live_ccsm; then
  echo "Package smoke left a ccsm-desktop process running" >&2
  live_ccsm_processes >&2
  exit 1
fi

printf 'package=%s deb_status=%s appimage_status=%s\n' \
  "${package_name}" "${deb_status}" "${appimage_status}"
