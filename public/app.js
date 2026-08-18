const view = document.getElementById('view');
let viewer = null; // active ModelViewer instance

// ---------------- utilities ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function toast(msg, warn = false, ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast' + (warn ? ' warn' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------- collections ----------------
let collectionsCache = [];

async function loadCollections(preserveSelection = true) {
  try {
    collectionsCache = await api('/api/collections');
  } catch {
    collectionsCache = [];
  }
  const sel = document.getElementById('filter-collection');
  const prev = preserveSelection ? sel.value : '';
  sel.innerHTML =
    `<option value="">All collections</option>` +
    collectionsCache
      .map((c) => `<option value="${c.id}">${esc(c.name)} (${c.model_count})</option>`)
      .join('');
  if (prev && collectionsCache.some((c) => String(c.id) === prev)) sel.value = prev;
  return collectionsCache;
}

const SETTINGS_FIELDS = [
  ['printer', 'Printer'],
  ['filament', 'Filament / material'],
  ['nozzle_temp', 'Nozzle temp (°C)'],
  ['bed_temp', 'Bed temp (°C)'],
  ['layer_height', 'Layer height (mm)'],
  ['infill', 'Infill (%)'],
  ['supports', 'Supports'],
  ['print_time', 'Print time'],
];

// ---------------- router ----------------
window.addEventListener('hashchange', route);

function route() {
  if (viewer) { viewer.dispose(); viewer = null; }
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/model\/(\d+)/);
  if (m) renderDetail(Number(m[1]));
  else renderLibrary();
}

// ---------------- library ----------------
async function renderLibrary() {
  const search = document.getElementById('search').value.trim();
  const printed = document.getElementById('filter-printed').value;
  const collection = document.getElementById('filter-collection').value;
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  if (printed !== '') qs.set('printed', printed);
  if (collection !== '') qs.set('collection', collection);

  let models;
  try {
    models = await api(`/api/models?${qs}`);
  } catch (e) {
    view.innerHTML = `<div class="empty"><h2>Could not load library</h2><p>${esc(e.message)}</p></div>`;
    return;
  }

  const filtered = search || printed !== '' || collection !== '';
  if (!models.length) {
    view.innerHTML = `
      <div class="empty">
        <h2>${filtered ? 'No matches' : 'Your library is empty'}</h2>
        <p>${filtered ? 'Try a different search or filter.' : 'Click <b>+ New model</b> to add one, or <b>Import URL</b> to pull one in from Thingiverse, Printables, MakerWorld or Cults3D.'}</p>
      </div>`;
    return;
  }

  view.innerHTML = `<div class="grid">${models.map(cardHtml).join('')}</div>`;
  view.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('click', () => { location.hash = `#/model/${el.dataset.id}`; });
  });
}

function cardHtml(m) {
  const thumb = m.cover_file_id
    ? `<img src="/api/files/${m.cover_file_id}/raw" loading="lazy" alt="">`
    : `<span>🧊</span>`;
  const counts = [];
  if (m.file_counts.model) counts.push(`${m.file_counts.model} model file${m.file_counts.model > 1 ? 's' : ''}`);
  if (m.file_counts.gcode) counts.push(`${m.file_counts.gcode} gcode`);
  if (m.file_counts.image) counts.push(`${m.file_counts.image} photo${m.file_counts.image > 1 ? 's' : ''}`);
  return `
  <div class="card" data-id="${m.id}">
    <div class="card-thumb">${thumb}</div>
    <div class="card-body">
      <div class="card-title">${esc(m.title)}</div>
      <div class="card-meta">
        <span class="badge ${m.printed ? 'badge-printed' : 'badge-notprinted'}">${m.printed ? '✓ Printed' : 'Not printed'}</span>
        ${counts.length ? `<span>${counts.join(' · ')}</span>` : ''}
      </div>
      ${(m.collections || []).length ? `<div class="card-meta">${m.collections.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('')}</div>` : ''}
    </div>
  </div>`;
}

