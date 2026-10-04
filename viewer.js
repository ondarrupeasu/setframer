// SetFrameR viewer — the three.js side: scene, camera, set/HDRI loading, roles (screens/talent),
// picking and plain-image export. Units are glTF metres. app.js drives it; vmixset.js renders the
// UV passes from the same scene/camera.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const events = new EventTarget();
const emit = (name, detail = {}) => events.dispatchEvent(new CustomEvent(name, { detail }));

// ---- renderer / scene -------------------------------------------------------------------------
const canvas = document.getElementById('c');
const frameEl = document.getElementById('frame');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;   // keeps the set's own colours (ACES shifts blues/reds)
renderer.toneMappingExposure = 1.0;

let composer = null, gtao = null;     // AO post-process (built on demand, see setAO) — declared early: layout() uses it
export const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // neutral IBL until an HDRI is loaded
scene.environment = roomEnv;

export const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 5000);
camera.filmGauge = 24.89;            // horizontal sensor width (mm) — Super 35 by default
camera.setFocalLength(35);
camera.position.set(0, 1.6, 5);

export const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.target.set(0, 1.4, 0);
controls.update();

// Editor-only helpers live in their own layer so exports can hide them in one go.
export const helpers = new THREE.Group();
scene.add(helpers);
const grid = new THREE.GridHelper(20, 20, 0x55565e, 0x2a2b32);
grid.visible = false;
helpers.add(grid);

export const state = {
  setRoot: null,       // the loaded glTF scene
  setName: '',
  sceneSize: 10,       // bounding-box diagonal, scales fly speed / clipping
  floorY: 0,
  hdrTex: null,
  env: { background: 'hdri', color: '#202024', blur: 0, intensity: 1, rotation: 0 },
  aspect: 16 / 9,
  roles: new Map(),    // mesh.uuid -> { role:'A'|'B'|…, flipU, flipV, rot }
  talent: null,        // { mesh, frameH } — the virtual card where the keyed presenter lands
};
scene.background = new THREE.Color(state.env.color);

// ---- layout: letterbox the canvas to the output aspect ----------------------------------------
export function layout() {
  const host = frameEl.parentElement;
  const W = host.clientWidth - 24, H = host.clientHeight - 24;
  let w = W, h = W / state.aspect;
  if (h > H) { h = H; w = H * state.aspect; }
  w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
  frameEl.style.width = w + 'px'; frameEl.style.height = h + 'px';
  // With the clean output open the drawing buffer is exactly the output size (1920 wide), so the
  // copy sent to that window is sharp; otherwise the screen's own pixel density.
  renderer.setPixelRatio(state.output ? OUTPUT_W / w : window.devicePixelRatio);
  renderer.setSize(w, h, false);
  if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
  camera.aspect = state.aspect;
  camera.zoom = state.previewZoom || 1;   // shot preview (exports always force 1)
  camera.updateProjectionMatrix();
}
new ResizeObserver(layout).observe(frameEl.parentElement);
layout();

// ---- camera helpers ---------------------------------------------------------------------------
export function cameraInfo() {
  const d = new THREE.Vector3().subVectors(controls.target, camera.position);
  const dist = d.length() || 1e-6;
  const tilt = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.y / dist, -1, 1)));
  const pan = THREE.MathUtils.radToDeg(Math.atan2(d.x, -d.z));   // 0 = looking down -Z
  const fovH = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
  return { tilt, pan, dist, height: camera.position.y - state.floorY, focal: camera.getFocalLength(),
    sensor: camera.filmGauge, fovV: camera.fov, fovH };
}

function aim(tiltDeg, panDeg, dist) {
  const t = THREE.MathUtils.degToRad(tiltDeg), p = THREE.MathUtils.degToRad(panDeg);
  const dir = new THREE.Vector3(Math.cos(t) * Math.sin(p), Math.sin(t), -Math.cos(t) * Math.cos(p));
  controls.target.copy(camera.position).addScaledVector(dir, dist);
  controls.update();
  camDirty = true;
}

export function setLens(focalMm, sensorWidthMm) {
  camera.filmGauge = sensorWidthMm;
  camera.setFocalLength(focalMm);
  camDirty = true;
}
export function setHeight(h) {
  const dy = state.floorY + h - camera.position.y;
  camera.position.y += dy; controls.target.y += dy; controls.update(); camDirty = true;
}
export function setTilt(deg) { const a = cameraInfo(); aim(deg, a.pan, a.dist); }
export function setPan(deg) { const a = cameraInfo(); aim(a.tilt, deg, a.dist); }
export function getView() {
  return { pos: camera.position.toArray(), target: controls.target.toArray(), focal: camera.getFocalLength(), sensor: camera.filmGauge };
}
export function setView(v) {
  camera.position.fromArray(v.pos); controls.target.fromArray(v.target);
  if (v.sensor) camera.filmGauge = v.sensor;
  if (v.focal) camera.setFocalLength(v.focal);
  controls.update(); camDirty = true;
}
export function setAspect(a) { state.aspect = a; layout(); camDirty = true; }
export function setGrid(on) { grid.visible = !!on; }

let camDirty = true;
controls.addEventListener('change', () => { camDirty = true; });

// ---- fly keys (WASD + Q/E, Shift = faster) — moves camera and orbit target together -----------
const keys = new Set();
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
// Speed modifiers, everywhere (walk, wheel, orbit/pan drag): Shift = slow/precise, Alt (Option) = fast.
const SLOW = 0.2, FAST = 3;
export const speedFactor = (e) => (e?.shiftKey ? SLOW : e?.altKey ? FAST : 1);
function dragSpeed(e) {
  const f = e.shiftKey ? SLOW : 1;      // fast orbit is never useful; slow orbit/pan is
  controls.rotateSpeed = f; controls.panSpeed = f;
}
window.addEventListener('keydown', (e) => { dragSpeed(e); if (!e.metaKey && !e.ctrlKey && !typing(e)) keys.add(e.code); });
window.addEventListener('keyup', (e) => { dragSpeed(e); keys.delete(e.code); });
window.addEventListener('blur', () => { keys.clear(); controls.rotateSpeed = controls.panSpeed = 1; });
// …and from the mouse itself (Shift pressed before the window had focus, or held while dragging)
canvas.addEventListener('pointermove', dragSpeed, { capture: true });
function fly(dt) {
  if (!keys.size) return;
  const mod = keys.has('ShiftLeft') || keys.has('ShiftRight') ? SLOW : keys.has('AltLeft') || keys.has('AltRight') ? FAST : 1;
  const speed = Math.max(0.5, state.sceneSize * 0.15) * mod * dt;
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position); fwd.y = 0;
  if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
  const mv = new THREE.Vector3();
  if (keys.has('KeyW')) mv.add(fwd);
  if (keys.has('KeyS')) mv.sub(fwd);
  if (keys.has('KeyD')) mv.add(right);
  if (keys.has('KeyA')) mv.sub(right);
  if (keys.has('KeyE')) mv.y += 1;
  if (keys.has('KeyQ')) mv.y -= 1;
  if (mv.lengthSq() === 0) return;
  mv.normalize().multiplyScalar(speed);
  camera.position.add(mv); controls.target.add(mv);
  camDirty = true;
}

// ---- loop ---------------------------------------------------------------------------------------
const clock = new THREE.Clock();
let lastReport = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  fly(dt);
  controls.update();
  if (state.talent) faceCamera(state.talent.mesh);
  if (state.output) renderOutput();
  draw();
  syncTalentLive();
  if (live.show && live.video && live.mode === 'frame') {   // the live camera, keyed, full frame (viewer only)
    live.texture.needsUpdate = true;
    renderer.autoClear = false;
    renderer.render(liveScene, liveCam);
    renderer.autoClear = true;
  }
  const now = performance.now();
  if (camDirty && now - lastReport > 80) { camDirty = false; lastReport = now; emit('camera', cameraInfo()); }
});

// ---- loading ----------------------------------------------------------------------------------
const draco = new DRACOLoader().setDecoderPath('./vendor/three/addons/libs/draco/gltf/');
const ktx2 = new KTX2Loader().setTranscoderPath('./vendor/three/addons/libs/basis/').detectSupport(renderer);

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

/**
 * Find the FLOOR: the lowest height holding a big share of upward-facing area. The bounding box
 * lies — sets often carry a huge backdrop photo or sky dome that hangs metres below the floor.
 * Returns { y, box } (box = XZ extent of that floor) or null when nothing horizontal is found.
 */
function findFloor(root) {
  const BIN = 0.05, bins = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const tri = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < tri; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
      n.crossVectors(b.clone().sub(a), c.clone().sub(a));
      const area2 = n.length();
      if (area2 < 1e-9 || n.y / area2 < 0.95) continue;       // faces looking UP: the top of a floor slab, not its underside
      const y = (a.y + b.y + c.y) / 3, k = Math.round(y / BIN);
      const e = bins.get(k) || { area: 0, box: new THREE.Box3() };
      e.area += area2 / 2;
      e.box.expandByPoint(a); e.box.expandByPoint(b); e.box.expandByPoint(c);
      bins.set(k, e);
    }
  });
  if (!bins.size) return null;
  const max = Math.max(...[...bins.values()].map((e) => e.area));
  // Lowest bin with at least half the biggest area: the floor, not the ceiling slab above it.
  const k = Math.min(...[...bins.entries()].filter(([, e]) => e.area >= max * 0.5).map(([key]) => key));
  return { y: k * BIN, box: bins.get(k).box };
}

