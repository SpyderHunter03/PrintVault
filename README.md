# 🧊 PrintVault

A self-hosted library for your 3D print files. Store your STL/3MF/OBJ/GCODE files, view models right in the browser, track what you've printed, keep photos of your prints, and save the printer settings and notes that worked — along with the URL you got the model from.

## Features

- **In-browser 3D viewer** for `.stl`, `.obj`, and `.3mf` files (Three.js — rotate, zoom, pan, model dimensions shown), plus storage for `.gcode` and anything else. Multi-part slicer project `.3mf` files (Bambu Studio, OrcaSlicer, PrusaSlicer) are supported — they are flattened in the browser before rendering, which the stock Three.js loader cannot do on its own
- **Multi-file items** — one item can hold any number of model files (multi-part prints); click any model file in the file list to highlight it and load it into the viewer
- **Collections** — group items into collections (an item can be in several), filter the library by collection
- **Print tracking** — a simple Printed / Not printed toggle with filtering
- **Photos** — upload pictures of your finished prints, shown as a gallery; star one to make it the primary image used as the library thumbnail (otherwise the first photo is used)
- **Library picture from the model itself** — no photo yet? Rotate the 3D preview to an angle you like and hit **📷 Use as thumbnail** to save that view as the model's picture
- **Printer settings** — printer, filament, temps, layer height, infill, supports, print time, plus free-form notes
- **Source URL** stored per model with a one-click link back
- **URL import** — paste a link and PrintVault creates the entry for you:
  - **Direct file links** (`.stl` `.3mf` `.obj` `.gcode` `.zip`): downloaded automatically
  - **Thingiverse**: with a free API token, downloads *all files and images* automatically; without one, grabs the title + cover image
  - **Printables / MakerWorld / Cults3D**: these sites require login for downloads, so PrintVault grabs the title, description, and cover image, and you drag the files in after downloading them in your browser
- **Mobile friendly** — the library, viewer, and file list all reflow for phone-sized screens
- Single SQLite database + flat file storage — trivial to back up
- No accounts, no cloud, no external services required

## 🚀 Deploy on Proxmox VE

PrintVault ships genuine [community-scripts](https://github.com/community-scripts) format scripts (`ct/` + `install/` + `json/`, powered by the official `community-scripts/core` engine). Run this **on your Proxmox host** (as root):

```bash
COMMUNITY_SCRIPTS_URL=https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main/ct/printvault.sh)"
```

You get the full community-scripts experience — the whiptail dialogs, default/advanced settings, and container creation — with the app pulled from this repository's latest GitHub release. Defaults: unprivileged LXC, 2 vCPU / 1 GB RAM / 8 GB disk, Debian 13, DHCP. When it finishes, open `http://<container-ip>:3000`.

Alternative (identical result, no env var needed — the engine detects the repo from the git origin):

```bash
git clone https://github.com/SpyderHunter03/PrintVault.git
cd PrintVault && bash ct/printvault.sh
```

### Updating

Run the same command again on the Proxmox host and choose **Update** when prompted, or run the script from inside the container. Updates install the latest GitHub release; your models, photos and database live in `/opt/printvault-data` and are never touched.

## Installing on any Debian/Ubuntu machine (no Proxmox)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SpyderHunter03/PrintVault/main/misc/standalone-install.sh)"
```

Same result: Node.js 22, the app in `/opt/printvault`, data in `/opt/printvault-data`, and a `printvault` systemd service on port 3000. Re-running it later updates in place.

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
| `DATA_DIR` | `/opt/printvault-data` (installed) or `./data` (dev) | Where the SQLite DB and files live |
| `THINGIVERSE_TOKEN` | *(unset)* | Enables full Thingiverse imports |

## Backups

Everything lives in `DATA_DIR` (`/opt/printvault-data` in the LXC):

- `printvault.db` — the SQLite database (titles, settings, notes, printed status)
- `files/` — every model file, gcode, and photo

From the Proxmox host: `pct exec <CTID> -- tar -czf - /opt/printvault-data > printvault-backup.tar.gz` — or simply back up the whole LXC with vzdump/PBS like any other container.

## Running from source (development)

```bash
git clone https://github.com/SpyderHunter03/PrintVault.git
cd PrintVault
npm install
npm start          # http://localhost:3000, data in ./data
```

## Repo layout

- `ct/printvault.sh` — Proxmox container script (community-scripts format, sources the official `core` engine)
- `install/printvault-install.sh` — in-container installer (community-scripts function library)
- `json/printvault.json` — app metadata (community-scripts website format)
- `misc/standalone-install.sh` — plain Debian/Ubuntu installer (no Proxmox required)
- `server.js`, `src/` — Express + SQLite backend
- `public/` — frontend (vanilla JS + Three.js viewer)

## Notes & limits

- Uploads are capped at 500 MB per file.
- There is **no authentication** — it's designed for a trusted home LAN. If you want to expose it outside, put it behind a reverse proxy with auth (Authelia, basic auth on nginx, Tailscale, etc.).
- GCODE files are stored and downloadable but not previewed.
