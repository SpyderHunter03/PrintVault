'use strict';

/*
 * URL import: given a URL, try to figure out what it is and pull down
 * whatever we can — title, cover image, and (when possible) the model
 * files themselves.
 *
 *  - Direct file links (.stl/.3mf/.obj/.gcode/.zip) are downloaded outright.
 *  - Thingiverse: with a THINGIVERSE_TOKEN env var (free app token from
 *    https://www.thingiverse.com/developers), we use the official API to
 *    pull the title, description, images AND all model files.
 *    Without a token we fall back to Open Graph scraping (title + cover).
 *  - Printables / MakerWorld / Cults3D: these sites don't offer public
 *    file downloads without auth, so we scrape the page's Open Graph tags
 *    for the title and cover image, and store the URL. Files can then be
 *    added by hand (download in your browser, drag into the app).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { FILES_DIR } = require('./db');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MODEL_EXTS = ['.stl', '.3mf', '.obj'];
const GCODE_EXTS = ['.gcode', '.gco', '.g', '.bgcode'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const ARCHIVE_EXTS = ['.zip'];

function extOf(name) {
  return path.extname(String(name).split('?')[0].split('#')[0]).toLowerCase();
}

function kindForExt(ext) {
  if (MODEL_EXTS.includes(ext)) return 'model';
  if (GCODE_EXTS.includes(ext)) return 'gcode';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  return 'other';
}

function safeName(name) {
  const base = path.basename(String(name)).replace(/[^\w.\- ()\[\]]+/g, '_').slice(0, 180);
  return base || 'file';
}

function storedNameFor(originalName) {
  return `${crypto.randomBytes(8).toString('hex')}-${safeName(originalName)}`;
}

async function fetchWithTimeout(url, opts = {}, ms = 45000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...opts,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** Download a URL to the files dir. Returns {originalName, storedName, size} */
async function downloadToFiles(url, suggestedName, headers = {}) {
  const res = await fetchWithTimeout(url, { headers }, 120000);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);

  // Try to get a filename from Content-Disposition, else the URL path.
  let name = suggestedName;
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (!name && m) name = decodeURIComponent(m[1].replace(/"/g, ''));
  if (!name) name = path.basename(new URL(res.url || url).pathname) || 'download';
  name = safeName(name);

  const storedName = storedNameFor(name);
  const buf = Buffer.from(await res.arrayBuffer());
  const MAX = 500 * 1024 * 1024;
  if (buf.length > MAX) throw new Error('File too large (>500MB)');
  fs.writeFileSync(path.join(FILES_DIR, storedName), buf);
  return { originalName: name, storedName, size: buf.length };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function ogTag(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1] || m[2]) : null;
}

function titleTag(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : null;
}

function cleanTitle(t, host) {
  if (!t) return t;
  let out = t;
  // Strip common site suffixes like " - Thingiverse", " | Printables.com" etc.
  out = out.replace(/\s*[|\-–]\s*(Thingiverse|Printables(\.com)?|MakerWorld|Cults(3D)?|Download free .*)\s*$/i, '');
  out = out.replace(/^\s*Free\s+(STL|3D)\s+file\s+/i, '');
  return out.trim() || t;
}

/** Scrape Open Graph metadata from a page. */
async function scrapePage(url) {
  const res = await fetchWithTimeout(url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) throw new Error(`Could not fetch page (${res.status})`);
  const html = await res.text();
  const host = new URL(url).hostname;
  const title = cleanTitle(ogTag(html, 'og:title') || titleTag(html), host);
  const image = ogTag(html, 'og:image');
  const description = ogTag(html, 'og:description');
  return { title, image, description };
}

