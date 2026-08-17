import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';

/**
 * Minimal 3D model viewer for STL / OBJ / 3MF.
 */
export class ModelViewer {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    this.camera.position.set(120, 90, 120);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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
      object = await new ThreeMFLoader().loadAsync(url);
      object.traverse((o) => {
        if (o.isMesh && (!o.material || !o.material.map)) o.material = material;
      });
    } else {
      throw new Error(`No preview available for .${ext} files`);
    }

    // Normalize orientation: STL/3MF are usually Z-up; three.js is Y-up.
    if (ext === 'stl' || ext === '3mf') object.rotation.x = -Math.PI / 2;

    // Center on the plate and frame the camera.
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    object.position.x -= center.x;
    object.position.z -= center.z;
    object.position.y -= box.min.y;

    this.modelGroup.add(object);

    const maxDim = Math.max(size.x, size.y, size.z) || 10;
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

  dispose() {
    this._running = false;
    window.removeEventListener('resize', this._resize);
    this.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
