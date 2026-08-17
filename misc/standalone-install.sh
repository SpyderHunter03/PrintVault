#!/usr/bin/env bash
# ------------------------------------------------------------------
# PrintVault standalone installer / updater — for any Debian/Ubuntu
# machine WITHOUT Proxmox (on Proxmox, use ct/printvault.sh instead).
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main/misc/standalone-install.sh)"
#
# Idempotent: re-running updates the app and never touches your data
# (/opt/printvault-data).
# ------------------------------------------------------------------
set -euo pipefail

REPO="${PRINTVAULT_REPO:-SpyderHunter03/PrintVault}"
BRANCH="${PRINTVAULT_BRANCH:-main}"
APP_DIR="/opt/printvault"
DATA_DIR="${DATA_DIR:-/opt/printvault-data}"
PORT="${PORT:-3000}"

msg()  { echo -e "\e[1;34m[printvault]\e[0m $*"; }
ok()   { echo -e "\e[1;32m[printvault]\e[0m $*"; }
fail() { echo -e "\e[1;31m[printvault]\e[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run this as root (sudo)."

UPDATE=0
[ -f "$APP_DIR/server.js" ] && UPDATE=1

msg "Installing base packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg tar >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  msg "Installing Node.js 22 (NodeSource)…"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v) / npm $(npm -v)"

if [ "$UPDATE" -eq 1 ]; then
  msg "Existing install found — updating (data directory is preserved)…"
  systemctl stop printvault 2>/dev/null || true
fi

msg "Downloading PrintVault from github.com/${REPO} (${BRANCH})…"
mkdir -p "$APP_DIR" "$DATA_DIR"
TMP=$(mktemp -d)
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" -o "$TMP/src.tar.gz" \
  || fail "Could not download from GitHub. Check that https://github.com/${REPO} exists and is public."
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC_DIR=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -n1)
[ -f "$SRC_DIR/server.js" ] || fail "Downloaded archive does not look like PrintVault."
(cd "$SRC_DIR" && tar -cf - --exclude=data .) | tar -xf - -C "$APP_DIR"
rm -rf "$TMP"
ok "Application source in ${APP_DIR}."

msg "Installing npm dependencies (this can take a minute)…"
cd "$APP_DIR"
if ! npm install --omit=dev --no-audit --no-fund --loglevel=error; then
  msg "npm install failed — installing build tools and retrying…"
  apt-get install -y -qq build-essential python3 >/dev/null
  npm install --omit=dev --no-audit --no-fund --loglevel=error
fi
ok "Dependencies installed."

if [ ! -f /etc/systemd/system/printvault.service ]; then
  msg "Writing systemd service…"
  cat > /etc/systemd/system/printvault.service <<EOF
[Unit]
Description=PrintVault - self-hosted 3D print library
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=DATA_DIR=${DATA_DIR}
# Optional: add a free Thingiverse app token (thingiverse.com/developers) to
# enable full Thingiverse imports (files + images):
#Environment=THINGIVERSE_TOKEN=your-token-here
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable -q --now printvault
systemctl restart printvault

sleep 2
if systemctl is-active -q printvault; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ "$UPDATE" -eq 1 ] && ok "PrintVault updated →  http://${IP:-<this-machine>}:${PORT}" \
                      || ok "PrintVault is running →  http://${IP:-<this-machine>}:${PORT}"
else
  fail "Service failed to start. Check: journalctl -u printvault -n 50"
fi
