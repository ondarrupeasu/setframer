// SetFrameR — UI glue: side panel ↔ viewer, files in, vMix set out.
import * as V from './viewer.js';
import { buildDemoStudio } from './demo.js';
import { buildVirtualSet, zipSet, writeSetToDirectory } from './vmixset.js';
import * as P from './project.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('setframer.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('setframer.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const fmt = (n, d = 2) => (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);

// ---- number fields & sliders: ▲▼ steppers + wheel / two-finger scroll (up = more), Shift = finer ---
const decimalsOf = (x) => { const t = String(x); return t.includes('e-') ? +t.split('e-')[1] : (t.split('.')[1] || '').length; };
function nudge(el, dir, fine) {
  const min = el.min === '' ? -Infinity : +el.min, max = el.max === '' ? Infinity : +el.max;
  let step;
  if (el.type === 'range') {   // sliders: 1 % of their travel per notch, 0.2 % with Shift
    step = Math.max(+el.step || 1, (max - min) / (fine ? 500 : 100));
  } else {                     // numbers: their own step, a tenth with Shift
    step = (+el.step || 1) / (fine ? 10 : 1);
  }
  const d = Math.max(decimalsOf(el.step || 1) + (fine ? 1 : 0), 0);
  const v = Math.min(max, Math.max(min, (+el.value || 0) + dir * step));
  el.value = el.type === 'range' ? v : String(+v.toFixed(d));   // +… drops trailing zeros (2.50 → 2.5, 300 stays 300)
  el.dispatchEvent(new Event(el.type === 'range' ? 'input' : 'change', { bubbles: true }));
}
// Wheel: trackpads send many small deltas, a mouse ~100 px per click → one step every 80 px.
const wheelAcc = new WeakMap();
function onWheelNudge(el) {
  return (e) => {
    e.preventDefault();
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;   // macOS: Shift+wheel = horizontal
    const px = e.deltaMode === 1 ? delta * 80 : delta;
    let acc = (wheelAcc.get(el) || 0) - px;          // wheel up (negative delta) = more
    const notches = Math.trunc(acc / 80);
    acc -= notches * 80; wheelAcc.set(el, acc);
    for (let i = 0; i < Math.abs(notches); i++) nudge(el, Math.sign(notches), e.shiftKey);
  };
}
const CHEV_UP = '<svg viewBox="0 0 10 10"><path d="M2 6.5 5 3.5 8 6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEV_DN = '<svg viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function enhanceNumbers(root = document) {
  for (const input of root.querySelectorAll('input.ce-inp.num:not([data-enh])')) {
    input.dataset.enh = '1';
    const wrap = document.createElement('span'); wrap.className = 'num-wrap';
    const unit = input.nextElementSibling?.classList.contains('unit') ? input.nextElementSibling : null;
    input.replaceWith(wrap);
    wrap.append(input);
    if (unit) wrap.append(unit);
    const steps = document.createElement('span'); steps.className = 'steps';
    steps.innerHTML = `<button type="button" tabindex="-1" title="More (Shift = finer)">${CHEV_UP}</button><button type="button" tabindex="-1" title="Less (Shift = finer)">${CHEV_DN}</button>`;
    const [up, dn] = steps.querySelectorAll('button');
    // press and hold repeats, like a native spinner
    const hold = (btn, dir) => btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      nudge(input, dir, e.shiftKey);
      let t = setTimeout(function rep() { nudge(input, dir, e.shiftKey); t = setTimeout(rep, 60); }, 400);
      const stop = () => { clearTimeout(t); window.removeEventListener('pointerup', stop); };
      window.addEventListener('pointerup', stop);
    });
    hold(up, 1); hold(dn, -1);
    wrap.append(steps);
    wrap.addEventListener('wheel', onWheelNudge(input), { passive: false });
  }
  for (const range of root.querySelectorAll('.ce-slider input[type=range]:not([data-enh])')) {
    range.dataset.enh = '1';
    range.addEventListener('wheel', onWheelNudge(range), { passive: false });
  }
}

// ---- busy / messages --------------------------------------------------------------------------
V.events.addEventListener('busy', (e) => { $('busy').hidden = !e.detail.msg; $('busy').textContent = e.detail.msg; });
function fail(what, err) {
  console.error(err);
  alert(`${what}: ${err?.message || err?.name || (err == null ? 'the browser gave no reason' : err)}`);
}