/** Thingiverse via official API (needs THINGIVERSE_TOKEN). */
async function importThingiverseApi(thingId, token) {
  const api = (p) =>
    fetchWithTimeout(`https://api.thingiverse.com${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => {
      if (!r.ok) throw new Error(`Thingiverse API ${r.status} on ${p}`);
      return r.json();
    });

  const thing = await api(`/things/${thingId}`);
  const files = await api(`/things/${thingId}/files`).catch(() => []);
  const images = await api(`/things/${thingId}/images`).catch(() => []);

  const downloads = [];
  for (const f of Array.isArray(files) ? files : []) {
    const dl = f.download_url || f.public_url;
    if (!dl) continue;
    downloads.push({
      url: f.download_url ? `${f.download_url}` : dl,
      name: f.name,
      headers: f.download_url ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  const imageUrls = [];
  for (const img of (Array.isArray(images) ? images : []).slice(0, 4)) {
    const sizes = img.sizes || [];
    const best =
      sizes.find((s) => s.type === 'display' && s.size === 'large') ||
      sizes.find((s) => s.type === 'display') ||
      sizes[sizes.length - 1];
    if (best && best.url) imageUrls.push({ url: best.url, name: img.name || 'image.jpg' });
  }

  return {
    title: thing.name,
    description: thing.description_html
      ? String(thing.description_html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
      : thing.description || '',
    downloads,
    imageUrls,
  };
}

/**
 * Main entry. Returns:
 * { title, notes, files: [{originalName, storedName, size, kind}], warnings: [] }
 */
async function importFromUrl(rawUrl) {
  const url = String(rawUrl).trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported.');

  const warnings = [];
  const outFiles = [];
  let title = null;
  let notes = '';

  const ext = extOf(parsed.pathname);

  // 1) Direct file link → just download it.
  if ([...MODEL_EXTS, ...GCODE_EXTS, ...ARCHIVE_EXTS, ...IMAGE_EXTS].includes(ext)) {
    const dl = await downloadToFiles(url);
    outFiles.push({ ...dl, kind: kindForExt(extOf(dl.originalName)) });
    title = path.basename(dl.originalName, extOf(dl.originalName)).replace(/[_\-]+/g, ' ').trim();
    return { title, notes, files: outFiles, warnings };
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

  // 2) Thingiverse with API token → full import including files.
  const thingMatch = url.match(/thingiverse\.com\/thing:(\d+)/i);
  if (thingMatch && process.env.THINGIVERSE_TOKEN) {
    try {
      const t = await importThingiverseApi(thingMatch[1], process.env.THINGIVERSE_TOKEN);
      title = t.title;
      notes = t.description || '';
      for (const d of t.downloads) {
        try {
          const dl = await downloadToFiles(d.url, d.name, d.headers);
          outFiles.push({ ...dl, kind: kindForExt(extOf(dl.originalName)) });
        } catch (e) {
          warnings.push(`Could not download "${d.name}": ${e.message}`);
        }
      }
      for (const img of t.imageUrls) {
        try {
          const dl = await downloadToFiles(img.url, img.name);
          outFiles.push({ ...dl, kind: 'image' });
        } catch (e) {
          warnings.push(`Could not download image: ${e.message}`);
        }
      }
      return { title, notes, files: outFiles, warnings };
    } catch (e) {
      warnings.push(`Thingiverse API import failed (${e.message}); falling back to page scrape.`);
    }
  } else if (thingMatch) {
    warnings.push(
      'Tip: set THINGIVERSE_TOKEN (free app token from thingiverse.com/developers) and PrintVault will auto-download Thingiverse files too.'
    );
  }

  // 3) Known model sites (and anything else) → scrape title + cover image.
  try {
    const meta = await scrapePage(url);
    title = meta.title || null;
    if (meta.description) notes = meta.description;
    if (meta.image) {
      try {
        const imgDl = await downloadToFiles(meta.image, null);
        let name = imgDl.originalName;
        if (!IMAGE_EXTS.includes(extOf(name))) name += '.jpg';
        outFiles.push({ ...imgDl, originalName: name, kind: 'image' });
      } catch (e) {
        warnings.push(`Could not download cover image: ${e.message}`);
      }
    }
  } catch (e) {
    warnings.push(`Could not read the page: ${e.message}`);
  }

  const knownNoFiles = ['printables.com', 'makerworld.com', 'cults3d.com'];
  if (knownNoFiles.some((k) => host.endsWith(k))) {
    warnings.push(
      `${host} does not allow direct file downloads without logging in — grabbed the title/cover where possible. Download the files in your browser and drag them onto this model.`
    );
  }

  return { title, notes, files: outFiles, warnings };
}

module.exports = { importFromUrl, kindForExt, extOf, storedNameFor, safeName };
