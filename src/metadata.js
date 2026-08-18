'use strict';

/*
 * Slicers already know everything the "Printer settings" panel asks for, and
 * they write it into the files they produce. This pulls it back out:
 *
 *   - gcode  — `; key = value` comments (PrusaSlicer, SuperSlicer, OrcaSlicer,
 *              Bambu Studio) or `;KEY:value` (Cura), plus a base64 PNG preview
 *              in a `; thumbnail begin` block
 *   - 3mf    — the same config text under Metadata/, or JSON/XML variants, plus
 *              the plate PNGs slicers save alongside them
 *
 * Everything here is best-effort: an unrecognised file simply yields nothing.
 */

const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');

// gcode can be enormous, so only the ends are read — slicers put the preview and
// the summary at the top and the full config dump at the bottom.
const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
// a whole 3mf has to be held in memory to unzip, so leave absurd ones alone
const MAX_3MF_BYTES = 256 * 1024 * 1024;

// setting key -> the config keys that might hold it, best first
const FIELD_SOURCES = {
  printer: ['printer_model', 'printer_settings_id', 'machine_name', 'target_machine.name', 'printer_model_id'],
  filament: ['filament_type', 'filament_settings_id', 'material_type', 'material_guid', 'filament'],
  nozzle_temp: [
    'nozzle_temperature', 'temperature', 'first_layer_temperature',
    'nozzle_temperature_initial_layer', 'material_print_temperature',
    'extruder_train.0.initial_temperature',
  ],
  bed_temp: [
    'bed_temperature', 'first_layer_bed_temperature', 'hot_plate_temp',
    'hot_plate_temp_initial_layer', 'material_bed_temperature',
    'build_plate.initial_temperature',
  ],
  layer_height: ['layer_height'],
  infill: ['fill_density', 'sparse_infill_density', 'infill_sparse_density'],
  supports: ['support_material', 'enable_support', 'support_enable'],
  print_time: [
    'estimated printing time (normal mode)', 'estimated printing time',
    'total estimated time', 'prediction', 'time',
  ],
};

const BOOLEAN_FIELDS = new Set(['supports']);
const SECONDS_KEYS = new Set(['prediction', 'time']);