// ---- opening files ----------------------------------------------------------------------------
async function openSet(files) {
  try {
    const hdr = files.find((f) => /\.(hdr|exr)$/i.test(f.name));
    if (hdr) await V.loadHDRIFile(hdr);
    if (files.some((f) => /\.(glb|gltf)$/i.test(f.name))) await V.loadSetFiles(files);
  } catch (err) { fail('Could not open the set', err); }
}
$('btnOpenSet').onclick = () => $('fileSet').click();
$('btnOpenFolder').onclick = () => $('fileFolder').click();
$('btnOpenHdri').onclick = () => $('fileHdri').click();
$('fileSet').onchange = (e) => { openSet([...e.target.files]); e.target.value = ''; };
$('fileFolder').onchange = (e) => { openSet([...e.target.files]); e.target.value = ''; };
$('fileHdri').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) try { await V.loadHDRIFile(f); } catch (err) { fail('Could not open the HDRI', err); }
};
function loadDemo() { V.useSet(buildDemoStudio(), 'Demo studio'); V.state.source = { kind: 'demo' }; }
$('btnDemo').onclick = loadDemo;

// Drag & drop: files or whole folders (walks directory entries).
async function entryFiles(entry, path = '') {
  if (entry.isFile) return [await new Promise((res, rej) => entry.file((f) => { f.relPath = path + f.name; res(f); }, rej))];
  const reader = entry.createReader(), out = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) out.push(...await entryFiles(e, path + entry.name + '/'));
  }
  return out;
}
const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
stage.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = entries.length ? (await Promise.all(entries.map((en) => entryFiles(en)))).flat() : [...e.dataTransfer.files];
  openSet(files);
});

V.events.addEventListener('setLoaded', (e) => {
  const d = e.detail;
  const unitName = { 0.01: 'centimetres', 0.001: 'millimetres', 0.0254: 'inches', 0.3048: 'feet' }[d.units];
  $('setInfo').textContent = `${d.name} · ${d.meshes} meshes · ${(d.tris / 1000).toFixed(0)}k tris · ${fmt(d.size, 1)} m across` +
    (unitName ? ` · modelled in ${unitName}` : '');
  $('units').value = String(d.units ?? 1);
  $('segSide').querySelectorAll('button').forEach((b) => b.classList.toggle('ce-on', b.dataset.v === '0'));
  if (!$('setName').dataset.touched) $('setName').value = d.name.replace(/[^\w\- ]+/g, '').trim() || 'SetFrameR';
  applyLens();
});
V.events.addEventListener('hdriLoaded', (e) => {
  $('hdriInfo').textContent = `${e.detail.name} · ${e.detail.w}×${e.detail.h}`;
  $('btnClearHdri').hidden = false;
});
$('btnClearHdri').onclick = () => {
  V.clearHDRI(); $('btnClearHdri').hidden = true;
  $('hdriInfo').textContent = 'Built-in neutral studio light. Load an HDRI (.hdr/.exr, free at polyhaven.com) to light the set with a real place.';
};

// ---- set panel --------------------------------------------------------------------------------
seg('segSide', (v) => V.frameAll(+v));
$('layersAdv').ontoggle = () => document.body.classList.toggle('uvfix', $('layersAdv').open);
$('units').onchange = (e) => V.setUnits(+e.target.value);
function toggle(id, key, fn) {
  const el = $(id), on = store.get(key, false);
  el.classList.toggle('ce-on', on); fn(on);
  el.parentElement.onclick = (e) => {
    e.preventDefault();
    const v = !el.classList.contains('ce-on'); el.classList.toggle('ce-on', v); store.set(key, v); fn(v);
  };
}
toggle('swGrid', 'grid', V.setGrid);
toggle('swGuides', 'guides', (on) => document.body.classList.toggle('guides', on));

// ---- lighting ---------------------------------------------------------------------------------
function seg(id, fn) {
  const el = $(id);
  el.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('ce-on', x === b)); fn(b.dataset.v);
  };
}
function slider(id, fn, show) {
  const el = $(id), out = $(id + 'V');
  const upd = () => {
    const v = +el.value;
    el.style.setProperty('--p', `${(100 * (v - el.min)) / (el.max - el.min)}%`);
    if (out) out.textContent = show(v);
    fn(v);
  };
  el.oninput = upd; upd();
}
seg('segBg', (v) => V.setEnv({ background: v }));
$('bgColor').oninput = (e) => {
  V.setEnv({ color: e.target.value, background: 'color' });
  $('segBg').querySelectorAll('button').forEach((b) => b.classList.toggle('ce-on', b.dataset.v === 'color'));
};
slider('envRot', (v) => V.setEnv({ rotation: v }), (v) => `${v}°`);
slider('envInt', (v) => V.setEnv({ intensity: v / 100 }), (v) => fmt(v / 100));
slider('envBlur', (v) => V.setEnv({ blur: v / 100 }), (v) => fmt(v / 100));
slider('exposure', (v) => V.setExposure(2 ** (v / 100)), (v) => `${v >= 0 ? '+' : ''}${fmt(v / 100, 1)} EV`);
seg('segTone', V.setToneMapping);

