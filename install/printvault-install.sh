#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: SpyderHunter03
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/SpyderHunter03/PrintVault

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

NODE_VERSION="22" setup_nodejs

fetch_and_deploy_gh_release "printvault" "SpyderHunter03/PrintVault" "tarball" "latest" "/opt/printvault"

msg_info "Installing PrintVault"
mkdir -p /opt/printvault-data
cd /opt/printvault
$STD npm install --omit=dev --no-audit --no-fund
msg_ok "Installed PrintVault"

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/printvault.service
[Unit]
Description=PrintVault - self-hosted 3D print file library
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/printvault
Environment=PORT=3000
Environment=DATA_DIR=/opt/printvault-data
# Optional: add a free Thingiverse app token (thingiverse.com/developers) to
# enable full Thingiverse imports (files + images):
#Environment=THINGIVERSE_TOKEN=your-token-here
ExecStart=/usr/bin/node /opt/printvault/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now printvault
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
