// vMix Virtual Set export (vMix Virtual Set Specification 1.0).
//
// A vMix virtual set is just a FOLDER: config.xml + PNG layers, stacked bottom → top, max 10 inputs.
// A "dynamic" input carries a UV MAP: a 16-bit RGBA PNG (gAMA 1/2.2) where, per output pixel,
//   R = u · 65536   G = v · 65536   (linear, v top-down, u/v in the live input's frame)   B = 0
//   A = coverage (0 = this layer does not draw here)
// Reverse-engineered from vMix's own sample (uvmapsample.zip: R = floor(x/W·65536), G = floor(y/H·65536)).
//
// We render each map from the SAME camera as the background: the set is drawn depth-only first, then
// the target surface writes its normalised UVs with depth test ≤ — so anything in front of a screen or
// of the presenter (a desk, a column) cuts the map exactly like it cuts the picture.
import * as THREE from 'three';
import { zlibSync, zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { renderer, scene, camera, helpers, state, meshByUuid, layout, renderPNG, renderForegroundPNG,
  UV_GLSL, uvUniforms, setUvUniforms } from './viewer.js';

// ---- PNG writer (16-bit RGBA, Sub filter) -------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** rgba16: Uint16Array(w*h*4), rows top → bottom. Returns PNG bytes. */
export function encodePNG16(rgba16, w, h) {
  const stride = w * 8;
  const raw = new Uint8Array(h * (stride + 1));
  const row = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = y * w * 4; x < w * 4; x++, i++) { row[x * 2] = rgba16[i] >>> 8; row[x * 2 + 1] = rgba16[i] & 0xff; }
    const o = y * (stride + 1);
    raw[o] = 1;                                   // filter: Sub (smooth UV ramps compress very well)
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (row[x] - (x >= 8 ? row[x - 8] : 0)) & 0xff;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr.set([16, 6, 0, 0, 0], 8);                  // 16-bit, RGBA
  const gama = new Uint8Array(4);
  new DataView(gama.buffer).setUint32(0, 45455);  // gAMA 1/2.2, as in vMix's sample
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('gAMA', gama),
    chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- UV pass --------------------------------------------------------------------------------
const uvMaterial = new THREE.ShaderMaterial({
  uniforms: uvUniforms(),
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: UV_GLSL + 'varying vec2 vUv; void main(){ gl_FragColor = vec4(sfUV(vUv), 0.0, 1.0); }',
  side: THREE.DoubleSide,
  depthFunc: THREE.LessEqualDepth,
  // Screens usually sit a millimetre in front of their bezel: pull the target towards the camera a
  // touch so it never z-fights with what it is mounted on.
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  toneMapped: false,
});
const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

/**
 * Render the UV map of `target` (a mesh, or the talent card) as seen by the export camera.
 * ss = supersampling per axis: edges get fractional coverage instead of stair-steps.
 */
function renderUVMap(target, opts, w, h, ss) {
  const W = w * ss, H = h * ss;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
  const saved = { bg: scene.background, helpers: helpers.visible, clear: renderer.getClearColor(new THREE.Color()),
    clearA: renderer.getClearAlpha(), autoClear: renderer.autoClear };
  const swapped = [];
  try {
    scene.background = null;
    helpers.visible = false;
    // 1) the whole set, depth only. Glass / see-through materials don't occlude.
    state.setRoot.traverse((o) => {
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const seeThrough = m && ((m.transparent && m.opacity < 0.5) || m.transmission > 0);
      swapped.push([o, o.material, o.visible]);
      if (o === target || seeThrough) o.visible = false;   // the target itself is drawn in step 2
      else o.material = depthOnly;
    });
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    // 2) the target alone, writing its normalised UVs where it passes the depth test.
    setUvUniforms(uvMaterial.uniforms, target, opts);
    const prevMat = target.material, prevVis = target.visible, kids = target.children.map((c) => [c, c.visible]);
    target.material = uvMaterial;
    target.visible = true;
    target.children.forEach((c) => { c.visible = false; });
    renderer.autoClear = false;
    target.updateMatrixWorld(true);
    renderer.render(target, camera);
    target.material = prevMat;
    target.visible = prevVis;
    kids.forEach(([c, v]) => { c.visible = v; });

    const px = new Float32Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
    return downsample(px, w, h, ss);
  } finally {
    for (const [o, mat, vis] of swapped) { o.material = mat; o.visible = vis; }
    renderer.setRenderTarget(null);
    renderer.setClearColor(saved.clear, saved.clearA);
    renderer.autoClear = saved.autoClear;
    scene.background = saved.bg;
    helpers.visible = saved.helpers;
    rt.dispose();
  }
}

/** Float RGBA (bottom-up, ss×ss supersampled) → Uint16 RGBA (top-down) in vMix's encoding. */
function downsample(px, w, h, ss) {
  const W = w * ss, out = new Uint16Array(w * h * 4), n = ss * ss;
  let covered = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = 0, su = 0, sv = 0;
      for (let j = 0; j < ss; j++) {
        const srcRow = (h - 1 - y) * ss + (ss - 1 - j);   // flip vertically
        for (let i = 0; i < ss; i++) {
          const k = (srcRow * W + x * ss + i) * 4;
          if (px[k + 3] > 0.5) { c++; su += px[k]; sv += px[k + 1]; }
        }
      }
      if (!c) continue;
      covered++;
      const o = (y * w + x) * 4;
      out[o] = Math.min(65535, Math.floor((su / c) * 65536));
      out[o + 1] = Math.min(65535, Math.floor((sv / c) * 65536));
      out[o + 3] = Math.round((c / n) * 65535);
    }
  }
  return { data: out, covered };
}