// ---- camera / lens ----------------------------------------------------------------------------
const SENSORS = [   // horizontal width in mm (16:9 recording area where it matters)
  ['Super 35 (24.9 mm)', 24.89], ['Full frame (36 mm)', 36], ['APS-C Canon (22.3 mm)', 22.3],
  ['APS-C Sony/Nikon (23.5 mm)', 23.5], ['Micro Four Thirds (17.3 mm)', 17.3], ['1" (13.2 mm)', 13.2],
  ['2/3" broadcast (9.6 mm)', 9.59], ['1/2.5" PTZ (5.8 mm)', 5.76], ['1/2.8" PTZ (5.1 mm)', 5.12],
];
const sensorSel = $('sensor');
SENSORS.forEach(([n, w]) => sensorSel.add(new Option(n, w)));
sensorSel.value = store.get('sensor', 24.89);
let lensRange = null;   // [min,max] when a zoom lens is chosen

function applyLens() {
  let f = +$('focalN').value || 35;
  if (lensRange) f = Math.min(lensRange[1], Math.max(lensRange[0], f));
  $('focalN').value = f; $('focal').value = f;
  $('focal').style.setProperty('--p', `${(100 * (f - $('focal').min)) / ($('focal').max - $('focal').min)}%`);
  V.setLens(f, +sensorSel.value);
  store.set('focal', f);
}
sensorSel.onchange = () => { store.set('sensor', +sensorSel.value); applyLens(); };
$('focal').oninput = (e) => { $('focalN').value = e.target.value; applyLens(); };
$('focalN').onchange = applyLens;
$('focalN').value = store.get('focal', 35);

// Lens catalogue shared with ClapperQR (lenses.json): one entry per prime, one per zoom range.
const lensIndex = new Map();
fetch('lenses.json').then((r) => r.json()).then((cat) => {
  const dl = $('lensList');
  for (const l of cat.lenses) {
    const base = `${l.brand} ${l.model}${l.type === 'ana' ? ` (${l.squeeze || 2}× ana)` : ''}`;
    for (const p of l.primes || []) lensIndex.set(`${base} ${p}mm`, { f: p });
    for (const [a, b] of l.zooms || []) lensIndex.set(`${base} ${a}-${b}mm`, { range: [a, b] });
  }
  for (const k of lensIndex.keys()) dl.appendChild(new Option(k));
}).catch((err) => console.warn('lens catalogue unavailable', err));
$('lens').onchange = (e) => {
  const l = lensIndex.get(e.target.value);
  if (!l) return;
  lensRange = l.range || null;
  $('focalN').value = l.f ?? l.range[0];
  applyLens();
};

const camFields = { camH: 'height', camTilt: 'tilt', camPan: 'pan' };
V.events.addEventListener('camera', (e) => {
  const c = e.detail;
  for (const [id, k] of Object.entries(camFields)) if (document.activeElement !== $(id)) $(id).value = fmt(c[k], k === 'height' ? 2 : 1);
  $('hud').textContent = `${fmt(c.focal, 1)} mm on ${fmt(c.sensor, 1)} mm · HFOV ${fmt(c.fovH, 1)}° · cam ${fmt(c.height)} m · tilt ${fmt(c.tilt, 1)}°`;
});
$('camH').onchange = (e) => V.setHeight(+e.target.value);
$('camTilt').onchange = (e) => V.setTilt(+e.target.value);
$('camPan').onchange = (e) => V.setPan(+e.target.value);
applyLens();

// ---- vMix layers ------------------------------------------------------------------------------
const LETTERS = ['A', 'B', 'C', 'D'];
function setPick(mode, msg) {
  V.setPickMode(mode);
  $('pickHint').hidden = !mode; $('pickHint').textContent = msg || '';
  renderObjects();
}
$('btnPickScreen').onclick = () => setPick('screen', 'Click a screen surface in the set · Esc to cancel');
$('btnPickTalent').onclick = () => setPick('talent', 'Click the floor where the presenter stands · Esc to cancel');
window.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === 'Escape') { setPick(null); V.select(null); setShot(-1); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && V.getSelected()) { e.preventDefault(); V.hideSelected(); }
});

V.events.addEventListener('pick', (e) => {
  const { mode, mesh, point } = e.detail;
  if (mode === 'object') { V.select(V.objectOf(mesh)); return; }   // stays in select mode
  if (mode === 'screen') {
    const used = new Set([...V.state.roles.values()].map((r) => r.role));
    const free = LETTERS.find((l) => !used.has(l));
    if (V.state.roles.has(mesh.uuid)) { /* already tagged: keep */ }
    else if (!free) alert('Up to 4 screens (vMix allows 10 layers per set in total).');
    else V.setRole(mesh, free);
  } else if (mode === 'talent') {
    V.placeTalent(point, +$('talentH').value / 100);
  }
  setPick(null);
});