// ---------------- detail ----------------
async function renderDetail(id) {
  let m;
  try {
    m = await api(`/api/models/${id}`);
  } catch (e) {
    view.innerHTML = `<div class="empty"><h2>Model not found</h2><p><a href="#/">← Back to library</a></p></div>`;
    return;
  }

  const s = m.settings || {};
  view.innerHTML = `
  <div class="detail-head">
    <a href="#/" class="btn btn-sm">← Library</a>
    <h1 id="title" contenteditable spellcheck="false">${esc(m.title)}</h1>
    <label class="toggle" title="Have you printed this yet?">
      <input type="checkbox" id="printed" ${m.printed ? 'checked' : ''}>
      <span class="track"></span>
      <span id="printed-label">${m.printed ? 'Printed' : 'Not printed'}</span>
    </label>
    <span id="save-ind" class="save-indicator">Saved ✓</span>
    <button id="btn-delete" class="btn btn-danger btn-sm">Delete</button>
  </div>

  <div class="detail-layout">
    <div>
      <div class="panel">
        <h3>3D preview</h3>
        <div id="viewer-wrap">
          <div id="viewer"></div>
          <div id="viewer-msg" class="viewer-msg"></div>
        </div>
        <div class="viewer-toolbar">
          <select id="viewer-file"></select>
          <span id="dims" class="muted"></span>
          <span class="spacer"></span>
          <span class="muted">drag to rotate · scroll to zoom · right-drag to pan</span>
        </div>
      </div>

      <div class="panel">
        <h3>Files</h3>
        <ul class="file-list" id="file-list"></ul>
        <div class="dropzone" id="dropzone">
          Drop files here or click to upload<br>
          <span style="font-size:.85em">models (.stl .3mf .obj) · gcode · photos (.jpg .png …) · anything else</span>
        </div>
        <input type="file" id="file-input" multiple hidden>
      </div>

      <div class="panel">
        <h3>Photos of your prints</h3>
        <div class="gallery" id="gallery"></div>
      </div>
    </div>

    <div>
      <div class="panel">
        <h3>Source</h3>
        <input id="source-url" type="url" placeholder="https://…" value="${esc(m.source_url)}">
        <div style="margin-top:8px">
          ${m.source_url ? `<a href="${esc(m.source_url)}" target="_blank" rel="noopener">Open source page ↗</a>` : ''}
        </div>
      </div>

      <div class="panel">
        <h3>Collections</h3>
        <div id="coll-list" class="coll-list"></div>
        <div class="row" style="margin-top:10px">
          <input id="coll-new" type="text" placeholder="New collection name…" style="flex:1">
          <button id="coll-add" class="btn btn-sm">Add</button>
        </div>
      </div>

      <div class="panel">
        <h3>Printer settings</h3>
        <div class="settings-grid">
          ${SETTINGS_FIELDS.map(([k, label]) => `
            <label>${esc(label)}<input data-setting="${k}" value="${esc(s[k] || '')}"></label>
          `).join('')}
        </div>
      </div>

      <div class="panel">
        <h3>Notes</h3>
        <textarea id="notes" placeholder="Anything worth remembering — slicer profile, scaling, orientation, what failed…">${esc(m.notes)}</textarea>
      </div>
    </div>
  </div>
  <div id="lightbox"><img alt=""></div>
  `;

  // ---- save helpers ----
  const ind = document.getElementById('save-ind');
  function flashSaved() {
    ind.classList.add('show');
    setTimeout(() => ind.classList.remove('show'), 1200);
  }
  async function patch(body) {
    try {
      await api(`/api/models/${id}`, { method: 'PATCH', body });
      flashSaved();
    } catch (e) {
      toast(`Save failed: ${e.message}`, true);
    }
  }
  const patchDebounced = debounce(patch, 600);

  // title
  const titleEl = document.getElementById('title');
  titleEl.addEventListener('blur', () => patch({ title: titleEl.textContent.trim() || 'Untitled' }));
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });

  // printed toggle
  const printedEl = document.getElementById('printed');
  printedEl.addEventListener('change', () => {
    document.getElementById('printed-label').textContent = printedEl.checked ? 'Printed' : 'Not printed';
    patch({ printed: printedEl.checked });
  });

  // source url
  document.getElementById('source-url').addEventListener('input', (e) => patchDebounced({ source_url: e.target.value.trim() }));

  // settings
  const collectSettings = () => {
    const out = {};
    view.querySelectorAll('[data-setting]').forEach((inp) => {
      if (inp.value.trim()) out[inp.dataset.setting] = inp.value.trim();
    });
    return out;
  };
  view.querySelectorAll('[data-setting]').forEach((inp) => {
    inp.addEventListener('input', () => patchDebounced({ settings: collectSettings() }));
  });

  // notes
  document.getElementById('notes').addEventListener('input', (e) => patchDebounced({ notes: e.target.value }));

  // collections
  let memberIds = new Set((m.collections || []).map((c) => c.id));

  async function saveCollections() {
    try {
      const updated = await api(`/api/models/${id}/collections`, {
        method: 'PUT',
        body: { collection_ids: [...memberIds] },
      });
      memberIds = new Set((updated.collections || []).map((c) => c.id));
      flashSaved();
      loadCollections(); // refresh top-bar counts
    } catch (e) {
      toast(`Save failed: ${e.message}`, true);
    }
  }

  function renderCollectionChecks() {
    const box = document.getElementById('coll-list');
    box.innerHTML = collectionsCache.length
      ? collectionsCache
          .map(
            (c) => `
        <label class="coll-item">
          <input type="checkbox" data-cid="${c.id}" ${memberIds.has(c.id) ? 'checked' : ''}>
          <span>${esc(c.name)}</span>
        </label>`
          )
          .join('')
      : `<span class="muted">No collections yet — create one below.</span>`;
    box.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const cid = Number(cb.dataset.cid);
        if (cb.checked) memberIds.add(cid);
        else memberIds.delete(cid);
        saveCollections();
      });
    });
  }

  document.getElementById('coll-add').addEventListener('click', async () => {
    const inp = document.getElementById('coll-new');
    const name = inp.value.trim();
    if (!name) return;
    try {
      const c = await api('/api/collections', { method: 'POST', body: { name } });
      inp.value = '';
      memberIds.add(c.id);
      await loadCollections();
      renderCollectionChecks();
      saveCollections();
    } catch (e) {
      toast(`Could not create collection: ${e.message}`, true);
    }
  });
  document.getElementById('coll-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('coll-add').click(); }
  });

  if (!collectionsCache.length) await loadCollections();
  renderCollectionChecks();

  // delete
  document.getElementById('btn-delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${m.title}" and all of its files?`)) return;
    await api(`/api/models/${id}`, { method: 'DELETE' });
    location.hash = '#/';
  });

  // ---- files & gallery ----
  function refreshFileViews(files) {
    renderFileList(files);
    renderGallery(files);
    setupViewerFiles(files);
  }

  function renderFileList(files) {
    const list = document.getElementById('file-list');
    const nonImages = files.filter((f) => f.kind !== 'image');
    list.innerHTML = nonImages.length
      ? nonImages.map((f) => `
        <li class="file-row" data-fid="${f.id}">
          <span class="file-kind ${f.kind}">${f.kind === 'model' ? f.name.split('.').pop() : f.kind}</span>
          <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="size">${fmtSize(f.size)}</span>
          <a class="btn btn-sm" href="/api/files/${f.id}/download">↓</a>
          <button class="btn btn-sm btn-danger del-file" title="Delete file">✕</button>
        </li>`).join('')
      : `<li class="muted">No files yet — add the model files below.</li>`;
    list.querySelectorAll('.del-file').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const row = e.target.closest('.file-row');
        await api(`/api/files/${row.dataset.fid}`, { method: 'DELETE' });
        reloadFiles();
      });
    });
  }

  function renderGallery(files) {
    const g = document.getElementById('gallery');
    const images = files.filter((f) => f.kind === 'image');
    g.innerHTML = images.length
      ? images.map((f) => `
        <div class="shot" data-fid="${f.id}">
          <img src="/api/files/${f.id}/raw" loading="lazy" alt="${esc(f.name)}">
          <button class="del" title="Delete photo">✕</button>
        </div>`).join('')
      : `<span class="muted">No photos yet — drop some in the upload box.</span>`;
    g.querySelectorAll('img').forEach((img) => {
      img.addEventListener('click', () => {
        const lb = document.getElementById('lightbox');
        lb.querySelector('img').src = img.src;
        lb.classList.add('show');
      });
    });
    g.querySelectorAll('.del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const shot = e.target.closest('.shot');
        await api(`/api/files/${shot.dataset.fid}`, { method: 'DELETE' });
        reloadFiles();
      });
    });
  }

  document.getElementById('lightbox').addEventListener('click', (e) => e.currentTarget.classList.remove('show'));

  // ---- 3D viewer ----
  const VIEWABLE = ['stl', 'obj', '3mf'];
  let viewerLoadToken = 0;

  async function setupViewerFiles(files) {
    const sel = document.getElementById('viewer-file');
    const msg = document.getElementById('viewer-msg');
    const viewable = files.filter((f) => VIEWABLE.includes(f.name.split('.').pop().toLowerCase()));
    sel.innerHTML = viewable.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    sel.style.display = viewable.length > 1 ? '' : 'none';

    if (!viewable.length) {
      msg.innerHTML = 'No viewable model file yet.<br>Upload an <b>.stl</b>, <b>.obj</b> or <b>.3mf</b> to see it here.';
      document.getElementById('dims').textContent = '';
      viewer?.clear();
      return;
    }
    msg.textContent = '';
    sel.onchange = () => loadIntoViewer(viewable.find((f) => f.id === Number(sel.value)));
    loadIntoViewer(viewable[0]);
  }

  async function loadIntoViewer(f) {
    const msg = document.getElementById('viewer-msg');
    const dims = document.getElementById('dims');
    const token = ++viewerLoadToken;
    try {
      if (!viewer) {
        const { ModelViewer } = await import('/viewer.js');
        if (token !== viewerLoadToken) return;
        viewer = new ModelViewer(document.getElementById('viewer'));
      }
      msg.textContent = 'Loading…';
      const ext = f.name.split('.').pop().toLowerCase();
      const info = await viewer.load(`/api/files/${f.id}/raw`, ext);
      if (token !== viewerLoadToken) return;
      msg.textContent = '';
      const d = info.dimensions;
      dims.textContent = `${d.x.toFixed(1)} × ${d.y.toFixed(1)} × ${d.z.toFixed(1)} mm`;
    } catch (e) {
      if (token !== viewerLoadToken) return;
      msg.textContent = `Could not preview: ${e.message}`;
      dims.textContent = '';
    }
  }

  async function reloadFiles() {
    const fresh = await api(`/api/models/${id}`);
    refreshFileViews(fresh.files);
  }

  // ---- uploads ----
  const dz = document.getElementById('dropzone');
  const fi = document.getElementById('file-input');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => uploadFiles(fi.files));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  async function uploadFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const fd = new FormData();
    [...fileList].forEach((f) => fd.append('files', f));
    dz.textContent = `Uploading ${fileList.length} file${fileList.length > 1 ? 's' : ''}…`;
    try {
      await api(`/api/models/${id}/files`, { method: 'POST', body: fd });
      toast('Upload complete');
    } catch (e) {
      toast(`Upload failed: ${e.message}`, true);
    }
    dz.innerHTML = `Drop files here or click to upload<br><span style="font-size:.85em">models (.stl .3mf .obj) · gcode · photos (.jpg .png …) · anything else</span>`;
    fi.value = '';
    reloadFiles();
  }

  refreshFileViews(m.files);
}

