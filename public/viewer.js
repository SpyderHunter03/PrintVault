import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { flatten3mf } from './3mf.js';

/**
 * Minimal 3D model viewer for STL / OBJ / 3MF.
 */
export class ModelViewer {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    this.camera.position.set(120, 90, 120);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // lights
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x30271a, 1.1);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 2, 1.5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-2, -1, -1);
    this.scene.add(fill);

    // build plate grid
    this.grid = new THREE.GridHelper(220, 22, 0x39445c, 0x232a3a);
    this.scene.add(this.grid);

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();

    this._running = true;
    const loop = () => {
      if (!this._running) return;
      requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  _resize() {
    const w = this.container.clientWidth || 600;
    const h = this.container.clientHeight || 400;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  clear() {
    while (this.modelGroup.children.length) {
      const c = this.modelGroup.children[0];
      this.modelGroup.remove(c);
      c.traverse?.((o) => {
        o.geometry?.dispose?.();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
      });
    }
  }

  /**
   * Load a model from a URL. ext: 'stl' | 'obj' | '3mf'
   */
  async load(url, ext) {
    this.clear();
    this._lastReport = null;
    const material = new THREE.MeshStandardMaterial({
      color: 0x6f9dff,
      metalness: 0.1,
      roughness: 0.55,
      flatShading: false,
    });

    let object;
    if (ext === 'stl') {
      const geo = await new STLLoader().loadAsync(url);
      geo.computeVertexNormals();
      object = new THREE.Mesh(geo, material);
    } else if (ext === 'obj') {
      object = await new OBJLoader().loadAsync(url);
      object.traverse((o) => {
        if (o.isMesh) {
          o.material = material;
          o.geometry.computeVertexNormals?.();
        }
      });
    } else if (ext === '3mf') {
      const report = {};
      object = await load3MF(url, report);
      this._lastReport = summarise(report);
      object.traverse((o) => {
        if (o.isMesh && (!o.material || !o.material.map)) o.material = material;
      });
    } else {
      throw new Error(`No preview available for .${ext} files`);
    }

    // Normalize orientation: STL/3MF are usually Z-up; three.js is Y-up.
    if (ext === 'stl' || ext === '3mf') object.rotation.x = -Math.PI / 2;

    if (!countVertices(object)) {
      throw new Error(
        'this file contains no mesh data the viewer can read' +
          (this._lastReport ? ` [${this._lastReport}]` : '')
      );
    }

    // Center on the plate and frame the camera.
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) throw new Error('this file has no geometry to show');
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    object.position.x -= center.x;
    object.position.z -= center.z;
    object.position.y -= box.min.y;

    this.modelGroup.add(object);

    const maxDim = [size.x, size.y, size.z].filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0) || 10;
    const dist = maxDim * 1.9;
    this.camera.position.set(dist, dist * 0.75, dist);
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, size.y / 2, 0);
    this.controls.update();

    // scale the grid to the model
    this.scene.remove(this.grid);
    const gsize = Math.max(Math.ceil((maxDim * 1.6) / 10) * 10, 50);
    this.grid = new THREE.GridHelper(gsize, Math.min(Math.round(gsize / 10), 40), 0x39445c, 0x232a3a);
    this.scene.add(this.grid);

    return { dimensions: { x: size.x, y: size.z, z: size.y } }; // report as printer X/Y/Z
  }

  /**
   * Grab what is on screen right now as a PNG, for use as the model's picture
   * in the library. The grid is hidden and a solid background painted in, so
   * the shot reads as a picture of the model, not a screenshot of the viewer.
   */
  snapshot(width = 800, height = 600) {
    const grid = this.grid.visible;
    const background = this.scene.background;

    this.grid.visible = false;
    this.scene.background = new THREE.Color(0x161b24);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderer.render(this.scene, this.camera);

    const dataUrl = this.renderer.domElement.toDataURL('image/png');

    this.grid.visible = grid;
    this.scene.background = background;
    this._resize(); // puts the canvas back to the size the page gives it

    return dataUrl;
  }

  dispose() {
    this._running = false;
    window.removeEventListener('resize', this._resize);
    this.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function countVertices(object) {
  let n = 0;
  object.traverse((o) => {
    if (o.isMesh) n += o.geometry?.attributes?.position?.count || 0;
  });
  return n;
}

/**
 * 3MF needs a pre-pass: slicer project files split their objects across several
 * parts inside the archive, which ThreeMFLoader cannot follow on its own.
 */
async function load3MF(url, report = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch the file (HTTP ${res.status})`);
  const raw = await res.arrayBuffer();

  let buffer = raw;
  try {
    buffer = flatten3mf(raw, report);
  } catch (e) {
    report.error = e.message;
    console.warn('3MF: could not flatten multi-part archive, trying it as-is', e);
  }
  console.info('3MF:', summarise(report));

  try {
    return new ThreeMFLoader().parse(buffer);
  } catch (e) {
    if (buffer !== raw) {
      try {
        // the rewrite may have confused the loader — fall back to the original bytes
        return new ThreeMFLoader().parse(raw);
      } catch {
        throw new Error(`${e.message} [${summarise(report)}]`);
      }
    }
    if (/relationship file|invalid|zip/i.test(e.message)) {
      throw new Error("this doesn't look like a valid .3mf archive");
    }
    throw new Error(`${e.message} [${summarise(report)}]`);
  }
}

// compact description of what the flattening pass saw, for error messages
function summarise(report) {
  return Object.entries(report)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') || 'no report';
}