/** Initial view from one of the four sides of the floor (0 front = +Z, 1 right, 2 back, 3 left). */
function frameObject(root, side = 0) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  if (!state.floor || state.floor.root !== root) state.floor = { root, found: findFloor(root) };
  const floor = state.floor.found;
  // Frame what stands on the floor (its XZ extent), not backdrops hanging far away.
  const area = floor ? floor.box : box;
  const size = area.getSize(new THREE.Vector3());
  const center = area.getCenter(new THREE.Vector3());
  state.sceneSize = Math.max(2, Math.hypot(size.x, size.z));
  state.floorY = floor ? floor.y : box.min.y;
  camera.near = Math.max(0.05, state.sceneSize / 1000);   // generous near plane = depth precision
  camera.far = Math.max(100, box.getSize(new THREE.Vector3()).length() * 20);
  camera.updateProjectionMatrix();
  // Eye level (1.6 m) above the floor, looking at the centre, far enough to see that side's width.
  const across = side % 2 ? size.z : size.x, depth = side % 2 ? size.x : size.z;
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  const dist = across / 2 / Math.tan(hfov / 2) + depth / 2;
  const dir = [[0, 1], [1, 0], [0, -1], [-1, 0]][side];
  camera.position.set(center.x + dir[0] * dist, state.floorY + 1.6, center.z + dir[1] * dist);
  controls.target.set(center.x, state.floorY + 1.2, center.z);
  // Seen from outside, is a wall in the way (e.g. the back of a curved video wall)? Then stand INSIDE:
  // camera on the floor's centre, looking the same way. Sets with see-through outer walls keep the
  // "dollhouse" view from outside.
  const toTarget = new THREE.Vector3().subVectors(controls.target, camera.position);
  raycaster.set(camera.position, toTarget.clone().normalize());
  const block = raycaster.intersectObject(root, true).find((h) => h.object.isMesh && isShown(h.object));
  if (block && block.distance < toTarget.length() * 0.6) {
    camera.position.set(center.x, state.floorY + 1.6, center.z);
    controls.target.set(center.x - dir[0] * 5, state.floorY + 1.2, center.z - dir[1] * 5);
  }
  controls.update();
  grid.position.y = state.floorY;
  camDirty = true;
}
export function frameAll(side = 0) { if (state.setRoot) frameObject(state.setRoot, side); }

function meshStats(root) {
  let meshes = 0, tris = 0;
  root.traverse((o) => {
    if (o.isMesh) { meshes++; const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; }
  });
  return { meshes, tris: Math.round(tris) };
}

/** Put a ready-made Object3D in as the set (used by the loader and by the demo studio). */
export function useSet(root, name) {
  if (state.setRoot) clearEdits();
  clearLights();
  clearRoles();
  removeTalent();
  if (state.setRoot) { scene.remove(state.setRoot); disposeTree(state.setRoot); }
  state.setRoot = root;
  state.setName = name;
  scene.add(root);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // glTF is metres by the spec, but plenty of downloads come in centimetres or inches (a 670-unit
  // "studio"). Pick the first unit that gives the set a believable height (2.2–12 m); the user can
  // override it (setUnits). Metres win whenever they are plausible.
  const height = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y;
  state.units = [1, 0.01, 0.0254, 0.001].find((u) => height * u >= 2.2 && height * u <= 12) ?? 1;
  root.scale.multiplyScalar(state.units);
  state.floor = null;
  frameObject(root);
  applySun();
  adoptFileLights(root);
  if (composer) buildComposer();          // the AO pass is bound to this set
  document.body.classList.add('loaded');
  emit('setLoaded', { name, ...meshStats(root), size: state.sceneSize, units: state.units });
}

/** Rescale the set: 1 = metres, 0.01 = centimetres, 0.0254 = inches… Reframes; the presenter card goes. */
export function setUnits(factor) {
  const root = state.setRoot;
  if (!root || factor === state.units) return;
  root.scale.multiplyScalar(factor / state.units);
  state.units = factor;
  state.floor = null;
  removeTalent();
  root.updateMatrixWorld(true);
  applySun();
  for (const b of roleBoxes.values()) b.update();
  frameObject(root);
  emit('setLoaded', { name: state.setName, ...meshStats(root), size: state.sceneSize, units: factor });
}

/**
 * Older exports (lots of Sketchfab) use KHR_materials_pbrSpecularGlossiness, which three.js dropped:
 * those materials load as plain white metal. Rebuild them as metal/roughness: diffuse → base colour
 * (+ its texture), glossiness → 1 − roughness, non-metallic.
 */
async function convertSpecGloss(gltf) {
  const jobs = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const sg = m.userData?.gltfExtensions?.KHR_materials_pbrSpecularGlossiness;
      if (!sg || m.userData.sfConverted) continue;
      m.userData.sfConverted = true;
      const d = sg.diffuseFactor ?? [1, 1, 1, 1];
      m.color.setRGB(d[0], d[1], d[2]);                  // factors are linear, like three's working space
      m.metalness = 0;
      m.roughness = 1 - (sg.glossinessFactor ?? 1);
      if (d[3] < 1) { m.transparent = true; m.opacity = d[3]; }
      if (sg.diffuseTexture) {
        jobs.push(gltf.parser.getDependency('texture', sg.diffuseTexture.index).then((t) => {
          t.colorSpace = THREE.SRGBColorSpace; m.map = t; m.needsUpdate = true;
        }));
      }
      m.needsUpdate = true;
    }
  });
  await Promise.all(jobs);
}

/**
 * Load a glTF/GLB from local Files. A .gltf may come with its .bin and textures: every file is
 * exposed as a blob: URL and the loader's URL modifier maps relative references onto them.
 */