// ---------------- top bar ----------------
document.getElementById('search').addEventListener('input', debounce(() => {
  if (!location.hash || location.hash === '#/' || location.hash.startsWith('#/?')) renderLibrary();
  else location.hash = '#/';
}, 300));
document.getElementById('filter-printed').addEventListener('change', () => {
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  else renderLibrary();
});
document.getElementById('filter-collection').addEventListener('change', () => {
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  else renderLibrary();
});

// new model dialog
const dlgNew = document.getElementById('dlg-new');
document.getElementById('btn-new').addEventListener('click', () => {
  dlgNew.querySelector('form').reset();
  dlgNew.showModal();
});
dlgNew.addEventListener('close', async () => {
  if (dlgNew.returnValue !== 'default') return;
  const title = document.getElementById('new-title').value.trim();
  if (!title) return;
  const m = await api('/api/models', {
    method: 'POST',
    body: { title, source_url: document.getElementById('new-url').value.trim() },
  });
  location.hash = `#/model/${m.id}`;
});

// import dialog
const dlgImport = document.getElementById('dlg-import');
const importStatus = document.getElementById('import-status');
document.getElementById('btn-import').addEventListener('click', () => {
  dlgImport.querySelector('form').reset();
  importStatus.textContent = '';
  dlgImport.showModal();
});
dlgImport.querySelector('form').addEventListener('submit', async (e) => {
  const url = document.getElementById('import-url').value.trim();
  if (dlgImport.returnValue === 'cancel' || !url) return;
  e.preventDefault(); // keep dialog open while we work
  const btn = document.getElementById('import-go');
  btn.disabled = true;
  importStatus.textContent = 'Importing… (downloading files can take a minute)';
  try {
    const { model, warnings } = await api('/api/import', { method: 'POST', body: { url } });
    dlgImport.close('done');
    (warnings || []).forEach((w, i) => setTimeout(() => toast(w, true, 7000), i * 400));
    location.hash = `#/model/${model.id}`;
  } catch (err) {
    importStatus.textContent = `Import failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

loadCollections();
route();