// ---- objects (props) --------------------------------------------------------------------------
$('btnPickObject').onclick = () => {
  if (V.pickMode === 'object') { setPick(null); V.select(null); }
  else setPick('object', 'Click a prop to select it · Esc when done');
};
$('btnObjHide').onclick = () => V.hideSelected();
$('btnObjMove').onclick = () => V.setTransformMode(V.transformMode() === 'translate' ? null : 'translate');
$('btnObjRotate').onclick = () => V.setTransformMode(V.transformMode() === 'rotate' ? null : 'rotate');
$('btnObjReset').onclick = () => V.resetSelected();
$('btnObjParent').onclick = () => V.selectParent();
$('btnObjFront').onclick = () => V.toggleForeground();
function renderObjects() {
  const sel = V.getSelected(), mode = V.transformMode();
  $('btnPickObject').classList.toggle('ce-on', V.pickMode === 'object');
  $('btnPickObject').textContent = V.pickMode === 'object' ? 'Done selecting' : 'Select object';
  $('objSel').hidden = !sel;
  if (sel) $('objName').textContent = sel.name || 'object';
  $('btnObjMove').classList.toggle('ce-on', mode === 'translate');
  $('btnObjRotate').classList.toggle('ce-on', mode === 'rotate');
  $('btnObjFront').classList.toggle('ce-on', V.isForeground(sel));
  const front = $('frontList'); front.textContent = '';
  for (const o of V.foregroundObjects()) {
    const row = document.createElement('div'); row.className = 'role';
    row.innerHTML = `<span class="tag">Front</span><span class="nm"></span><span class="ops"><button title="Not in front any more">✕</button></span>`;
    row.querySelector('.nm').textContent = o.name || 'object';
    row.querySelector('button').onclick = () => V.unsetForeground(o.uuid);
    front.appendChild(row);
  }
  $('btnExportFg').hidden = !V.foregroundObjects().length;
  const list = $('hiddenList'); list.textContent = '';
  for (const o of V.hiddenObjects()) {
    const row = document.createElement('div'); row.className = 'role';
    row.innerHTML = `<span class="tag">Hidden</span><span class="nm"></span><span class="ops"><button title="Show again">Show</button></span>`;
    row.querySelector('.nm').textContent = o.name || 'object';
    row.querySelector('button').onclick = () => V.showObject(o.uuid);
    list.appendChild(row);
  }
}
V.events.addEventListener('objects', renderObjects);

function renderRoles() {
  const list = $('roleList'); list.textContent = '';
  for (const [uuid, r] of V.state.roles) {
    const row = document.createElement('div'); row.className = 'role';
    const col = '#' + (V.ROLE_COLORS[r.role] ?? 0xffffff).toString(16).padStart(6, '0');
    row.innerHTML = `<span class="tag" style="background:${col}">Screen ${r.role}</span><span class="nm" title="${r.name}">${r.name}</span>
      <span class="ops"><button data-op="rot" title="Rotate 90°">⟳ ${r.rot * 90}°</button>
      <button data-op="flipU" title="Mirror horizontally" class="${r.flipU ? 'ce-on' : ''}">⇋</button>
      <button data-op="flipV" title="Mirror vertically" class="${r.flipV ? 'ce-on' : ''}">⇵</button>
      <button data-op="del" title="Remove">✕</button></span>`;
    row.querySelector('.ops').onclick = (e) => {
      const op = e.target.closest('button')?.dataset.op; if (!op) return;
      if (op === 'del') V.setRole(V.meshByUuid(uuid), null);
      else if (op === 'rot') V.updateRole(uuid, { rot: (r.rot + 1) % 4 });
      else V.updateRole(uuid, { [op]: !r[op] });
    };
    list.appendChild(row);
  }
  if (V.state.talent) {
    const row = document.createElement('div'); row.className = 'role';
    row.innerHTML = `<span class="tag" style="background:#ff5a4d">Talent</span><span class="nm">presenter card</span>
      <span class="ops"><button data-op="del" title="Remove">✕</button></span>`;
    row.querySelector('.ops').onclick = () => {
      V.removeTalent();
      // the camera was shown ON the presenter: with no presenter it shows nowhere → switch it off
      // (and the camera's light with it). In Full frame mode it keeps running.
      if (V.live.video && segValue('segLiveMode') === 'card') V.stopLiveCamera();
    };
    list.appendChild(row);
  }
  $('talentRow').hidden = !V.state.talent;
}
V.events.addEventListener('roles', renderRoles);
V.events.addEventListener('talent', () => { renderRoles(); showTalentPos(); });
V.events.addEventListener('camera', showTalentPos);
function showTalentPos() {
  const t = V.talentInfo();
  if (!t) return;
  if (document.activeElement !== $('talDist')) $('talDist').value = fmt(t.dist, 2);
  if (document.activeElement !== $('talSide')) $('talSide').value = fmt(t.side, 2);
  if (document.activeElement !== $('talRaise')) $('talRaise').value = fmt(t.raise, 2);
  // just show it (no input event: that would set it again and loop)
  const tt = $('talTurn'); tt.value = Math.round(t.turn);
  tt.style.setProperty('--p', `${(100 * (tt.value - tt.min)) / (tt.max - tt.min)}%`);
  $('talTurnV').textContent = `${Math.round(t.turn)}°`;
}
const moveTalent = () => V.setTalentRelative(Math.max(0.3, +$('talDist').value || 3), +$('talSide').value || 0);
$('talDist').onchange = moveTalent;
$('talSide').onchange = moveTalent;
$('talRaise').onchange = () => V.setTalentRaise(+$('talRaise').value || 0);
slider('talTurn', (v) => V.setTalentTurn(v), (v) => `${v}°`);
$('talTurn').ondblclick = () => V.setTalentTurn(0);
$('btnTalCenter').onclick = () => { V.centerTalent(); V.setTalentRaise(0); };
$('btnCenterTalent').onclick = () => { if (!V.state.setRoot) return fail('Presenter', new Error('Load a set first')); V.centerTalent(); };
slider('talentH', (v) => V.setTalentHeight(v / 100), (v) => `${fmt(v / 100)} m`);