export async function loadSetFiles(files) {
  const main = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
  if (!main) throw new Error('No .glb or .gltf file in the selection');
  const urls = new Map();
  for (const f of files) {
    const u = URL.createObjectURL(f);
    urls.set((f.webkitRelativePath || f.relPath || f.name).toLowerCase(), u);
    urls.set(f.name.toLowerCase(), u);
  }
  const manager = new THREE.LoadingManager();
  const known = new Set(urls.values());
  manager.setURLModifier((url) => {
    if (known.has(url) || url.startsWith('data:')) return url;
    // relative refs arrive resolved against the main blob: URL → keep only the relative part
    const rel = url.replace(/^blob:[a-z]+:\/\/[^/]+\//i, '');
    const clean = decodeURIComponent(rel.split(/[?#]/)[0]).replace(/^\.?\//, '').toLowerCase();
    return urls.get(clean) || urls.get(clean.split('/').pop()) || url;
  });
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  emit('busy', { msg: 'Loading set…' });
  try {
    const gltf = await loader.loadAsync(urls.get(main.name.toLowerCase()), (e) => {
      if (e.total) emit('busy', { msg: `Loading set… ${Math.round(100 * e.loaded / e.total)}%` });
    });
    await convertSpecGloss(gltf);
    useSet(gltf.scene, main.name.replace(/\.(glb|gltf)$/i, ''));
    state.source = { kind: 'files', files };   // kept so a project can be saved with its set
  } finally {
    emit('busy', { msg: '' });
    // Textures are uploaded by now; GLB blobs can go. (Keep it simple: revoke everything.)
    setTimeout(() => { for (const u of new Set(urls.values())) URL.revokeObjectURL(u); }, 5000);
  }
}

export function applyEnv() {
  const e = state.env, isSky = e.background === 'sky';
  // the sky follows the sun's own direction: rotating it would split sky and sunlight apart
  const r = isSky ? 0 : THREE.MathUtils.degToRad(e.rotation);
  scene.environmentRotation.set(0, r, 0);
  scene.backgroundRotation.set(0, r, 0);
  // The generated sky works in physical units (far brighter than an HDRI file): scale it down so
  // Intensity 1 means "a normal day" like every other background.
  scene.environmentIntensity = e.intensity * (isSky ? SKY_GAIN : 1);
  scene.backgroundIntensity = e.intensity * (isSky ? SKY_GAIN * 1.8 : 1);   // the visible sky a little brighter than its light
  scene.backgroundBlurriness = e.blur;
  if (isSky) {
    if (!skyEnv) buildSky();
    scene.background = skyCube.texture;
    scene.environment = skyEnv;
  } else {
    scene.environment = state.hdriEnv || roomEnv;
    scene.background = (e.background === 'hdri' && state.hdrTex) ? state.hdrTex : new THREE.Color(e.color);
  }
}
export function setEnv(patch) { Object.assign(state.env, patch); applyEnv(); }
export function setExposure(v) { renderer.toneMappingExposure = v; }
export function setToneMapping(name) {
  renderer.toneMapping = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping,
    neutral: THREE.NeutralToneMapping, none: THREE.NoToneMapping }[name] ?? THREE.NeutralToneMapping;
}

export async function loadHDRIFile(file) {
  emit('busy', { msg: 'Loading HDRI…' });
  const url = URL.createObjectURL(file);
  try {
    const loader = /\.exr$/i.test(file.name) ? new EXRLoader() : new HDRLoader();
    const tex = await loader.loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    if (state.hdrTex) state.hdrTex.dispose();
    state.hdrTex = tex;
    state.hdriFile = file;
    state.hdriEnv?.dispose();
    state.hdriEnv = pmrem.fromEquirectangular(tex).texture;
    applyEnv();
    emit('hdriLoaded', { name: file.name, w: tex.image.width, h: tex.image.height });
  } finally {
    URL.revokeObjectURL(url);
    emit('busy', { msg: '' });
  }
}

export function clearHDRI() {
  state.hdriFile = null;
  if (state.hdrTex) { state.hdrTex.dispose(); state.hdrTex = null; }
  state.hdriEnv?.dispose(); state.hdriEnv = null;
  applyEnv();
}

// ---- roles: screens (dynamic inputs mapped onto meshes) -------------------------------------
export const ROLE_COLORS = { A: 0x4a9eff, B: 0x3fb950, C: 0xd9a441, D: 0xb48cff };
const roleBoxes = new Map();   // uuid -> BoxHelper

export function meshByUuid(uuid) { return state.setRoot?.getObjectByProperty('uuid', uuid) || null; }

// While tagged, a screen shows a test card (letter + "up" arrow) mapped EXACTLY like vMix will map
// the live input (same normalisation/rotation/flips as the UV pass) → orientation is checked by eye.
// The original material comes back for the background render.
function testCard(role, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 288;
  const g = c.getContext('2d');
  g.fillStyle = '#0e0f12'; g.fillRect(0, 0, 512, 288);
  g.strokeStyle = '#' + color.toString(16).padStart(6, '0'); g.lineWidth = 10; g.strokeRect(5, 5, 502, 278);
  g.fillStyle = g.strokeStyle; g.font = 'bold 150px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(role, 256, 160);
  g.beginPath(); g.moveTo(256, 18); g.lineTo(226, 58); g.lineTo(286, 58); g.fill();      // ▲ = top of the input
  g.font = '22px sans-serif'; g.fillText('SCREEN ' + role, 256, 262);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export function uvTransform(mesh) {
  const geo = mesh.geometry;
  if (!geo.attributes.uv) {   // planar projection on the two largest axes (Y stays vertical)
    geo.computeBoundingBox();
    const s = geo.boundingBox.getSize(new THREE.Vector3());
    const ax = [0, 1, 2].sort((a, b) => s.getComponent(b) - s.getComponent(a));
    const [a, b] = ax[0] === 1 ? [ax[1], ax[0]] : [ax[0], ax[1]];
    const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getComponent(i, a); uv[i * 2 + 1] = -p.getComponent(i, b); }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const uv = geo.attributes.uv, min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    min.x = Math.min(min.x, u); min.y = Math.min(min.y, v); max.x = Math.max(max.x, u); max.y = Math.max(max.y, v);
  }
  return { min, max };
}
export const UV_GLSL = /* glsl */`
  uniform vec2 uvMin, uvMax; uniform int rot; uniform float flipU, flipV;
  vec2 sfUV(vec2 uv) {
    vec2 t = clamp((uv - uvMin) / max(uvMax - uvMin, vec2(1e-6)), 0.0, 1.0);
    for (int i = 0; i < 4; i++) if (i < rot) t = vec2(1.0 - t.y, t.x);   // 90° steps
    if (flipU > 0.5) t.x = 1.0 - t.x;
    if (flipV > 0.5) t.y = 1.0 - t.y;
    return t;   // v DOWN (vMix / glTF image convention)
  }`;
export function uvUniforms() {
  return { uvMin: { value: new THREE.Vector2() }, uvMax: { value: new THREE.Vector2(1, 1) },
    rot: { value: 0 }, flipU: { value: 0 }, flipV: { value: 0 } };
}
export function setUvUniforms(u, mesh, opts) {
  const { min, max } = uvTransform(mesh);
  u.uvMin.value.copy(min); u.uvMax.value.copy(max);
  u.rot.value = opts.rot || 0; u.flipU.value = opts.flipU ? 1 : 0; u.flipV.value = opts.flipV ? 1 : 0;
}
function cardMaterial(role) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uvUniforms(), map: { value: testCard(role, ROLE_COLORS[role] ?? 0xffffff) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    // flipY=true canvas texture: image top is at t=1 → sample with 1-v
    fragmentShader: UV_GLSL + `uniform sampler2D map; varying vec2 vUv;
      void main(){ vec2 t = sfUV(vUv); gl_FragColor = texture2D(map, vec2(t.x, 1.0 - t.y));
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  });
}

/**
 * Orientation that makes the live input read UPRIGHT and UNMIRRORED as seen from the camera, whatever
 * way the modeller laid the screen's UVs (Sketchfab exports often come upside down or rotated).
 * Measures, in world space, which way u and v grow on the surface (dP/du, dP/dv summed over the
 * triangles) against "right" and "down" for a viewer facing the screen. → { rot, flipU, flipV }
 * in the order the shader applies them (rotate, then mirror).
 */
export function autoOrient(mesh) {
  const geo = mesh.geometry;
  uvTransform(mesh);   // makes sure there is a uv attribute
  const pos = geo.attributes.position, uv = geo.attributes.uv, idx = geo.index;
  mesh.updateMatrixWorld(true);
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], t = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
  const dPdu = new THREE.Vector3(), dPdv = new THREE.Vector3(), nrm = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const tri = idx ? idx.count / 3 : pos.count / 3;
  for (let f = 0; f < tri; f++) {
    for (let k = 0; k < 3; k++) {
      const i = idx ? idx.getX(f * 3 + k) : f * 3 + k;
      p[k].fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      t[k].fromBufferAttribute(uv, i);
    }
    e1.subVectors(p[1], p[0]); e2.subVectors(p[2], p[0]);
    const du1 = t[1].x - t[0].x, dv1 = t[1].y - t[0].y, du2 = t[2].x - t[0].x, dv2 = t[2].y - t[0].y;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const w = e1.clone().cross(e2).length();          // weight by area
    nrm.add(e1.clone().cross(e2));
    dPdu.addScaledVector(e1.clone().multiplyScalar(dv2).addScaledVector(e2, -dv1), w / det);
    dPdv.addScaledVector(e2.clone().multiplyScalar(du1).addScaledVector(e1, -du2), w / det);
  }
  // Facing direction = the side the camera is on.
  const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
  if (nrm.lengthSq() < 1e-12) return { rot: 0, flipU: false, flipV: false };
  nrm.normalize();
  if (nrm.dot(camera.position.clone().sub(center)) < 0) nrm.negate();
  const up = Math.abs(nrm.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);  // floor/ceiling screens: "up" = away
  const right = new THREE.Vector3().crossVectors(up, nrm).normalize();
  const down = new THREE.Vector3().crossVectors(right, nrm).normalize();   // = -up projected on the surface
  const a = dPdu.dot(right), b = dPdu.dot(down), c = dPdv.dot(right), d = dPdv.dot(down);
  if (Math.abs(a) + Math.abs(d) >= Math.abs(b) + Math.abs(c)) return { rot: 0, flipU: a < 0, flipV: d < 0 };
  // u runs vertically: one 90° step gives x = 1 - v, y = u; then mirror what still runs backwards.
  return { rot: 1, flipU: c > 0, flipV: b < 0 };
}

export function setRole(mesh, role, opts = {}) {
  if (!state.roles.has(mesh.uuid) && role) opts = { ...autoOrient(mesh), ...opts };
  const old = roleBoxes.get(mesh.uuid);
  if (old) { helpers.remove(old); old.dispose(); roleBoxes.delete(mesh.uuid); }
  const prev = state.roles.get(mesh.uuid);
  if (prev) { mesh.material.uniforms.map.value.dispose(); mesh.material.dispose(); mesh.material = prev.original; }
  if (!role) { state.roles.delete(mesh.uuid); emit('roles'); return; }
  const r = { flipU: false, flipV: false, rot: 0, ...(prev || {}), ...opts, role, name: mesh.name || 'mesh', original: mesh.material };
  state.roles.set(mesh.uuid, r);
  mesh.material = cardMaterial(role);
  setUvUniforms(mesh.material.uniforms, mesh, r);
  const box = new THREE.BoxHelper(mesh, ROLE_COLORS[role] ?? 0xffffff);
  roleBoxes.set(mesh.uuid, box);
  helpers.add(box);
  emit('roles');
}
export function updateRole(uuid, patch) {
  const r = state.roles.get(uuid), mesh = meshByUuid(uuid);
  if (!r || !mesh) return;
  Object.assign(r, patch);
  setUvUniforms(mesh.material.uniforms, mesh, r);
  emit('roles');
}
/** Swap the original screen materials in (true) or the test cards back (false). */
function showOriginals(on) {
  for (const [uuid, r] of state.roles) {
    const mesh = meshByUuid(uuid);
    if (!mesh) continue;
    if (on) { r.card = mesh.material; mesh.material = r.original; }
    else if (r.card) { mesh.material = r.card; r.card = null; }
  }
}
function clearRoles() {
  for (const b of roleBoxes.values()) { helpers.remove(b); b.dispose(); }
  roleBoxes.clear();
  state.roles.clear();   // the old set (and its materials) is disposed by the caller
  emit('roles');
}

// ---- talent card: where the keyed presenter will land -----------------------------------------
// A vertical plane standing on the floor, always facing the camera horizontally. Its height is the
// real-world height the REAL camera frames at the presenter (≈2.2 m = full body with headroom);
// the width follows the input's 16:9. It is a helper (never rendered into the background).
const TALENT_ASPECT = 16 / 9;
// The card IS the real camera's whole frame, so with a matched camera it fills the shot: a tinted
// rectangle told nothing (and hid every turn). Show a 1.75 m person standing in it instead — where
// the presenter will be, how big, which way it turns — and only the frame's outline.
const PERSON_H = 1.75;
const cardCanvas = Object.assign(document.createElement('canvas'), { width: 576, height: 324 });
const cardTex = new THREE.CanvasTexture(cardCanvas);
cardTex.colorSpace = THREE.SRGBColorSpace;
function drawCard(frameH) {
  const g = cardCanvas.getContext('2d'), W = cardCanvas.width, H = cardCanvas.height;
  g.clearRect(0, 0, W, H);
  const h = Math.min(0.98, PERSON_H / frameH) * H, cx = W / 2, feet = H, u = h / 1.75;   // u = pixels per "person metre"
  g.fillStyle = 'rgba(255,90,77,0.55)'; g.strokeStyle = 'rgba(255,138,125,0.95)'; g.lineWidth = 2;
  const head = 0.12 * u;
  g.beginPath(); g.arc(cx, feet - h + head, head, 0, Math.PI * 2); g.fill(); g.stroke();
  const shoulderY = feet - h + 2.15 * head, hipY = feet - 0.85 * u;
  g.beginPath(); g.roundRect(cx - 0.23 * u, shoulderY, 0.46 * u, hipY - shoulderY, 0.09 * u); g.fill(); g.stroke();   // torso
  g.beginPath(); g.roundRect(cx - 0.2 * u, hipY - 0.02 * u, 0.17 * u, feet - hipY, 0.05 * u); g.fill(); g.stroke();     // legs
  g.beginPath(); g.roundRect(cx + 0.03 * u, hipY - 0.02 * u, 0.17 * u, feet - hipY, 0.05 * u); g.fill(); g.stroke();
  g.beginPath(); g.roundRect(cx - 0.33 * u, shoulderY + 0.03 * u, 0.09 * u, 0.62 * u, 0.04 * u); g.fill(); g.stroke(); // arms
  g.beginPath(); g.roundRect(cx + 0.24 * u, shoulderY + 0.03 * u, 0.09 * u, 0.62 * u, 0.04 * u); g.fill(); g.stroke();
  cardTex.needsUpdate = true;
}

export function placeTalent(point, frameH = 2.2) {
  removeTalent();
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);    // origin at the bottom edge (feet)
  const mat = new THREE.MeshBasicMaterial({ map: cardTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xff5a4d }));
  mesh.add(edges);
  mesh.position.copy(point);
  helpers.add(mesh);
  mesh.layers.set(1);                   // helper layer: the AO pass must not see the card
  state.talent = { mesh, frameH };
  setTalentHeight(frameH);
  emit('talent');
}
/** Camera-relative position of the presenter: distance ahead (m) and sideways (m, + = right). */
function camAxes() {
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position); fwd.y = 0;
  if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, -1);
  fwd.normalize();
  return { fwd, right: new THREE.Vector3(-fwd.z, 0, fwd.x) };
}
export function talentInfo() {
  if (!state.talent) return null;
  const { fwd, right } = camAxes(), d = new THREE.Vector3().subVectors(state.talent.mesh.position, camera.position);
  return { dist: d.dot(fwd), side: d.dot(right), raise: state.talent.mesh.position.y - state.floorY, turn: state.talent.turn || 0, frameH: state.talent.frameH };
}
export function setTalentRelative(dist, side) {
  if (!state.talent) return;
  const { fwd, right } = camAxes(), m = state.talent.mesh;
  const y = m.position.y;
  m.position.copy(camera.position).addScaledVector(fwd, dist).addScaledVector(right, side);
  m.position.y = y;
  emit('talent');
}
/** Height of the presenter's feet above the set floor (a riser, a step). */
export function setTalentRaise(h) {
  if (!state.talent) return;
  state.talent.mesh.position.y = state.floorY + h;
  emit('talent');
}
/** Put the presenter (creating the card if needed) in the middle of the shot, standing on the floor. */
export function centerTalent(defaultDist = 3) {
  const info = talentInfo();
  const dist = info ? Math.max(0.5, info.dist) : defaultDist;
  if (!state.talent) placeTalent(new THREE.Vector3(camera.position.x, state.floorY, camera.position.z));
  setTalentRelative(dist, 0);
}
export function setTalentHeight(h) {
  if (!state.talent) return;
  state.talent.frameH = h;
  state.talent.mesh.scale.set(h * TALENT_ASPECT, h, 1);
  drawCard(h);
  emit('talent');
}
export function removeTalent() {
  if (!state.talent) return;
  helpers.remove(state.talent.mesh);
  state.talent.mesh.geometry.dispose();
  state.talent = null;
  emit('talent');
}
function faceCamera(mesh) {
  // Always square to the camera (that is how the real camera sees the presenter), plus an optional
  // turn: the card is a flat picture, so a big turn squeezes the presenter — hence the ±60° limit.
  const turn = THREE.MathUtils.degToRad(state.talent?.turn || 0);
  mesh.rotation.set(0, Math.atan2(camera.position.x - mesh.position.x, camera.position.z - mesh.position.z) + turn, 0);
}
export function setTalentTurn(deg) {
  if (!state.talent) return;
  state.talent.turn = THREE.MathUtils.clamp(deg, -60, 60);
  emit('talent');
}

// ---- props: select, hide, move (softboxes, cameras, people left in a downloaded set) ----------
// "Object" = the node right under the set's top container (Sketchfab nests Sketchfab_model > root >
// GLTF_SceneRootNode > the real objects), so one click takes a whole lamp, not one of its screws.
const transform = new TransformControls(camera, canvas);
transform.setSize(0.8);
helpers.add(transform.getHelper());
transform.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
transform.addEventListener('objectChange', () => {
  const lid = transform.object?.userData.lightId;
  if (lid) { updateLight(lid, { pos: transform.object.position.toArray() }); return; }   // the gizmo is on a light
  selBox?.update(); for (const b of roleBoxes.values()) b.update(); emit('objects');
});
let selected = null, selBox = null;
const original = new Map();   // uuid -> { position, quaternion, scale } before the first move
export const edits = { hidden: new Set(), moved: new Set(), foreground: new Set() };

function container(root) {
  let c = root;
  while (c.children.length === 1 && !c.children[0].isMesh) c = c.children[0];
  return c;
}
export function objectOf(mesh) {
  const top = container(state.setRoot);
  let o = mesh;
  while (o.parent && o.parent !== top && o.parent !== state.setRoot) o = o.parent;
  return o;
}
export function isShown(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; }

export function select(obj) {
  if (selBox) { helpers.remove(selBox); selBox.dispose(); selBox = null; }
  transform.detach();
  if (obj) markLightSelected(null);       // one thing selected at a time
  selected = obj;
  if (hoverBox) { helpers.remove(hoverBox); hoverBox.dispose(); hoverBox = null; hoverObj = null; }
  if (obj) {
    selBox = new THREE.BoxHelper(obj, 0xffffff);
    helpers.add(selBox);
  }
  emit('objects');
}
export function selectParent() {
  if (!selected) return;
  const top = container(state.setRoot);
  if (selected.parent && selected.parent !== top && selected.parent !== state.setRoot) select(selected.parent);
}
export function getSelected() { return selected; }
export function setTransformMode(mode) {   // null | 'translate' | 'rotate'
  if (!selected || !mode) { transform.detach(); emit('objects'); return; }
  if (!original.has(selected.uuid)) {
    original.set(selected.uuid, { p: selected.position.clone(), q: selected.quaternion.clone(), s: selected.scale.clone() });
  }
  edits.moved.add(selected.uuid);
  transform.setMode(mode);
  // Move: the object itself is dragged ON THE FLOOR (see floorDrag); the gizmo only keeps the green
  // up/down arrow. X/Z arrows were awkward: the one pointing at the camera barely responds.
  // Rotate: only the ring around the vertical axis.
  transform.setSpace('world');
  transform.showX = transform.showZ = false;
  transform.showY = true;
  transform.attach(selected);
  emit('objects');
}
export function transformMode() { return transform.object && transform.object === selected ? transform.mode : null; }
export function hideSelected() {
  if (!selected) return;
  selected.visible = false;
  edits.hidden.add(selected.uuid);
  select(null);
}
export function showObject(uuid) {
  const o = state.setRoot?.getObjectByProperty('uuid', uuid);
  if (o) o.visible = true;
  edits.hidden.delete(uuid);
  emit('objects');
}
export function resetSelected() {
  if (!selected) return;
  const o = original.get(selected.uuid);
  if (o) { selected.position.copy(o.p); selected.quaternion.copy(o.q); selected.scale.copy(o.s); }
  edits.moved.delete(selected.uuid);
  transform.detach();
  selBox?.update();
  emit('objects');
}
export function hiddenObjects() {
  return [...edits.hidden].map((uuid) => state.setRoot?.getObjectByProperty('uuid', uuid)).filter(Boolean);
}
/** Foreground = props that stand IN FRONT of the presenter (a desk). Exported as a PNG with alpha. */
export function toggleForeground() {
  if (!selected) return;
  if (edits.foreground.has(selected.uuid)) edits.foreground.delete(selected.uuid);
  else edits.foreground.add(selected.uuid);
  emit('objects');
}
export function isForeground(o) { return !!o && edits.foreground.has(o.uuid); }
export function foregroundObjects() {
  return [...edits.foreground].map((uuid) => state.setRoot?.getObjectByProperty('uuid', uuid)).filter(Boolean);
}
export function unsetForeground(uuid) { edits.foreground.delete(uuid); emit('objects'); }
function clearEdits() {
  select(null);
  original.clear(); edits.hidden.clear(); edits.moved.clear(); edits.foreground.clear();
  emit('objects');
}

// ---- picking ----------------------------------------------------------------------------------
// A click (not a drag) in pick mode reports the mesh/point under the cursor.
export let pickMode = null;      // null | 'screen' | 'talent'
export function setPickMode(m) { pickMode = m; document.body.classList.toggle('picking', !!m); if (m !== 'object') hoverAt(-1e4, -1e4); }
const raycaster = new THREE.Raycaster();
raycaster.layers.enableAll();
let downAt = null;
// Floor drag (Move mode): press ON the selected object and drag — it slides on the horizontal plane
// through the point you grabbed, following the mouse. Captured before OrbitControls sees the press.
const ndcOf = (e) => {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
};
let floorDrag = null;   // { obj, plane, offset, talent }
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || transform.axis) return;
  raycaster.setFromCamera(ndcOf(e), camera);
  let obj = null, hit = null, lightEntry = null;
  if (!pickMode && handles.children.length) {          // a light's dot: select it, and drag it
    const h = raycaster.intersectObjects(handles.children, false)[0];
    if (h) { lightEntry = state.lights.find((l) => l.handle === h.object); if (lightEntry) { obj = h.object; hit = h; selectLight(lightEntry.id); } }
  }
  if (!obj && selected && transform.mode === 'translate' && transform.object) {
    hit = raycaster.intersectObject(selected, true).find((h) => h.object.isMesh);
    if (hit) obj = selected;
  }
  // The presenter card can always be dragged — unless something of the set is in front of it there.
  if (!obj && state.talent && !pickMode) {
    const t = raycaster.intersectObject(state.talent.mesh, false)[0];
    const front = state.setRoot && raycaster.intersectObject(state.setRoot, true).find((h) => h.object.isMesh && isShown(h.object));
    if (t && (!front || t.distance < front.distance)) { obj = state.talent.mesh; hit = t; }
  }
  if (!obj) {
    if (selectedLightId && !pickMode) lightClick = [e.clientX, e.clientY];   // a plain click elsewhere = deselect
    return;
  }
  e.stopImmediatePropagation();          // OrbitControls must not orbit while we drag
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
  floorDrag = { obj, plane, offset: obj.getWorldPosition(new THREE.Vector3()).sub(hit.point), talent: obj === state.talent?.mesh,
    light: lightEntry, x0: e.clientX, y0: e.clientY };
  canvas.setPointerCapture(e.pointerId);
}, { capture: true });
canvas.addEventListener('pointermove', (e) => {
  if (!floorDrag) return;
  if (floorDrag.talent) {
    // Presenter: left/right follows the mouse 1:1 at the presenter's distance; up/down = further/closer,
    // gently (a plane through the chest, seen from eye height, would make tiny moves huge). Shift = fine.
    const cur = talentInfo(), r = canvas.getBoundingClientRect();
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) / camera.zoom;
    const perPx = (2 * Math.max(0.5, cur.dist) * Math.tan(hfov / 2)) / r.width * (e.shiftKey ? SLOW : 1);
    const dx = e.clientX - floorDrag.x0, dy = e.clientY - floorDrag.y0;   // since the last move: Shift can change mid-drag
    floorDrag.x0 = e.clientX; floorDrag.y0 = e.clientY;
    if (e.altKey) { setTalentRaise(cur.raise - dy * perPx); return; }   // Alt: up/down = raise / lower (riser, step)
    setTalentRelative(Math.max(0.3, cur.dist - dy * perPx * 2), cur.side + dx * perPx);
    return;
  }
  if (floorDrag.light) {                // a light: slide on its own height; Alt = up / down
    const L = floorDrag.light, dy = e.clientY - floorDrag.y0;
    floorDrag.y0 = e.clientY;
    if (e.altKey) {
      const r = canvas.getBoundingClientRect(), d = camera.position.distanceTo(L.handle.position);
      const perPx = (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / r.height * (e.shiftKey ? SLOW : 1);
      updateLight(L.id, { pos: [L.pos[0], L.pos[1] - dy * perPx, L.pos[2]] });
      floorDrag.plane.constant = -L.pos[1];
      return;
    }
    raycaster.setFromCamera(ndcOf(e), camera);
    const q = raycaster.ray.intersectPlane(floorDrag.plane, new THREE.Vector3());
    if (q) { q.add(floorDrag.offset); updateLight(L.id, { pos: [q.x, L.pos[1], q.z] }); }
    return;
  }
  raycaster.setFromCamera(ndcOf(e), camera);
  const p = raycaster.ray.intersectPlane(floorDrag.plane, new THREE.Vector3());
  if (!p) return;
  const o = floorDrag.obj;
  o.position.copy(o.parent.worldToLocal(p.add(floorDrag.offset)));
  o.updateMatrixWorld(true);
  if (floorDrag.talent) emit('talent');
  else { selBox?.update(); for (const b of roleBoxes.values()) b.update(); }
});
let lightClick = null;
canvas.addEventListener('pointerup', (e) => {
  if (lightClick) {
    if (Math.hypot(e.clientX - lightClick[0], e.clientY - lightClick[1]) < 4) selectLight(null);
    lightClick = null;
  }
  if (!floorDrag) return;
  const wasTalent = floorDrag.talent, wasLight = !!floorDrag.light;
  floorDrag = null;
  if (wasLight) { canvas.releasePointerCapture(e.pointerId); downAt = null; emit('lights'); return; }
  canvas.releasePointerCapture(e.pointerId);
  downAt = null;                         // a drag is not a pick
  emit(wasTalent ? 'talent' : 'objects');
}, { capture: true });
// a hand cursor over the draggable presenter card
canvas.addEventListener('pointermove', (e) => {
  if (floorDrag || pickMode || !state.talent) { if (!floorDrag) canvas.style.cursor = ''; return; }
  raycaster.setFromCamera(ndcOf(e), camera);
  canvas.style.cursor = raycaster.intersectObject(state.talent.mesh, false).length ? 'grab' : '';
});

// Zoom TOWARDS THE CURSOR (Blender / SketchUp style), replacing OrbitControls' zoom, which only
// approaches a fixed pivot and stalls there — in a big set you never reach the desk you point at.
// Each wheel step travels a fraction of the distance to whatever is under the cursor: fast from far,
// fine up close, and it never stops (it goes through walls). Camera and pivot move together, so
// the framing (tilt/pan) stays as it was.
controls.enableZoom = false;
function cursorRay(e) { raycaster.setFromCamera(ndcOf(e), camera); return raycaster.ray; }
function surfaceDistance(ray) {
  if (!state.setRoot) return null;
  raycaster.ray.copy(ray);
  // Ignore what is practically touching the lens: pressed against a wall, the next step should aim
  // at what lies BEYOND it, so the camera passes through instead of crawling.
  const hit = raycaster.intersectObject(state.setRoot, true).find((h) => h.object.isMesh && isShown(h.object) && h.distance > 0.35);
  return hit ? hit.distance : null;
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const ray = cursorRay(e);
  const d = surfaceDistance(ray) ?? controls.target.distanceTo(camera.position);
  // trackpads send many small deltas, mice fewer big ones; pinch arrives as ctrl+wheel
  // macOS turns Shift+wheel into a horizontal scroll: take whichever axis carries the movement
  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (!delta) return;
  const amount = THREE.MathUtils.clamp(Math.abs(delta) / (e.deltaMode === 1 ? 3 : 100), 0.05, 3) * speedFactor(e);
  const step = Math.max(0.08, d * 0.15) * amount * (delta < 0 ? 1 : -1);
  const move = ray.direction.clone().multiplyScalar(step);
  camera.position.add(move); controls.target.add(move);
  controls.update(); camDirty = true;
}, { passive: false });

// Double-click on something = orbit around it from now on (the camera does not move).
canvas.addEventListener('dblclick', (e) => {
  if (pickMode) return;
  const ray = cursorRay(e), d = surfaceDistance(ray);
  if (d == null) return;
  controls.target.copy(ray.at(d, new THREE.Vector3()));
  controls.update(); camDirty = true;
  emit('pivot', { point: controls.target.toArray() });
});

// Hover preview in select mode: a faint box around what a click would take.
let hoverBox = null, hoverObj = null, hoverQueued = false;
function hoverAt(x, y) {
  let obj = null;
  if (pickMode === 'object' && state.setRoot && !transform.dragging) {
    const r = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
    const hit = raycaster.intersectObject(state.setRoot, true).find((h) => h.object.isMesh && isShown(h.object));
    if (hit) obj = objectOf(hit.object);
  }
  if (obj === hoverObj) return;
  hoverObj = obj;
  if (hoverBox) { helpers.remove(hoverBox); hoverBox.dispose(); hoverBox = null; }
  if (obj && obj !== selected) { hoverBox = new THREE.BoxHelper(obj, 0xff5a4d); hoverBox.material.transparent = true; hoverBox.material.opacity = 0.6; helpers.add(hoverBox); }
}
canvas.addEventListener('pointermove', (e) => {
  if (pickMode !== 'object' || hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => { hoverQueued = false; hoverAt(e.clientX, e.clientY); });
});
canvas.addEventListener('pointerleave', () => hoverAt(-1e4, -1e4));

canvas.addEventListener('pointerdown', (e) => { downAt = transform.axis ? null : [e.clientX, e.clientY]; });  // not on a gizmo handle
canvas.addEventListener('pointerup', (e) => {
  if (!pickMode || !downAt || !state.setRoot) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(state.setRoot, true).find((h) => h.object.isMesh && isShown(h.object));
  if (hit) {
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    emit('pick', { mode: pickMode, mesh: hit.object, point: hit.point, normal });
  }
});

// ---- plain image export -----------------------------------------------------------------------
/** Render ONE frame at the exact output size (pixel ratio 1, helpers hidden) and return a PNG Blob. */
export async function renderPNG(w, h) {
  helpers.visible = false;
  showOriginals(true);
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.zoom = 1;                       // the export is always the full frame, whatever is previewed
  camera.updateProjectionMatrix();
  if (composer) { composer.setPixelRatio(1); composer.setSize(w, h); }
  draw();
  // toDataURL is synchronous: it grabs THIS frame before the render loop can draw over it.
  const dataUrl = canvas.toDataURL('image/png');
  showOriginals(false);
  helpers.visible = true;
  layout();
  return (await fetch(dataUrl)).blob();
}

// OrbitControls turns Shift+left-drag into PAN; here Shift means "slow", so Shift+drag must keep
// ORBITING (slowly). Re-dispatch the press without the Shift flag. Registered last: the floor drag
// and the gizmo get the press first.
canvas.addEventListener('pointerdown', (e) => {
  if (!e.isTrusted || !e.shiftKey || e.button !== 0 || transform.axis) return;
  e.stopImmediatePropagation();
  canvas.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, composed: true, pointerId: e.pointerId, pointerType: e.pointerType,
    isPrimary: e.isPrimary, button: e.button, buttons: e.buttons, clientX: e.clientX, clientY: e.clientY,
    screenX: e.screenX, screenY: e.screenY, altKey: e.altKey, shiftKey: false,
  }));
}, { capture: true });

// ---- shot preview ------------------------------------------------------------------------------
/** Show a vMix zoom in the viewer: a centred zoom of the camera = exactly vMix's centred 2D crop. */
export function setPreviewZoom(z) { state.previewZoom = z > 1 ? z : 0; layout(); camDirty = true; }

// ---- project snapshot: stable addresses for objects across reloads ------------------------------
// uuids change every time a file is loaded; the child-index path from the set root does not.
export function pathOf(o) {
  const path = [];
  for (; o && o !== state.setRoot; o = o.parent) path.unshift(o.parent.children.indexOf(o));
  return path.join('/');
}
export function byPath(path) {
  let o = state.setRoot;
  for (const i of String(path).split('/').filter((x) => x !== '')) o = o?.children[+i];
  return o || null;
}
export function snapshot() {
  return {
    units: state.units,
    env: { ...state.env },
    exposure: renderer.toneMappingExposure,
    sun: { ...state.sun }, ao: { ...state.ao },
    lights: lightsSnapshot(),
    view: getView(),
    roles: [...state.roles.entries()].map(([uuid, r]) => {
      const m = meshByUuid(uuid);
      return m && { path: pathOf(m), role: r.role, rot: r.rot, flipU: r.flipU, flipV: r.flipV };
    }).filter(Boolean),
    talent: state.talent ? { pos: state.talent.mesh.position.toArray(), frameH: state.talent.frameH, turn: state.talent.turn || 0 } : null,
    hidden: hiddenObjects().map(pathOf),
    foreground: foregroundObjects().map(pathOf),
    moved: [...edits.moved].map((uuid) => state.setRoot.getObjectByProperty('uuid', uuid)).filter(Boolean)
      .map((o) => ({ path: pathOf(o), p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() })),
  };
}
/** Re-apply a snapshot onto the freshly loaded set (same file → same paths). */
export function restore(snap) {
  if (snap.units && snap.units !== state.units) setUnits(snap.units);
  for (const m of snap.moved || []) {
    const o = byPath(m.path);
    if (!o) continue;
    original.set(o.uuid, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
    o.position.fromArray(m.p); o.quaternion.fromArray(m.q); o.scale.fromArray(m.s);
    edits.moved.add(o.uuid);
  }
  for (const path of snap.foreground || []) {
    const o = byPath(path);
    if (o) edits.foreground.add(o.uuid);
  }
  for (const path of snap.hidden || []) {
    const o = byPath(path);
    if (o) { o.visible = false; edits.hidden.add(o.uuid); }
  }
  state.setRoot.updateMatrixWorld(true);
  for (const r of snap.roles || []) {
    const m = byPath(r.path);
    if (m?.isMesh) setRole(m, r.role, { rot: r.rot, flipU: r.flipU, flipV: r.flipV });
  }
  if (snap.talent) {
    placeTalent(new THREE.Vector3().fromArray(snap.talent.pos), snap.talent.frameH);
    if (snap.talent.turn) setTalentTurn(snap.talent.turn);
  }
  if (snap.env) setEnv(snap.env);
  if (snap.exposure) setExposure(snap.exposure);
  if (snap.sun) setSun(snap.sun);
  if (snap.ao) setAO(snap.ao);
  if (snap.lights) restoreLights(snap.lights);
  if (snap.view) setView(snap.view);
  emit('objects');
}

// ---- clean output window (for vMix Desktop Capture / NDI Screen Capture → ATEM) -----------------
// A second window with ONLY the set picture, 1920×1080: no UI, no helpers, screens with their
// real material, live camera NOT included (the ATEM / Ultimatte composites the real camera).
// Each frame the set is drawn once clean and copied there, then drawn again for this window.
const OUTPUT_W = 1920, OUTPUT_H = 1080;
export function openOutput() {
  if (state.output && !state.output.win.closed) { state.output.win.focus(); return; }
  const win = window.open('output.html', 'setframer-output', `width=${OUTPUT_W / 2},height=${OUTPUT_H / 2 + 40}`);
  if (!win) throw new Error('The browser blocked the new window — allow pop-ups for this page');
  state.output = { win, ctx: null };
  layout();
  emit('output', { open: true });
}
export function closeOutput() {
  if (state.output && !state.output.win.closed) state.output.win.close();
  state.output = null;
  layout();
  emit('output', { open: false });
}
function renderOutput() {
  const o = state.output;
  if (o.win.closed) { state.output = null; layout(); emit('output', { open: false }); return; }
  if (!o.ctx) {
    const c = o.win.document?.getElementById('out');
    if (!c) return;                        // window still loading
    c.width = OUTPUT_W; c.height = OUTPUT_H;
    o.ctx = c.getContext('2d');
  }
  helpers.visible = false;
  showOriginals(true);
  draw();
  o.ctx.drawImage(canvas, 0, 0, OUTPUT_W, OUTPUT_H);   // same task as the render: the buffer is still valid
  showOriginals(false);
  helpers.visible = true;
}

// ---- foreground layer: the props in front of the presenter, as a PNG with transparency ---------
// The canvas has no alpha channel, so transparency is recovered by "difference matting": render the
// foreground over pure black and over pure white; alpha = 1 − (white − black), colour = black / alpha.
// Everything else in the set is drawn depth-only: it still hides what is behind it, but paints nothing.
const depthOnlyMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
function underForeground(o) { for (; o; o = o.parent) if (edits.foreground.has(o.uuid)) return true; return false; }
export async function renderForegroundPNG(w, h) {
  if (!edits.foreground.size || !state.setRoot) return null;
  const saved = { bg: scene.background, clear: renderer.getClearColor(new THREE.Color()), clearA: renderer.getClearAlpha() };
  const swapped = [];
  helpers.visible = false;
  glows.visible = false;
  showOriginals(true);
  state.setRoot.traverse((o) => {
    if (!o.isMesh || underForeground(o)) return;
    swapped.push([o, o.material]);
    o.material = depthOnlyMat;
  });
  scene.background = null;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.zoom = 1; camera.updateProjectionMatrix();
  const shot = (hex) => { renderer.setClearColor(hex, 1); renderer.render(scene, camera); return canvas.toDataURL('image/png'); };
  let black, white;
  try { black = shot(0x000000); white = shot(0xffffff); }
  finally {
    for (const [o, m] of swapped) o.material = m;
    scene.background = saved.bg;
    renderer.setClearColor(saved.clear, saved.clearA);
    showOriginals(false);
    helpers.visible = true;
    glows.visible = true;
    layout();
  }
  const pixels = async (url) => {   // createImageBitmap, not <img>.decode(): that one stalls in a background tab
    const img = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, w, h);
  };
  const B = await pixels(black), W = await pixels(white), out = new ImageData(w, h);
  for (let i = 0; i < B.data.length; i += 4) {
    const diff = ((W.data[i] - B.data[i]) + (W.data[i + 1] - B.data[i + 1]) + (W.data[i + 2] - B.data[i + 2])) / 3;
    const a = Math.max(0, Math.min(255, 255 - diff));
    out.data[i + 3] = a;
    if (a > 0) for (let k = 0; k < 3; k++) out.data[i + k] = Math.min(255, Math.round(B.data[i + k] * 255 / a));
  }
  const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(out, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

// ---- live camera in the viewer (capture card / webcam), with a chroma key ----------------------
// Drawn over the set as a full-frame layer, after the set, only in this window: it is for framing,
// never exported. Key = OBS-style chroma distance in BT.709 CbCr, with spill suppression.
export const live = { video: null, stream: null, texture: null, show: false, mode: 'card' };   // mode: 'card' | 'frame'
const liveMat = new THREE.ShaderMaterial({
  uniforms: {
    map: { value: null }, keyOn: { value: 1 }, keyCbCr: { value: new THREE.Vector2() },
    similarity: { value: 0.25 }, smoothness: { value: 0.08 }, spill: { value: 0.1 }, opacity: { value: 1 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D map; uniform float keyOn, similarity, smoothness, spill, opacity; uniform vec2 keyCbCr;
    varying vec2 vUv;
    vec2 cbcr(vec3 c) { return vec2(-0.1146 * c.r - 0.3854 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4542 * c.g - 0.0458 * c.b); }
    vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
    void main() {
      // three.js hands video textures to custom shaders UNdecoded (sRGB values): key right there,
      // in display space like OBS / vMix, and convert to linear only for output.
      vec3 c = texture2D(map, vUv).rgb;
      float a = 1.0;
      if (keyOn > 0.5) {
        float base = distance(cbcr(c), keyCbCr) - similarity;
        a = pow(clamp(base / max(smoothness, 1e-4), 0.0, 1.0), 1.5);
        float sp = pow(clamp(base / max(spill, 1e-4), 0.0, 1.0), 1.5);
        float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(luma), c, sp);
      }
      gl_FragColor = vec4(toLin(c), a * opacity);
      #include <colorspace_fragment>
    }`,
  transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
});
// Same key, mapped onto the presenter card in 3D (what vMix's Talent layer does): the set occludes it.
const liveCardMat = new THREE.ShaderMaterial({
  uniforms: liveMat.uniforms,             // shared: one set of key controls
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: liveMat.fragmentShader,
  transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
});
let cardMat = null;                        // the card's own (coral, see-through) material while live is on it
function syncTalentLive() {
  const t = state.talent;
  if (!t) return;
  const want = live.show && live.video && live.mode === 'card';
  if (want && t.mesh.material !== liveCardMat) { cardMat = t.mesh.material; t.mesh.material = liveCardMat; t.mesh.children.forEach((c) => { c.visible = false; }); }
  else if (!want && t.mesh.material === liveCardMat) { t.mesh.material = cardMat; t.mesh.children.forEach((c) => { c.visible = true; }); }
}
const liveScene = new THREE.Scene(), liveCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
liveScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), liveMat));

