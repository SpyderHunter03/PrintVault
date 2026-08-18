'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const { db, FILES_DIR } = require('./src/db');
const { importFromUrl, kindForExt, extOf, storedNameFor } = require('./src/importer');

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json({ limit: '2mb' }));

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three')));
app.use('/vendor/fflate', express.static(path.join(__dirname, 'node_modules', 'fflate')));

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (_req, file, cb) => cb(null, storedNameFor(file.originalname)),
  }),
  limits: { fileSize: 500 * 1024 * 1024, files: 50 },
});

// ---------- helpers ----------
function rowToModel(row, withFiles = false) {
  const model = {
    id: row.id,
    title: row.title,
    source_url: row.source_url,
    printed: !!row.printed,
    notes: row.notes,
    settings: JSON.parse(row.settings || '{}'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  const files = db.prepare('SELECT * FROM files WHERE model_id = ? ORDER BY id').all(row.id);
  model.cover_file_id = (files.find((f) => f.kind === 'image') || {}).id || null;
  model.file_counts = files.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] || 0) + 1), acc), {});
  model.collections = db
    .prepare(
      'SELECT c.id, c.name FROM collections c JOIN model_collections mc ON mc.collection_id = c.id WHERE mc.model_id = ? ORDER BY c.name'
    )
    .all(row.id);
  if (withFiles) {
    model.files = files.map((f) => ({
      id: f.id,
      kind: f.kind,
      name: f.original_name,
      size: f.size,
      created_at: f.created_at,
    }));
  }
  return model;
}

function getModelOr404(id, res) {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: 'Model not found' });
    return null;
  }
  return row;
}

// ---------- API: models ----------
app.get('/api/models', (req, res) => {
  const { search, printed, collection } = req.query;
  let sql = 'SELECT * FROM models';
  const where = [];
  const params = [];
  if (search) {
    where.push('(title LIKE ? OR notes LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (printed === '1' || printed === '0') {
    where.push('printed = ?');
    params.push(Number(printed));
  }
  if (collection && /^\d+$/.test(collection)) {
    where.push('id IN (SELECT model_id FROM model_collections WHERE collection_id = ?)');
    params.push(Number(collection));
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY updated_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map((r) => rowToModel(r)));
});

app.post('/api/models', (req, res) => {
  const { title, source_url, notes, settings, printed } = req.body || {};
  const info = db
    .prepare(
      'INSERT INTO models (title, source_url, notes, settings, printed) VALUES (?, ?, ?, ?, ?)'
    )
    .run(
      (title || 'Untitled').toString().slice(0, 300),
      (source_url || '').toString().slice(0, 2000),
      (notes || '').toString().slice(0, 20000),
      JSON.stringify(settings || {}),
      printed ? 1 : 0
    );
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowToModel(row, true));
});

app.get('/api/models/:id', (req, res) => {
  const row = getModelOr404(req.params.id, res);
  if (row) res.json(rowToModel(row, true));
});

app.patch('/api/models/:id', (req, res) => {
  const row = getModelOr404(req.params.id, res);
  if (!row) return;
  const b = req.body || {};
  const next = {
    title: b.title !== undefined ? String(b.title).slice(0, 300) : row.title,
    source_url: b.source_url !== undefined ? String(b.source_url).slice(0, 2000) : row.source_url,
    notes: b.notes !== undefined ? String(b.notes).slice(0, 20000) : row.notes,
    settings: b.settings !== undefined ? JSON.stringify(b.settings) : row.settings,
    printed: b.printed !== undefined ? (b.printed ? 1 : 0) : row.printed,
  };
  db.prepare(
    `UPDATE models SET title=?, source_url=?, notes=?, settings=?, printed=?, updated_at=datetime('now') WHERE id=?`
  ).run(next.title, next.source_url, next.notes, next.settings, next.printed, row.id);
  res.json(rowToModel(db.prepare('SELECT * FROM models WHERE id = ?').get(row.id), true));
});

app.delete('/api/models/:id', (req, res) => {
  const row = getModelOr404(req.params.id, res);
  if (!row) return;
  const files = db.prepare('SELECT * FROM files WHERE model_id = ?').all(row.id);
  db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
  for (const f of files) {
    fs.rm(path.join(FILES_DIR, f.stored_name), { force: true }, () => {});
  }
  res.json({ ok: true });
});