// ---- shots (vMix <zoom>) ------------------------------------------------------------------------
let zooms = store.get('zooms', [{ name: 'Full', zoom: 1 }, { name: 'Medium Shot', zoom: 1.6 }, { name: 'Close Up', zoom: 2.5 }]);
function renderZooms() {
  const list = $('zoomList'); list.textContent = '';
  const rects = $('zoomRects'); rects.textContent = '';
  zooms.forEach((z, i) => {
    const row = document.createElement('div'); row.className = 'zoom';
    row.innerHTML = `<input class="ce-inp" value="${z.name.replace(/"/g, '&quot;')}"><input class="ce-inp num" type="number" min="1" max="8" step="0.1" value="${z.zoom}"><button class="view${i === shot ? ' ce-on' : ''}" title="See this shot in the viewer">View</button><button class="del" title="Remove">✕</button>`;
    const [nm, zz] = row.querySelectorAll('input');
    nm.onchange = () => { z.name = nm.value || `Shot ${i + 1}`; save(); };
    zz.onchange = () => { z.zoom = Math.max(1, +zz.value || 1); save(); };
    row.querySelector('.view').onclick = () => setShot(i === shot ? -1 : i);
    row.querySelector('.del').onclick = () => { if (i === shot) setShot(-1); zooms.splice(i, 1); save(); };
    list.appendChild(row);
    if (z.zoom > 1) {   // centred crop preview in the viewport
      const r = document.createElement('div'), s = 100 / z.zoom;
      Object.assign(r.style, { width: s + '%', height: s + '%', left: (100 - s) / 2 + '%', top: (100 - s) / 2 + '%' });
      r.innerHTML = `<span>${z.name}</span>`;
      rects.appendChild(r);
    }
  });
  enhanceNumbers(list);
  function save() { store.set('zooms', zooms); renderZooms(); if (shot >= 0) setShot(shot); }
}
// Shot preview: the viewer shows what that vMix zoom will show (a centred zoom of the camera, sharp).
let shot = -1;
function setShot(i) {
  shot = i >= 0 && i < zooms.length ? i : -1;
  const z = shot >= 0 ? zooms[shot] : null;
  V.setPreviewZoom(z ? z.zoom : 1);
  document.body.classList.toggle('shotpreview', !!z);
  $('shotBar').hidden = !z;
  if (z) $('shotText').textContent = `Shot “${z.name}” · ${z.zoom}× — exports always contain the full frame`;
  document.querySelectorAll('#zoomList .view').forEach((b, k) => b.classList.toggle('ce-on', k === shot));
}
$('btnShotExit').onclick = () => setShot(-1);
$('btnAddZoom').onclick = () => { zooms.push({ name: `Shot ${zooms.length + 1}`, zoom: 2 }); store.set('zooms', zooms); renderZooms(); };
renderZooms();
enhanceNumbers();

