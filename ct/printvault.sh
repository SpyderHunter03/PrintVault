#!/usr/bin/env bash
# Engine comes from community-scripts/core; this repo only ships the scripts.
# A local core checkout wins (COMMUNITY_SCRIPTS_CORE_DIR, else a sibling ../core),
# so a fork or branch of core can be tested without editing this file.
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) 2021-2026 community-scripts ORG
# Author: SpyderHunter03
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/SpyderHunter03/PrintVault

APP="PrintVault"
var_tags="${var_tags:-3d-printing;files}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-1024}"
var_disk="${var_disk:-8}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/printvault ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "printvault" "SpyderHunter03/PrintVault"; then
    msg_info "Stopping Service"
    systemctl stop printvault
    msg_ok "Stopped Service"

    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "printvault" "SpyderHunter03/PrintVault" "tarball" "latest" "/opt/printvault"

    msg_info "Updating PrintVault"
    cd /opt/printvault
    $STD npm install --omit=dev --no-audit --no-fund
    msg_ok "Updated PrintVault"

    msg_info "Starting Service"
    systemctl start printvault
    msg_ok "Started Service"
    msg_ok "Updated Successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:3000${CL}"
