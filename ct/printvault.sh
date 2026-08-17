#!/usr/bin/env bash
# ------------------------------------------------------------------
#  PrintVault LXC — Proxmox VE helper script
#  (self-contained, styled after community-scripts / tteck helpers)
#
#  Run ON THE PROXMOX HOST (as root):
#
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main/ct/printvault.sh)"
#
#  It will:
#    • download the Debian 12 LXC template (if needed)
#    • create an unprivileged container (2 vCPU / 1 GB RAM / 8 GB disk, DHCP)
#    • install Node.js 22 + PrintVault (pulled from GitHub) as a
#      systemd service inside it
#    • print the URL when done
#
#  Defaults can be overridden with environment variables:
#      CTID=210 HOSTNAME=printvault DISK=16 RAM=2048 CORES=2 \
#      BRIDGE=vmbr0 STORAGE=local-lvm NET=192.168.1.50/24,gw=192.168.1.1 \
#      bash -c "$(curl -fsSL …/ct/printvault.sh)"
#
#  To UPDATE an existing container later, run the same one-liner
#  INSIDE it:   pct exec <CTID> -- bash -c "$(curl -fsSL …/install/printvault-install.sh)"
# ------------------------------------------------------------------
set -euo pipefail

REPO="${PRINTVAULT_REPO:-SpyderHunter03/PrintVault}"
BRANCH="${PRINTVAULT_BRANCH:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

# ---------- pretty output (community-scripts style) ----------
YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; BL=$'\033[36m'; CL=$'\033[m'
CM="${GN}✓${CL}"; CROSS="${RD}✗${CL}"; INFO="${BL}ℹ${CL}"

msg_info() { echo -e " ${YW}➤${CL}  $1"; }
msg_ok()   { echo -e " ${CM}  $1"; }
msg_error(){ echo -e " ${CROSS}  $1" >&2; }
die()      { msg_error "$1"; exit 1; }

header() {
cat <<"EOF"
    ____       _       _ _    __            ____
   / __ \_____(_)___  | | |  / /___ ___  __/ / /_
  / /_/ / ___/ / __ \/ __/ | / / __ `/ / / / / __/
 / ____/ /  / / / / / /_ | |/ / /_/ / /_/ / / /_
/_/   /_/  /_/_/ /_/\__/ |___/\__,_/\__,_/_/\__/

        Self-hosted 3D print file library
EOF
}

header
echo

# ---------- sanity checks ----------
command -v pveversion >/dev/null 2>&1 || die "This script must run on a Proxmox VE host. (To update an existing install, run install/printvault-install.sh inside the container instead.)"
[ "$(id -u)" -eq 0 ] || die "Run as root on the Proxmox host."

# ---------- settings ----------
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
HOSTNAME="${HOSTNAME:-printvault}"
DISK="${DISK:-8}"          # GB
RAM="${RAM:-1024}"         # MB
CORES="${CORES:-2}"
BRIDGE="${BRIDGE:-vmbr0}"
NET="${NET:-dhcp}"         # 'dhcp' or e.g. 192.168.1.50/24,gw=192.168.1.1
PASSWORD="${PASSWORD:-}"   # empty = no password (use pct enter / console)

if [ -z "${STORAGE:-}" ]; then
  STORAGE=$(pvesm status -content rootdir | awk 'NR==2 {print $1}')
  [ -n "$STORAGE" ] || die "No storage with 'rootdir' content found; set STORAGE=<name>."
fi

TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"

echo -e " ${INFO}  Source:       ${BL}github.com/${REPO}${CL} (${BRANCH})"
echo -e " ${INFO}  Container ID: ${BL}${CTID}${CL}   Hostname: ${BL}${HOSTNAME}${CL}"
echo -e " ${INFO}  Resources:    ${BL}${CORES}${CL} vCPU / ${BL}${RAM}${CL} MB RAM / ${BL}${DISK}${CL} GB on ${BL}${STORAGE}${CL}"
echo -e " ${INFO}  Network:      ${BL}${BRIDGE}${CL} (${NET})"
echo

# ---------- template ----------
msg_info "Checking Debian 12 LXC template…"
pveam update >/dev/null 2>&1 || true
TEMPLATE=$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -n1)
[ -n "$TEMPLATE" ] || die "Could not find a debian-12-standard template via pveam."
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg_info "Downloading template ${TEMPLATE} (one-time)…"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
fi
msg_ok "Template ready: ${TEMPLATE}"

# ---------- create container ----------
NETCFG="name=eth0,bridge=${BRIDGE},ip=${NET}"
[ "$NET" = "dhcp" ] && NETCFG="name=eth0,bridge=${BRIDGE},ip=dhcp"

msg_info "Creating LXC ${CTID}…"
PCT_OPTS=(
  -hostname "$HOSTNAME"
  -cores "$CORES"
  -memory "$RAM"
  -swap 256
  -rootfs "${STORAGE}:${DISK}"
  -net0 "$NETCFG"
  -unprivileged 1
  -features nesting=1
  -onboot 1
  -tags "printvault"
)
[ -n "$PASSWORD" ] && PCT_OPTS+=(-password "$PASSWORD")

pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" "${PCT_OPTS[@]}" >/dev/null
msg_ok "LXC ${CTID} created."

msg_info "Starting container…"
pct start "$CTID"
sleep 3

msg_info "Waiting for network inside the container…"
for i in $(seq 1 30); do
  if pct exec "$CTID" -- bash -c "ping -c1 -W1 deb.debian.org >/dev/null 2>&1"; then break; fi
  sleep 2
  [ "$i" -eq 30 ] && die "Container never got network access."
done
msg_ok "Network is up."

# ---------- run installer inside (pulls the app from GitHub) ----------
msg_info "Installing PrintVault inside the container (Node.js 22, app, systemd)…"
pct exec "$CTID" -- bash -c "export PRINTVAULT_REPO='${REPO}' PRINTVAULT_BRANCH='${BRANCH}'; bash -c \"\$(curl -fsSL ${RAW}/install/printvault-install.sh)\"" \
  || die "Install failed inside the container. Inspect with: pct enter ${CTID}"

# ---------- done ----------
IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
echo
msg_ok "${GN}PrintVault LXC deployed successfully!${CL}"
echo -e "
 ${INFO}  Open:            ${BL}http://${IP}:3000${CL}
 ${INFO}  Container:       pct enter ${CTID}
 ${INFO}  Service logs:    pct exec ${CTID} -- journalctl -u printvault -f
 ${INFO}  Data lives in:   /opt/printvault/data (inside the container)
 ${INFO}  Update later:    pct exec ${CTID} -- bash -c \"\\\$(curl -fsSL ${RAW}/install/printvault-install.sh)\"
 ${INFO}  Thingiverse:     add THINGIVERSE_TOKEN to /etc/systemd/system/printvault.service
                   then: systemctl daemon-reload && systemctl restart printvault
"