// ---- export -----------------------------------------------------------------------------------
$('res').value = store.get('res', '1920x1080');
$('res').onchange = () => store.set('res', $('res').value);
$('setName').oninput = () => { $('setName').dataset.touched = '1'; };
const outName = () => ($('setName').value.replace(/[^\w\- ]+/g, '').trim() || 'SetFrameR');
const outSize = () => $('res').value.split('x').map(Number);

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function build() {
  if (!V.state.setRoot) throw new Error('Load a set first');
  const [w, h] = outSize();
  const msg = $('exportMsg');
  const t0 = performance.now();
  const res = await buildVirtualSet({
    w, h, zooms: zooms.map((z) => ({ ...z, x: 0, y: 0 })),
    meta: { set: V.state.setName, view: V.getView(), camera: V.cameraInfo(), zooms,
      hiddenObjects: V.hiddenObjects().map((o) => o.name) },
  }, (step) => { msg.textContent = `Rendering ${step}…`; });
  msg.textContent = `${res.layers} layer(s), ${w}×${h}, ${((performance.now() - t0) / 1000).toFixed(1)} s` +
    (res.warnings.length ? ' — ⚠ ' + res.warnings.join(' · ') : '');
  return res;
}
$('btnExportZip').onclick = async () => {
  try {
    const { files } = await build();
    download(zipSet(outName(), files), `${outName()}.zip`, 'application/zip');
  } catch (err) { fail('Export failed', err); }
};
if (window.showDirectoryPicker) {
  $('btnExportDir').hidden = false;
  $('btnExportDir').onclick = async () => {
    try {
      const dir = await window.showDirectoryPicker({ id: 'setframer-out', mode: 'readwrite' });
      const { files } = await build();
      await writeSetToDirectory(dir, outName(), files);
      $('exportMsg').textContent += ` · saved to “${dir.name}/${outName()}”`;
    } catch (err) { if (err.name !== 'AbortError') fail('Export failed', err); }
  };
}
$('btnExportPng').onclick = async () => {
  try {
    if (!V.state.setRoot) throw new Error('Load a set first');
    const [w, h] = outSize();
    download(await V.renderPNG(w, h), `${outName()}.png`, 'image/png');
  } catch (err) { fail('Export failed', err); }
};

// ---- projects ---------------------------------------------------------------------------------
let currentId = null, restoring = false, lastAuto = '';
const segValue = (id) => $(id).querySelector('.ce-on')?.dataset.v;
const setSeg = (id, v) => $(id).querySelector(`[data-v="${v}"]`)?.click();
const setSlider = (id, v) => { if (v == null) return; $(id).value = v; $(id).oninput(); };

function collect() {
  return {
    version: 1, setName: V.state.setName, source: V.state.source?.kind || null, currentId,
    snap: V.state.setRoot ? V.snapshot() : null,
    ui: {
      tone: segValue('segTone'), bg: segValue('segBg'), bgColor: $('bgColor').value,
      envRot: +$('envRot').value, envInt: +$('envInt').value, envBlur: +$('envBlur').value, exposure: +$('exposure').value,
      sensor: +sensorSel.value, focal: +$('focalN').value, lens: $('lens').value, talentH: +$('talentH').value,
      zooms, exportName: $('setName').value, res: $('res').value,
      key: { color: $('keyColor').value, sim: +$('keySim').value, smooth: +$('keySmooth').value, spill: +$('keySpill').value },
    },
  };
}

async function applyProject(data, files) {
  restoring = true;
  setShot(-1); setPick(null); V.select(null);
  try {
    if (data.source === 'demo') loadDemo();
    else if (files?.set) await V.loadSetFiles(files.set);
    else throw new Error('This project has no set files');
    if (files?.hdri) await V.loadHDRIFile(files.hdri);
    else { V.clearHDRI(); $('btnClearHdri').onclick(); }
    const u = data.ui || {};
    setSeg('segTone', u.tone); setSeg('segBg', u.bg);
    if (u.bgColor) $('bgColor').value = u.bgColor;
    setSlider('envRot', u.envRot); setSlider('envInt', u.envInt); setSlider('envBlur', u.envBlur); setSlider('exposure', u.exposure);
    if (u.sensor) sensorSel.value = u.sensor;
    if (u.focal) $('focalN').value = u.focal;
    $('lens').value = u.lens || ''; lensRange = lensIndex.get(u.lens)?.range || null;
    applyLens();
    if (u.zooms) { zooms = u.zooms; store.set('zooms', zooms); renderZooms(); }
    if (u.exportName) { $('setName').value = u.exportName; $('setName').dataset.touched = '1'; }
    if (u.res) $('res').value = u.res;
    setSlider('talentH', u.talentH);
    if (u.key) {
      $('keyColor').value = u.key.color;
      setSlider('keySim', u.key.sim); setSlider('keySmooth', u.key.smooth); setSlider('keySpill', u.key.spill);
    }
    if (data.snap) V.restore(data.snap);
    lastAuto = JSON.stringify(collect());
  } finally { restoring = false; }
}