// ---- the set ----------------------------------------------------------------------------------
const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const inputXml = (name, file, uvmap) =>
  `  <input name="${xmlEsc(name)}" x="0" y="0" zoomX="1" zoomY="1" rotateX="0" rotateY="0" rotateZ="0" cropping="0,0,1,1" ` +
  `dynamic="${uvmap ? 'true' : 'false'}"${uvmap ? ` uvmap="${xmlEsc(uvmap)}"` : ''}>${xmlEsc(file)}</input>`;

async function blankPNG(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;               // fully transparent
  return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
}

/**
 * Build every file of the virtual set. Returns { files: {name: Uint8Array}, layers, warnings }.
 * opts: { w, h, zooms: [{name, zoom, x, y}], meta }
 */
export async function buildVirtualSet(opts, onProgress = () => {}) {
  const { w, h } = opts;
  const ss = w * h <= 1920 * 1080 ? 2 : 1;     // 4K float readback ×4 would be ~0.5 GB; 1× is plenty there
  const files = {}, layers = [], warnings = [];

  onProgress('Background');
  files['Background.png'] = new Uint8Array(await (await renderPNG(w, h)).arrayBuffer());
  layers.push(inputXml('Background', 'Background.png'));
  // Props marked "in front of the presenter", with alpha. NOT a layer of config.xml (vMix already
  // hides the presenter behind them via the Talent UV map); it is for keying the background
  // elsewhere — ATEM / Ultimatte foreground (fill + key).
  const fg = await renderForegroundPNG(w, h);
  if (fg) { onProgress('Foreground'); files['Foreground.png'] = new Uint8Array(await fg.arrayBuffer()); }
  files['blank.png'] = await blankPNG(w, h);

  // keep the export camera's aspect for the UV passes
  camera.aspect = w / h; camera.zoom = 1; camera.updateProjectionMatrix();   // full frame, never the shot preview
  try {
    const screens = [...state.roles.entries()].sort((a, b) => a[1].role.localeCompare(b[1].role));
    for (const [uuid, r] of screens) {
      const mesh = meshByUuid(uuid);
      if (!mesh) continue;
      const name = `Screen ${r.role}`, file = `Screen${r.role}_uv.png`;
      onProgress(name);
      const map = renderUVMap(mesh, r, w, h, ss);
      if (!map.covered) warnings.push(`${name} (${r.name}) is not visible from this camera — skipped`);
      else { files[file] = encodePNG16(map.data, w, h); layers.push(inputXml(name, 'blank.png', file)); }
      await new Promise((res) => setTimeout(res));   // let the UI breathe between passes
    }
    if (state.talent) {
      onProgress('Talent');
      // PlaneGeometry UVs are v-up → flipV for vMix's v-down.
      const map = renderUVMap(state.talent.mesh, { flipV: true }, w, h, ss);
      if (!map.covered) warnings.push('Talent card is not visible from this camera — skipped');
      else { files['Talent_uv.png'] = encodePNG16(map.data, w, h); layers.push(inputXml('Talent', 'blank.png', 'Talent_uv.png')); }
    }
  } finally {
    layout();
  }
  if (layers.length > 10) {
    warnings.push(`vMix allows 10 inputs per set; ${layers.length - 10} layer(s) dropped`);
    layers.length = 10;
  }
  const zooms = (opts.zooms || []).map((z) =>
    `  <zoom name="${xmlEsc(z.name)}" x="${+z.x || 0}" y="${+z.y || 0}" zoom="${+z.zoom || 1}" />`);
  files['config.xml'] = strToU8(`<virtualSet>\n${layers.join('\n')}\n${zooms.join('\n')}\n</virtualSet>\n`);
  files['setframer.json'] = strToU8(JSON.stringify({ app: 'SetFrameR', created: new Date().toISOString(), w, h, ...opts.meta }, null, 2));
  return { files, layers: layers.length, warnings };
}

/** Zip the set inside a folder named after it (PNGs are stored, they're already compressed). */
export function zipSet(name, files) {
  const tree = {};
  for (const [f, data] of Object.entries(files)) tree[`${name}/${f}`] = [data, { level: f.endsWith('.png') ? 0 : 6 }];
  return zipSync(tree);
}

/** Write the set straight into a folder the user picked (File System Access API — Chrome/Edge). */
export async function writeSetToDirectory(dirHandle, name, files) {
  const sub = await dirHandle.getDirectoryHandle(name, { create: true });
  for (const [f, data] of Object.entries(files)) {
    const fh = await sub.getFileHandle(f, { create: true });
    const wr = await fh.createWritable();
    await wr.write(data);
    await wr.close();
  }
}