// Every camera stream ever opened is tracked, and stopping stops ALL of them: a second Connect
// while the permission prompt is up (or a quick source switch) used to orphan a stream, and an
// orphaned stream keeps the camera — and its green light — on.
const openStreams = new Set();
let startSeq = 0;
export async function startLiveCamera(deviceId) {
  stopLiveCamera();
  const seq = ++startSeq;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
  });
  openStreams.add(stream);
  if (seq !== startSeq) { stream.getTracks().forEach((t) => t.stop()); openStreams.delete(stream); return; }   // superseded meanwhile
  const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: stream });
  await video.play();
  live.video = video; live.stream = stream;
  live.texture = new THREE.VideoTexture(video);
  live.texture.colorSpace = THREE.SRGBColorSpace;
  liveMat.uniforms.map.value = live.texture;
  live.show = true;
  const t = stream.getVideoTracks()[0];
  emit('live', { on: true, label: t.label, ...t.getSettings() });
}
export function stopLiveCamera() {
  startSeq++;                                          // a getUserMedia still pending will stop itself on arrival
  for (const st of openStreams) st.getTracks().forEach((t) => t.stop());   // stopping every track turns the light off
  openStreams.clear();
  live.stream?.getTracks().forEach((t) => t.stop());
  if (live.video) { live.video.pause(); live.video.srcObject = null; }
  live.texture?.dispose();
  Object.assign(live, { video: null, stream: null, texture: null, show: false });
  emit('live', { on: false });
}
export function setLive(patch) {
  const u = liveMat.uniforms;
  if ('show' in patch) live.show = !!patch.show && !!live.video;
  if ('mode' in patch) live.mode = patch.mode;
  if ('keyOn' in patch) u.keyOn.value = patch.keyOn ? 1 : 0;
  if ('keyColor' in patch) {   // '#rrggbb' as seen on the video (sRGB)
    const n = parseInt(patch.keyColor.slice(1), 16), c = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    u.keyCbCr.value.set(-0.1146 * c[0] - 0.3854 * c[1] + 0.5 * c[2], 0.5 * c[0] - 0.4542 * c[1] - 0.0458 * c[2]);
  }
  for (const k of ['similarity', 'smoothness', 'spill', 'opacity']) if (k in patch) u[k].value = patch[k];
}
/** Colour of the live picture at a point of the viewer (eyedropper for the key colour), as '#rrggbb'. */
export function sampleLive(clientX, clientY) {
  if (!live.video) return null;
  const r = canvas.getBoundingClientRect();
  const u = (clientX - r.left) / r.width, v = (clientY - r.top) / r.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const c = new OffscreenCanvas(1, 1), g = c.getContext('2d', { willReadFrequently: true });
  const vw = live.video.videoWidth, vh = live.video.videoHeight;
  // 5×5 average around the point, so one noisy pixel does not decide the key
  g.drawImage(live.video, Math.max(0, u * vw - 2), Math.max(0, v * vh - 2), 5, 5, 0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Closing or navigating away: release the camera explicitly (some browsers keep it a moment longer).
window.addEventListener('pagehide', () => stopLiveCamera());

// ---- sun (directional light with shadows) + ambient occlusion ----------------------------------
// Many downloaded sets carry only colour textures: Sketchfab's own viewer adds a sun, shadows and AO
// that do not travel with the file. These two bring that back. Both are off by default (sets with
// lighting baked into the textures, like most TV studios, look worse with extra light).
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
camera.layers.enable(1);                         // helpers (presenter card) live on layer 1
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.visible = false;
scene.add(sun, sun.target);
state.sun = { on: false, azimuth: 135, elevation: 40, intensity: 3, kelvin: 5600 };
state.ao = { on: false, strength: 1, radius: 0.6 };

/** Colour temperature (K) → RGB (Tanner Helland's fit), for a warm / cool sun. */
function kelvin(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.7 * (t - 60) ** -0.1332;
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -0.0755;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const c = (x) => Math.min(255, Math.max(0, x)) / 255;
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}
function sunDirection() {
  const az = THREE.MathUtils.degToRad(state.sun.azimuth), el = THREE.MathUtils.degToRad(state.sun.elevation);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}
function applySun() {
  const s = state.sun;
  if (state.env.background === 'sky') { buildSky(); applyEnv(); }   // the sky moves with the sun
  sun.visible = s.on;
  sun.intensity = s.intensity;
  sun.color.copy(kelvin(s.kelvin));
  if (!state.setRoot) return;
  // Shadow camera wraps the whole set; aim from azimuth (0 = from the front, +Z) and elevation.
  const box = new THREE.Box3().setFromObject(state.setRoot);
  const center = box.getCenter(new THREE.Vector3()), r = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
  const dir = sunDirection();
  sun.position.copy(center).addScaledVector(dir, r * 2);
  sun.target.position.copy(center);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -r; sc.right = sc.top = r; sc.near = 0.1; sc.far = r * 4;
  sc.updateProjectionMatrix();
  sun.shadow.needsUpdate = true;
}
export function setSun(patch) { Object.assign(state.sun, patch); applySun(); }

// AO = GTAO post-process. It sees the set through its own camera limited to layer 0, so the
// presenter card (layer 1) never darkens the set around it.
const aoCamera = new THREE.PerspectiveCamera();
function buildComposer() {
  composer?.dispose?.();
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const size = renderer.getSize(new THREE.Vector2());
  gtao = new GTAOPass(scene, aoCamera, size.x, size.y);
  gtao.output = GTAOPass.OUTPUT.Default;
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);
  applyAO();
}
function applyAO() {
  if (!gtao) return;
  gtao.blendIntensity = state.ao.strength;
  gtao.updateGtaoMaterial({ radius: state.ao.radius });
}
export function setAO(patch) {
  Object.assign(state.ao, patch);
  if (state.ao.on && !composer) buildComposer();
  applyAO();
}
/** Draw the scene to the canvas: plain, or through the AO composer when AO is on. */
function draw() {
  if (state.ao.on && composer) {
    aoCamera.copy(camera);
    aoCamera.layers.set(0);
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ---- procedural sky (no download needed): background + lighting, following the sun --------------
// Rendered once into a cube map (sharp background) and pre-filtered for lighting; rebuilt only when
// the sun or the clouds change.
export let SKY_GAIN = 0.05;
export function _setSkyGain(g) { SKY_GAIN = g; applyEnv(); }   // tuning hook
let sky = null, skyScene = null, skyCube = null, skyCam = null, skyEnv = null;
function buildSky() {
  if (!sky) {
    sky = new Sky();
    sky.scale.setScalar(1000);
    skyScene = new THREE.Scene();
    skyScene.add(sky);
    skyCube = new THREE.WebGLCubeRenderTarget(1024, { type: THREE.HalfFloatType });
    skyCam = new THREE.CubeCamera(1, 5000, skyCube);
  }
  const u = sky.material.uniforms;
  u.turbidity.value = 2.5; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
  u.cloudCoverage.value = state.env.clouds ?? 0.3;
  u.sunPosition.value.copy(sunDirection());
  skyCam.update(renderer, skyScene);
  skyEnv?.dispose();
  skyEnv = pmrem.fromCubemap(skyCube.texture).texture;
}
export function setClouds(v) { state.env.clouds = v; if (state.env.background === 'sky') { buildSky(); applyEnv(); } }

// ---- lights placed in the set (street lamps, practicals) ---------------------------------------
// Real-time lights: they light the geometry and its textures, can cast shadows, and a soft glow
// sprite makes the lamp itself look on. No bounce light (that is what baking in Blender is for).
// Lights that come INSIDE the glTF (KHR_lights_punctual) are listed too ("from the file").
const lightsGroup = new THREE.Group(); scene.add(lightsGroup);
export const glows = new THREE.Group(); scene.add(glows);
const handles = new THREE.Group(); helpers.add(handles);
state.lights = [];
let lightSeq = 0, selectedLightId = null;

const glowTex = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 }), g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.15, 'rgba(255,255,255,0.8)');
  r.addColorStop(0.4, 'rgba(255,255,255,0.18)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const candela = (strength) => (strength / 50) ** 2 * 200;  // 50 ≈ a street lamp lighting the pavement 4–5 m below

function newLightObject(type) {
  const l = type === 'spot' ? new THREE.SpotLight(0xffffff, 1, 0, 0.6, 0.5, 2) : new THREE.PointLight(0xffffff, 1, 0, 2);
  l.shadow.mapSize.set(1024, 1024);
  l.shadow.bias = -0.0005; l.shadow.normalBias = 0.02;
  return l;
}
function makeHandle() {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff5a4d, depthTest: false, transparent: true, opacity: 0.75 }));
  m.renderOrder = 10; m.layers.set(1);
  return m;
}
/** Place light, its target, glow, handle and cone helper from the entry's numbers. */
function placeEntry(e) {
  const L = e.light, pos = new THREE.Vector3().fromArray(e.pos);
  if (!e.fromFile) {
    L.position.copy(pos);
    L.color.copy(kelvin(e.kelvin));
    L.intensity = candela(e.strength);
    if (L.isSpotLight) {
      L.angle = THREE.MathUtils.degToRad(e.cone);
      L.penumbra = e.softness;
      const t = THREE.MathUtils.degToRad(e.tilt), y = THREE.MathUtils.degToRad(e.yaw);
      // tilt 0 = straight down; 90 = horizontal towards yaw
      L.target.position.copy(pos).add(new THREE.Vector3(Math.sin(t) * Math.sin(y), -Math.cos(t), Math.sin(t) * Math.cos(y)));
      L.target.updateMatrixWorld();
    }
  } else {
    L.intensity = e.baseIntensity * (e.strength / 50) ** 2;
    L.position.copy(L.parent ? L.parent.worldToLocal(pos.clone()) : pos);   // dragged: e.pos is in world space
  }
  L.castShadow = !!e.shadow;
  L.visible = e.on !== false;
  L.updateMatrixWorld();
  const wp = L.getWorldPosition(new THREE.Vector3());
  e.handle.position.copy(wp);
  // Glow: a halo that sits INSIDE the lamp (depth-tested), so only its rim shows around the
  // lamp's silhouette — the lamp looks on, without a floating ball. Size 0 = no glow.
  const gsz = e.glowSize ?? (e.glowOn ? 20 : 0);
  e.glow.visible = gsz > 0 && L.visible;
  e.glow.position.copy(wp);
  const gs = (0.04 + (gsz / 100) * 0.9) * (0.6 + e.strength / 125);
  e.glow.scale.set(gs, gs, 1);
  e.glow.material.color.copy(L.color);
  e.coneHelper?.update();
}
function wrapEntry(e) {
  e.handle = makeHandle();
  e.handle.userData.lightId = e.id;
  handles.add(e.handle);
  e.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
  e.glow.layers.set(1);
  glows.add(e.glow);
  if (e.light.isSpotLight) { e.coneHelper = new THREE.SpotLightHelper(e.light, 0xff5a4d); e.coneHelper.visible = false; helpers.add(e.coneHelper); }
  state.lights.push(e);
  placeEntry(e);
  return e;
}
/**
 * New light at a clicked point: a few cm INSIDE the surface clicked (the bulb is inside the lamp),
 * a spot aiming straight down. The mesh clicked stops casting shadows, so the lamp's own shell
 * does not block its light.
 */
