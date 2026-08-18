import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

/*
 * Slicer project files (Bambu Studio, OrcaSlicer, PrusaSlicer, Cura) save .3mf
 * using the 3MF "production extension": the root 3D/3dmodel.model holds only
 * the build layout, and each object's mesh lives in its own part file, pulled
 * in by a `p:path` attribute on <component> / <item>.
 *
 * three.js's ThreeMFLoader reads `objectid` but ignores `p:path`, so it looks
 * for the object in the wrong part and throws. Object ids also restart at 1 in
 * every part file, so ids collide across parts.
 *
 * flatten3mf() rewrites such an archive into a plain single-part 3MF — every
 * referenced object copied into the root model under a fresh unique id — which
 * the stock loader then handles. Ordinary 3MF files are returned untouched.
 */

const PROD_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
const MODEL_PART = /^3D\/.*\.model$/i;

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('malformed XML inside the .3mf archive');
  return doc;
}

// `p:path`, whatever prefix the file happens to bind the production namespace to
function pathOf(node) {
  return node.getAttributeNS(PROD_NS, 'path') || node.getAttribute('p:path') || null;
}

function dropPath(node) {
  node.removeAttributeNS(PROD_NS, 'path');
  node.removeAttribute('p:path');
}

const zipKey = (target) => String(target || '').replace(/^\//, '');

function findRootModel(zip) {
  const relsKey = Object.keys(zip).find((k) => /^_rels\/\.rels$/i.test(k));
  if (relsKey) {
    try {
      const rels = parseXml(strFromU8(zip[relsKey]));
      for (const rel of rels.querySelectorAll('Relationship')) {
        const target = zipKey(rel.getAttribute('Target'));
        if (/\.model$/i.test(target) && zip[target]) return target;
      }
    } catch {
      /* fall through to the conventional location */
    }
  }
  return Object.keys(zip).find((k) => MODEL_PART.test(k)) || null;
}

/**
 * @param {ArrayBuffer} buffer raw .3mf (zip) bytes
 * @returns {ArrayBuffer} an equivalent single-part .3mf, or the input unchanged
 */
export function flatten3mf(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const rootKey = findRootModel(zip);
  if (!rootKey) return buffer;

  const rootDoc = parseXml(strFromU8(zip[rootKey]));
  const resources = rootDoc.querySelector('resources');
  if (!resources) return buffer;

  const partKeys = Object.keys(zip).filter((k) => MODEL_PART.test(k) && k !== rootKey);
  const hasRefs = [...rootDoc.querySelectorAll('component, item')].some(pathOf);
  if (!partKeys.length && !hasRefs) return buffer; // ordinary single-part file

  // ids live in one namespace per model, so keep a single counter above them all
  let nextId = 1;
  for (const el of rootDoc.querySelectorAll('resources > *')) {
    const id = Number(el.getAttribute('id'));
    if (Number.isFinite(id) && id >= nextId) nextId = id + 1;
  }

  const partDocs = new Map();
  function parsePart(key) {
    if (!partDocs.has(key)) {
      let doc = null;
      try {
        if (zip[key]) doc = parseXml(strFromU8(zip[key]));
      } catch {
        doc = null;
      }
      partDocs.set(key, doc);
    }
    return partDocs.get(key);
  }

  const objectIds = new Map();   // "part#id" -> new root id
  const resourceIds = new Map(); // "part#id" -> new root id

  // materials / colour groups the copied objects point at
  function importResource(partKey, id) {
    const memo = `${partKey}#${id}`;
    if (resourceIds.has(memo)) return resourceIds.get(memo);
    const doc = parsePart(partKey);
    if (!doc) return null;
    const node = [...doc.querySelectorAll('resources > *')].find(
      (el) => el.localName !== 'object' && el.getAttribute('id') === String(id)
    );
    if (!node) return null;

    const copy = rootDoc.importNode(node, true);
    const newId = String(nextId++);
    copy.setAttribute('id', newId);
    resources.insertBefore(copy, resources.firstChild);
    resourceIds.set(memo, newId);
    return newId;
  }

  function remapMaterials(objectEl, partKey) {
    const pid = objectEl.getAttribute('pid');
    if (pid) {
      const mapped = importResource(partKey, pid);
      if (mapped) {
        objectEl.setAttribute('pid', mapped);
      } else {
        objectEl.removeAttribute('pid');
        objectEl.removeAttribute('pindex');
      }
    }
    for (const tri of objectEl.querySelectorAll('triangle[pid]')) {
      const mapped = importResource(partKey, tri.getAttribute('pid'));
      if (mapped) {
        tri.setAttribute('pid', mapped);
      } else {
        // unresolvable colour reference — drop it and let the viewer's own material win
        ['pid', 'p1', 'p2', 'p3'].forEach((a) => tri.removeAttribute(a));
      }
    }
  }

  function resolveComponents(objectEl, partKey) {
    for (const comp of objectEl.querySelectorAll('component')) {
      const target = pathOf(comp);
      const childPart = target ? zipKey(target) : partKey;
      dropPath(comp);
      if (childPart === rootKey) continue; // already points at an object in this model
      const mapped = importObject(childPart, comp.getAttribute('objectid'));
      if (mapped) comp.setAttribute('objectid', mapped);
    }
  }

  function importObject(partKey, id) {
    const memo = `${partKey}#${id}`;
    if (objectIds.has(memo)) return objectIds.get(memo);
    const doc = parsePart(partKey);
    if (!doc) return null;
    const node = [...doc.querySelectorAll('resources > object')].find(
      (el) => el.getAttribute('id') === String(id)
    );
    if (!node) return null;

    const copy = rootDoc.importNode(node, true);
    const newId = String(nextId++);
    copy.setAttribute('id', newId);
    objectIds.set(memo, newId); // memoise before recursing so cycles terminate
    resources.appendChild(copy);

    remapMaterials(copy, partKey);
    resolveComponents(copy, partKey);
    return newId;
  }

  for (const objectEl of [...rootDoc.querySelectorAll('resources > object')]) {
    resolveComponents(objectEl, rootKey);
  }

  for (const item of rootDoc.querySelectorAll('build > item')) {
    const target = pathOf(item);
    dropPath(item);
    if (!target) continue;
    const part = zipKey(target);
    if (part === rootKey) continue;
    const mapped = importObject(part, item.getAttribute('objectid'));
    if (mapped) item.setAttribute('objectid', mapped);
  }

  rootDoc.documentElement.removeAttribute('requiredextensions');

  const out = {};
  for (const [key, bytes] of Object.entries(zip)) {
    if (MODEL_PART.test(key) && key !== rootKey) continue; // inlined above
    out[key] = bytes;
  }
  out[rootKey] = strToU8(new XMLSerializer().serializeToString(rootDoc));
  // stored, not deflated — the loader unzips this again immediately, and slicer
  // project files are big enough that recompressing them would stall the page
  return zipSync(out, { level: 0 }).buffer;
}