// ---------- API: files ----------
app.post('/api/models/:id/files', upload.array('files'), (req, res) => {
  const row = getModelOr404(req.params.id, res);
  if (!row) return;
  const inserted = [];
  const stmt = db.prepare(
    'INSERT INTO files (model_id, kind, original_name, stored_name, size) VALUES (?, ?, ?, ?, ?)'
  );
  for (const f of req.files || []) {
    // multer gives latin1-encoded originalname for some clients; normalize utf8
    const original = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const kind = kindForExt(extOf(original));
    const info = stmt.run(row.id, kind, original, f.filename, f.size);
    inserted.push({ id: info.lastInsertRowid, kind, name: original, size: f.size });
  }
  db.prepare(`UPDATE models SET updated_at=datetime('now') WHERE id=?`).run(row.id);
  res.status(201).json({ files: inserted });
});

function findFile(id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

app.get('/api/files/:id/raw', (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'File not found' });
  const p = path.join(FILES_DIR, f.stored_name);
  if (!fs.existsSync(p)) return res.status(410).json({ error: 'File missing on disk' });
  res.sendFile(p);
});

app.get('/api/files/:id/download', (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'File not found' });
  const p = path.join(FILES_DIR, f.stored_name);
  if (!fs.existsSync(p)) return res.status(410).json({ error: 'File missing on disk' });
  res.download(p, f.original_name);
});

app.delete('/api/files/:id', (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: 'File not found' });
  db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
  fs.rm(path.join(FILES_DIR, f.stored_name), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------- API: collections ----------
app.get('/api/collections', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, COUNT(mc.model_id) AS model_count
       FROM collections c LEFT JOIN model_collections mc ON mc.collection_id = c.id
       GROUP BY c.id ORDER BY c.name`
    )
    .all();
  res.json(rows);
});

app.post('/api/collections', (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Collection name is required' });
  const existing = db.prepare('SELECT * FROM collections WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) return res.status(200).json(existing);
  const info = db.prepare('INSERT INTO collections (name) VALUES (?)').run(name);
  res.status(201).json(db.prepare('SELECT * FROM collections WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/collections/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Collection not found' });
  const name = String((req.body || {}).name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Collection name is required' });
  db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, c.id);
  res.json(db.prepare('SELECT * FROM collections WHERE id = ?').get(c.id));
});

app.delete('/api/collections/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Collection not found' });
  db.prepare('DELETE FROM collections WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

app.put('/api/models/:id/collections', (req, res) => {
  const row = getModelOr404(req.params.id, res);
  if (!row) return;
  const ids = Array.isArray((req.body || {}).collection_ids) ? req.body.collection_ids : [];
  const valid = ids
    .map(Number)
    .filter((n) => Number.isInteger(n) && db.prepare('SELECT 1 FROM collections WHERE id = ?').get(n));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM model_collections WHERE model_id = ?').run(row.id);
    const ins = db.prepare('INSERT OR IGNORE INTO model_collections (model_id, collection_id) VALUES (?, ?)');
    for (const cid of valid) ins.run(row.id, cid);
  });
  tx();
  res.json(rowToModel(db.prepare('SELECT * FROM models WHERE id = ?').get(row.id), true));
});

// ---------- API: URL import ----------
app.post('/api/import', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const result = await importFromUrl(url);
    const info = db
      .prepare('INSERT INTO models (title, source_url, notes) VALUES (?, ?, ?)')
      .run((result.title || 'Imported model').slice(0, 300), String(url).slice(0, 2000), (result.notes || '').slice(0, 20000));
    const modelId = info.lastInsertRowid;
    const stmt = db.prepare(
      'INSERT INTO files (model_id, kind, original_name, stored_name, size) VALUES (?, ?, ?, ?, ?)'
    );
    for (const f of result.files) {
      stmt.run(modelId, f.kind, f.originalName, f.storedName, f.size);
    }
    const row = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId);
    res.status(201).json({ model: rowToModel(row, true), warnings: result.warnings });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

// ---------- SPA fallback ----------
app.get(/^\/(?!api\/|vendor\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PrintVault listening on http://0.0.0.0:${PORT}`);
});