export function addLight(point, normal, opts = {}, owner = null) {
  const p = new THREE.Vector3().copy(point).addScaledVector(normal ?? new THREE.Vector3(), -0.05);
  const e = { id: ++lightSeq, name: `Light ${lightSeq}`, type: opts.type || 'spot', pos: p.toArray(),
    kelvin: 2700, strength: 50, cone: 40, softness: 0.5, tilt: 0, yaw: 0, shadow: false, glowSize: 20, ...opts };
  if (owner?.isMesh) { e.owner = owner; e.ownerCast = owner.castShadow; owner.castShadow = false; }
  e.light = newLightObject(e.type);
  lightsGroup.add(e.light);
  if (e.light.isSpotLight) lightsGroup.add(e.light.target);
  wrapEntry(e);
  selectLight(e.id);
  emit('lights');
  return e;
}
export function updateLight(id, patch) {
  const e = state.lights.find((l) => l.id === id);
  if (!e) return;
  if (patch.type && patch.type !== e.type && !e.fromFile) {   // spot ↔ bulb: swap the light object
    const old = e.light;
    lightsGroup.remove(old); if (old.target) lightsGroup.remove(old.target); old.dispose();
    e.coneHelper && (helpers.remove(e.coneHelper), e.coneHelper.dispose(), e.coneHelper = null);
    e.light = newLightObject(patch.type);
    lightsGroup.add(e.light); if (e.light.isSpotLight) { lightsGroup.add(e.light.target); e.coneHelper = new THREE.SpotLightHelper(e.light, 0xff5a4d); helpers.add(e.coneHelper); }
  }
  Object.assign(e, patch);
  placeEntry(e);
  if (e.coneHelper) e.coneHelper.visible = e.id === selectedLightId;
  emit('lights');
}
export function removeLight(id) {
  const e = state.lights.find((l) => l.id === id);
  if (!e) return;
  if (e.fromFile) { updateLight(id, { on: false }); return; }   // lights of the file are switched off, not deleted
  if (transform.object === e.handle) transform.detach();
  if (e.owner) e.owner.castShadow = e.ownerCast;
  lightsGroup.remove(e.light); if (e.light.target) lightsGroup.remove(e.light.target); e.light.dispose();
  handles.remove(e.handle); e.handle.geometry.dispose();
  glows.remove(e.glow); e.glow.material.dispose();
  if (e.coneHelper) { helpers.remove(e.coneHelper); e.coneHelper.dispose(); }
  state.lights.splice(state.lights.indexOf(e), 1);
  if (selectedLightId === id) selectedLightId = null;
  emit('lights');
}
export function duplicateLight(id) {
  const e = state.lights.find((l) => l.id === id);
  if (!e || e.fromFile) return null;
  const { right } = camAxes();   // a copy 1.5 m to the right as seen from the camera, ready to drag
  const p = new THREE.Vector3().fromArray(e.pos).addScaledVector(right, 1.5);
  const { id: _i, name: _n, light: _l, handle: _h, glow: _g, coneHelper: _c, pos: _p, owner: _o, ownerCast: _oc, ...props } = e;
  return addLight(p, new THREE.Vector3(), props);
}
/** Select a light (null = none): highlight its dot, show its cone, and put the X/Y/Z arrows on it. */
export function selectLight(id) {
  if (id) select(null);                   // an object and a light are never selected together
  markLightSelected(id);
  const e = state.lights.find((l) => l.id === id);
  if (e) {
    transform.setMode('translate');
    transform.setSpace('world');
    transform.showX = transform.showY = transform.showZ = true;
    transform.attach(e.handle);
  }
  emit('lights');
}
function markLightSelected(id) {
  selectedLightId = id;
  if (!id && transform.object?.userData.lightId) transform.detach();
  for (const e of state.lights) {
    e.handle.material.color.set(e.id === id ? 0xffffff : 0xff5a4d);
    if (e.coneHelper) { e.coneHelper.visible = e.id === id; e.coneHelper.update(); }
  }
}
export const getSelectedLightId = () => selectedLightId;
function clearLights() {
  for (const e of [...state.lights]) {
    if (e.fromFile) { handles.remove(e.handle); glows.remove(e.glow); if (e.coneHelper) helpers.remove(e.coneHelper); state.lights.splice(state.lights.indexOf(e), 1); }
    else removeLight(e.id);
  }
  state.lights = []; selectedLightId = null;
  emit('lights');
}
function adoptFileLights(root) {
  root.traverse((o) => {
    if (!o.isLight) return;
    o.updateMatrixWorld();
    wrapEntry({ id: ++lightSeq, name: o.name || `File light ${lightSeq}`, fromFile: true, light: o, path: pathOf(o),
      type: o.isSpotLight ? 'spot' : 'point', pos: o.getWorldPosition(new THREE.Vector3()).toArray(),
      baseIntensity: o.intensity, strength: 50, shadow: false, glowOn: false, on: true });
  });
  emit('lights');
}
function lightsSnapshot() {
  return state.lights.map((e) => e.fromFile
    ? { fromFile: true, path: e.path, strength: e.strength, shadow: e.shadow, glowOn: e.glowOn, on: e.on }
    : { type: e.type, pos: e.pos, kelvin: e.kelvin, strength: e.strength, cone: e.cone, softness: e.softness,
        tilt: e.tilt, yaw: e.yaw, shadow: e.shadow, glowSize: e.glowSize, name: e.name, owner: e.owner ? pathOf(e.owner) : null });
}
function restoreLights(list) {
  for (const l of list) {
    if (l.fromFile) {
      const e = state.lights.find((x) => x.fromFile && x.path === l.path);
      if (e) updateLight(e.id, { strength: l.strength, shadow: l.shadow, glowOn: l.glowOn, on: l.on });
    } else {
      const { owner, ...props } = l;
      const e = addLight(new THREE.Vector3().fromArray(l.pos), new THREE.Vector3(), props, owner ? byPath(owner) : null);
      e.pos = l.pos; placeEntry(e);
    }
  }
  selectLight(null);
}
