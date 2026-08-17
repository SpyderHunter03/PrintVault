# 🧊 PrintVault

A self-hosted library for your 3D print files. Store your STL/3MF/OBJ/GCODE files, view models right in the browser, track what you've printed, keep photos of your prints, and save the printer settings and notes that worked — along with the URL you got the model from.

## Features

- **In-browser 3D viewer** for `.stl`, `.obj`, and `.3mf` files (Three.js — rotate, zoom, pan, model dimensions shown), plus storage for `.gcode` and anything else
- **Print tracking** — a simple Printed / Not printed toggle with filtering
- **Photos** — upload pictures of your finished prints, shown as a gallery and used as the library thumbnail
- **Printer settings** — printer, filament, temps, layer height, infill, supports, print time, plus free-form notes
- **Source URL** stored per model with a one-click link back
- **URL import** — paste a link and PrintVault creates the entry for you:
  - **Direct file links** (`.stl` `.3mf` `.obj` `.gcode` `.zip`): downloaded automatically
  - **Thingiverse**: with a free API token, downloads *all files and images* automatically; without one, grabs the title + cover image
  - **Printables / MakerWorld / Cults3D**: these sites require login for downloads, so PrintVault grabs the title, description, and cover image, and you drag the files in after downloading them in your browser
- Single SQLite database + flat file storage — trivial to back up
- No accounts, no cloud, no external services required

## 🚀 Deploy on Proxmox VE (one-liner)

Run this **on your Proxmox host** (as root). It creates a Debian 12 LXC and installs everything — same experience as the community Proxmox VE Helper-Scripts:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main/ct/printvault.sh)"
```

Defaults: unprivileged LXC, 2 vCPU / 1 GB RAM / 8 GB disk / DHCP, auto-picked container ID. When it finishes it prints the URL — open `http://<container-ip>:3000`.

Override any default with environment variables:

```bash
CTID=210 HOSTNAME=printvault DISK=16 RAM=2048 CORES=2 BRIDGE=vmbr0 \
STORAGE=local-lvm NET=192.168.1.50/24,gw=192.168.1.1 \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main/ct/printvault.sh)"
```

Tip: give the container more disk (`DISK=32` or more) if you hoard a lot of models — the files live inside the container at `/opt/printvault/data`.

### Updating

Re-run the installer inside the container — your data is never touched:

```bash
pct exec <CTID> -- bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main/install/printvault-install.sh)"
```

## Installing on any Debian/Ubuntu machine (no Proxmox)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main/install/printvault-install.sh)"
```

Same result: Node.js 22, the app in `/opt/printvault`, and a `printvault` systemd service on port 3000. Re-running it later updates in place. (Air-gapped? `bash printvault-install.sh /path/to/source-tarball.tar.gz` works too.)

## Enabling full Thingiverse imports

1. Create a free app at <https://www.thingiverse.com/developers> and copy the **App Token**.
2. Inside the container/machine, edit `/etc/systemd/system/printvault.service` and uncomment:

   ```ini
   Environment=THINGIVERSE_TOKEN=your-token-here
   ```

3. `systemctl daemon-reload && systemctl restart printvault`

Now pasting a `thingiverse.com/thing:XXXX` link imports the title, description, all model files, and photos automatically.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/opt/printvault/data` (installer) or `./data` | Where the SQLite DB and files live |
| `THINGIVERSE_TOKEN` | *(unset)* | Enables full Thingiverse imports |
| `PRINTVAULT_REPO` / `PRINTVAULT_BRANCH` | this repo / `main` | Where the deploy scripts pull the app from |

## Backups

Everything lives in `DATA_DIR`:

- `printvault.db` — the SQLite database (titles, settings, notes, printed status)
- `files/` — every model file, gcode, and photo

From the Proxmox host: `pct exec <CTID> -- tar -czf - /opt/printvault/data > printvault-backup.tar.gz` — or simply back up the whole LXC with vzdump/PBS like any other container.

## Running from source (development)

```bash
git clone https://github.com/SpyderHunter03/PrintVault.git
cd PrintVault
npm install
npm start          # http://localhost:3000, data in ./data
```

## Repo layout

- `ct/printvault.sh` — Proxmox host script (creates the LXC, helper-script style)
- `install/printvault-install.sh` — in-container/standalone installer + updater
- `server.js`, `src/` — Express + SQLite backend
- `public/` — frontend (vanilla JS + Three.js viewer)

## Notes & limits

- Uploads are capped at 500 MB per file.
- There is **no authentication** — it's designed for a trusted home LAN. If you want to expose it outside, put it behind a reverse proxy with auth (Authelia, basic auth on nginx, Tailscale, etc.).
- GCODE files are stored and downloadable but not previewed.