async function thumbnail() {
  const blob = await V.renderPNG(320, 180);
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}
const projMsg = (t) => { $('projMsg').textContent = t; };
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
};

async function saveCurrent(asNew) {
  try {
    if (!V.state.setRoot) throw new Error('Load a set first');
    if (asNew || !currentId) currentId = 'p' + Date.now().toString(36);
    const name = $('projName').value.trim() || V.state.setName || 'Untitled';
    $('projName').value = name;
    P.persistStorage();
    await P.saveProject({ id: currentId, name, data: collect(), thumb: await thumbnail(), source: V.state.source, hdriFile: V.state.hdriFile });
    projMsg(`Saved “${name}” · ${clock()}`);
    renderProjects();
  } catch (err) { fail('Could not save', err); }
}
$('btnSave').onclick = () => saveCurrent(false);
$('btnSaveAs').onclick = () => saveCurrent(true);
$('btnNew').onclick = async () => {
  if (!confirm('Start a new, empty project? Your saved projects stay in the list.')) return;
  await P.deleteProject(P.AUTOSAVE);
  location.reload();
};

async function openSaved(id) {
  try {
    const p = await P.loadProject(id);
    if (!p) throw new Error('Project not found');
    await applyProject(p.record.data, p.files);
    currentId = id === P.AUTOSAVE ? (p.record.data.currentId || null) : id;
    $('projName').value = p.record.name || '';
    projMsg(`Opened “${p.record.name}”`);
    renderProjects();
  } catch (err) { fail('Could not open the project', err); }
}