function firstOf(value) {
  const v = String(value).trim();
  if (v.startsWith('[')) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr) && arr.length) return String(arr[0]).trim();
    } catch {
      /* not JSON after all */
    }
  }
  // per-extruder values arrive as "220,220" or "220;220"
  return v.split(/[,;]/)[0].trim().replace(/^["']|["']$/g, '');
}

function formatSeconds(total) {
  const s = Number(total);
  if (!Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function cleanValue(field, key, raw) {
  let v = firstOf(raw);
  if (!v) return '';
  if (BOOLEAN_FIELDS.has(field)) {
    if (/^(1|true|yes|on)$/i.test(v)) return 'Yes';
    if (/^(0|false|no|off|none)$/i.test(v)) return 'No';
    return v;
  }
  if (field === 'print_time') {
    if (SECONDS_KEYS.has(key) && /^\d+(\.\d+)?$/.test(v)) return formatSeconds(v);
    return v;
  }
  if (field === 'infill') return v.replace('%', '').trim();
  if (field === 'nozzle_temp' || field === 'bed_temp' || field === 'layer_height') {
    const n = v.match(/-?\d+(\.\d+)?/);
    return n ? n[0] : v;
  }
  return v;
}

/*
 * Register a key under a few spellings, because slicers do not agree:
 * Cura prefixes lines with `SETTING_3 `, and writes `Layer height` where
 * PrusaSlicer writes `layer_height`.
 */
function record(into, rawKey, value) {
  const key = rawKey.trim().toLowerCase();
  if (!key || !value) return;
  const aliases = new Set([key, key.replace(/\s+/g, '_'), key.split(/\s+/).pop()]);
  for (const alias of aliases) {
    if (alias && into[alias] === undefined) into[alias] = value;
  }
}

/** Collect `; key = value` and `;KEY: value` comment lines into one lookup. */
function parseConfigText(text, into = {}) {
  const equals = /^[;\s]*([A-Za-z0-9_\-. ()]+?)\s*=\s*(.+)$/gm;
  let m;
  while ((m = equals.exec(text))) record(into, m[1], m[2].trim());

  const colon = /^;\s*([A-Za-z0-9_\-. ()]+?)\s*:\s*(.+)$/gm;
  while ((m = colon.exec(text))) record(into, m[1], m[2].trim());

  // Bambu / Orca put both times on one line:
  //   ; model printing time: 1h 21m; total estimated time: 1h 30m
  const inlineTime = /total estimated time\s*:\s*([0-9hms .]+)/i.exec(text);
  if (inlineTime) record(into, 'total estimated time', inlineTime[1].trim());

  return into;
}

function parseJsonConfig(text, into = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return into;
  }
  for (const [k, v] of Object.entries(data || {})) {
    if (v === null || typeof v === 'object') {
      if (Array.isArray(v) && v.length && typeof v[0] !== 'object') {
        record(into, k, String(v[0]));
      }
      continue;
    }
    record(into, k, String(v));
  }
  return into;
}

/** Bambu/Orca's slice_info.config: <metadata key="..." value="..."/> */
function parseMetadataXml(text, into = {}) {
  const re = /<metadata[^>]*\bkey="([^"]+)"[^>]*\bvalue="([^"]*)"/gi;
  let m;
  while ((m = re.exec(text))) {
    record(into, m[1], m[2].trim());
  }
  return into;
}

function settingsFrom(config) {
  const out = {};
  for (const [field, keys] of Object.entries(FIELD_SOURCES)) {
    for (const key of keys) {
      if (config[key] === undefined) continue;
      const value = cleanValue(field, key, config[key]);
      if (value) {
        out[field] = value;
        break;
      }
    }
  }
  return out;
}

/** Largest base64 PNG in a `; thumbnail begin WxH bytes` block. */
function thumbnailFromGcode(text) {
  const re = /;\s*thumbnail(?:_PNG)?\s+begin\s+(\d+)[xX](\d+)\s+\d+([\s\S]*?);\s*thumbnail(?:_PNG)?\s+end/gi;
  let best = null;
  let m;
  while ((m = re.exec(text))) {
    const area = Number(m[1]) * Number(m[2]);
    if (best && area <= best.area) continue;
    const base64 = m[3].replace(/^\s*;/gm, '').replace(/\s+/g, '');
    if (!base64) continue;
    try {
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > 8) best = { area, buffer };
    } catch {
      /* skip a malformed block */
    }
  }
  return best ? best.buffer : null;
}

function readEnds(filePath) {
  const { size } = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const whole = Buffer.alloc(size);
      fs.readSync(fd, whole, 0, size, 0);
      return whole.toString('utf8');
    }
    const head = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    fs.closeSync(fd);
  }
}

function fromGcode(filePath) {
  const text = readEnds(filePath);
  return {
    settings: settingsFrom(parseConfigText(text)),
    thumbnail: thumbnailFromGcode(text),
  };
}

function from3mf(filePath) {
  if (fs.statSync(filePath).size > MAX_3MF_BYTES) return { settings: {}, thumbnail: null };
  // only the Metadata folder is decompressed — the meshes can be enormous
  const zip = unzipSync(new Uint8Array(fs.readFileSync(filePath)), {
    filter: (f) => /^Metadata\//i.test(f.name),
  });

  const config = {};
  let thumbnail = null;
  for (const [name, bytes] of Object.entries(zip)) {
    if (/\.png$/i.test(name)) {
      // plate previews beat the small icons; largest wins
      if (!thumbnail || bytes.length > thumbnail.length) thumbnail = Buffer.from(bytes);
      continue;
    }
    if (!/\.(config|txt|xml|json|ini)$/i.test(name)) continue;
    const text = Buffer.from(bytes).toString('utf8');
    if (/^\s*[[{]/.test(text)) parseJsonConfig(text, config);
    else if (/<metadata/i.test(text)) parseMetadataXml(text, config);
    else parseConfigText(text, config);
  }
  return { settings: settingsFrom(config), thumbnail };
}

/**
 * @returns {{settings: Object, thumbnail: Buffer|null}}
 */
function extractMetadata(filePath, originalName) {
  const ext = path.extname(String(originalName)).toLowerCase();
  try {
    if (['.gcode', '.gco', '.g'].includes(ext)) return fromGcode(filePath);
    if (ext === '.3mf') return from3mf(filePath);
  } catch {
    /* unreadable or unrecognised — just contribute nothing */
  }
  return { settings: {}, thumbnail: null };
}

module.exports = { extractMetadata };