async function renderProjects() {
  const list = $('projList'); list.textContent = '';
  for (const p of await P.listProjects()) {
    const row = document.createElement('div'); row.className = 'proj' + (p.id === currentId ? ' current' : '');
    row.innerHTML = `${p.thumb ? '<img alt="">' : '<span class="noimg"></span>'}<span><div class="nm"></div><div class="dt"></div></span><button title="Delete this project">✕</button>`;
    if (p.thumb) row.querySelector('img').src = p.thumb;
    row.querySelector('.nm').textContent = p.name;
    row.querySelector('.dt').textContent = ago(p.updated);
    row.onclick = () => openSaved(p.id);
    row.querySelector('button').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete “${p.name}” from this browser?`)) return;
      await P.deleteProject(p.id);
      if (p.id === currentId) currentId = null;
      renderProjects();
    };
    list.appendChild(row);
  }
}

$('btnProjDownload').onclick = async () => {
  try {
    if (!V.state.setRoot) throw new Error('Load a set first');
    const name = $('projName').value.trim() || V.state.setName || 'Untitled';
    projMsg('Packing…');
    download(await P.packProject({ name, data: collect(), source: V.state.source, hdriFile: V.state.hdriFile }),
      `${name.replace(/[^\w\- ]+/g, '').trim() || 'project'}.setframer`, 'application/zip');
    projMsg(`Downloaded “${name}.setframer”`);
  } catch (err) { fail('Could not pack the project', err); }
};
$('btnProjOpen').onclick = () => $('fileProj').click();
$('fileProj').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const p = await P.unpackProject(f);
    await applyProject(p.data, p.files);
    currentId = null;
    $('projName').value = p.name || f.name.replace(/\.(setframer|zip)$/i, '');
    projMsg(`Opened “${f.name}” — Save to keep it in this browser`);
  } catch (err) { fail('Could not open the project file', err); }
};

// Autosave: every few seconds, only when something changed (the heavy files are written once).
setInterval(async () => {
  if (restoring || !V.state.setRoot) return;
  const data = collect(), js = JSON.stringify(data);
  if (js === lastAuto) return;
  lastAuto = js;
  try {
    await P.saveProject({ id: P.AUTOSAVE, name: $('projName').value.trim() || V.state.setName, data, source: V.state.source, hdriFile: V.state.hdriFile });
  } catch (err) { console.warn('autosave failed', err); }
}, 4000);

// On start: offer to bring the last session back.
(async () => {
  renderProjects();
  const last = await P.getProject(P.AUTOSAVE).catch(() => null);
  if (!last?.data?.snap) return;
  $('restoreText').textContent = `Last session: “${last.name}” · ${ago(last.updated)}`;
  $('restoreBar').hidden = false;
  $('btnRestore').onclick = async () => { $('restoreBar').hidden = true; await openSaved(P.AUTOSAVE); };
  $('btnRestoreNo').onclick = () => { $('restoreBar').hidden = true; };
  V.events.addEventListener('setLoaded', () => { if (!restoring) $('restoreBar').hidden = true; });
})();

$('btnExportFg').onclick = async () => {   // the ATEM / Ultimatte pair: background + foreground with alpha
  try {
    const [w, h] = outSize();
    const fg = await V.renderForegroundPNG(w, h);
    if (!fg) throw new Error('Mark some props as “In front of presenter” first');
    const bg = await V.renderPNG(w, h);
    const files = { 'Background.png': new Uint8Array(await bg.arrayBuffer()), 'Foreground.png': new Uint8Array(await fg.arrayBuffer()) };
    download(zipSet(`${outName()}_stills`, files), `${outName()}_stills.zip`, 'application/zip');
  } catch (err) { fail('Export failed', err); }
};

// ---- live: clean output + live camera ----------------------------------------------------------
$('btnOutput').onclick = () => {
  try { V.state.output ? V.closeOutput() : V.openOutput(); } catch (err) { fail('Could not open the output', err); }
};
V.events.addEventListener('output', (e) => {
  const open = e.detail.open;
  $('btnOutput').classList.toggle('ce-on', open);
  $('btnOutput').textContent = open ? 'Close clean output' : 'Open clean output';
});

async function listCameras(selectId) {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const sel = $('liveDevice'), keep = selectId ?? sel.value;
  sel.textContent = '';
  sel.add(new Option(devs.length ? 'Choose a camera / capture card…' : 'No camera found', ''));
  devs.forEach((d, i) => sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if (keep) sel.value = keep;
}
if (navigator.mediaDevices?.enumerateDevices) {
  listCameras();
  navigator.mediaDevices.addEventListener?.('devicechange', () => listCameras());
}
$('btnLive').onclick = async () => {
  if (V.live.video) { V.stopLiveCamera(); return; }
  try {
    await V.startLiveCamera($('liveDevice').value || undefined);
    if (!V.live.stream) return;                    // superseded by another click meanwhile
    const id = V.live.stream.getVideoTracks()[0].getSettings().deviceId;
    await listCameras(id);                         // labels only appear after permission
  } catch (err) { fail('Could not open the camera', err); }
};
$('liveDevice').onchange = async () => {   // switching source while connected
  if (!V.live.video || !$('liveDevice').value) return;
  try { await V.startLiveCamera($('liveDevice').value); } catch (err) { fail('Could not open the camera', err); }
};
V.events.addEventListener('live', (e) => {
  const on = e.detail.on;
  $('btnLive').textContent = on ? 'Disconnect' : 'Connect';
  $('liveCtl').hidden = !on; $('swLiveWrap').hidden = !on;
  $('swLive').classList.toggle('ce-on', on);
  if (on) {
    applyKeyUI();
    V.setLive({ mode: segValue('segLiveMode') });
    if (segValue('segLiveMode') === 'card' && !V.state.talent && V.state.setRoot) V.centerTalent();
  }
});
$('swLiveWrap').onclick = (e) => {
  e.preventDefault();
  const v = !$('swLive').classList.contains('ce-on');
  $('swLive').classList.toggle('ce-on', v); V.setLive({ show: v });
};
function applyKeyUI() {
  V.setLive({
    keyOn: segValue('segKey') === '1', keyColor: $('keyColor').value,
    similarity: +$('keySim').value / 100, smoothness: +$('keySmooth').value / 100, spill: +$('keySpill').value / 100,
    opacity: +$('liveOp').value / 100,
  });
}
seg('segKey', applyKeyUI);
seg('segLiveMode', (v) => {
  V.setLive({ mode: v });
  if (v === 'card' && !V.state.talent && V.state.setRoot) V.centerTalent();   // the camera needs a card to land on
});
$('keyColor').oninput = applyKeyUI;
slider('keySim', applyKeyUI, (v) => fmt(v / 100));
slider('keySmooth', applyKeyUI, (v) => fmt(v / 100));
slider('keySpill', applyKeyUI, (v) => fmt(v / 100));
slider('liveOp', applyKeyUI, (v) => `${v}%`);
// Eyedropper: click the green in the viewer. Runs before the viewer's own picking (capture).
$('btnKeyPick').onclick = () => setPick('keycolor', 'Click on the chroma background in the picture · Esc to cancel');
$('c').addEventListener('pointerup', (e) => {
  if (V.pickMode !== 'keycolor') return;
  const hex = V.sampleLive(e.clientX, e.clientY);
  if (hex) { $('keyColor').value = hex; applyKeyUI(); }
  setPick(null);
}, { capture: true });

window.SF = { V, P, build, collect };   // handy for debugging from the console
