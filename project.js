// Projects: saved in the browser (IndexedDB, works offline) and as a portable .setframer file.
//
// A project = { data (JSON: everything you set up), set files (the glTF/GLB and its textures, or
// "demo"), the HDRI file }. Big files live in their own store and are only rewritten when they change,
// so the autosave every few seconds only writes a little JSON.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';

const DB = 'setframer', VERSION = 1;
export const AUTOSAVE = 'autosave';

let dbp = null;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('projects', { keyPath: 'id' });   // { id, name, updated, thumb, data }
      r.result.createObjectStore('files', { keyPath: 'id' });      // { id, sig, set: [{name, relPath, blob}] | null, hdri: {name, blob} | null }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    let req;
    try {
      const t = d.transaction(store, mode);
      req = fn(t.objectStore(store));
      // The REQUEST carries the real reason; the transaction's own error can still be null here
      // (that is how "Could not save: null" happened).
      const why = () => req?.error || t.error || new Error('The browser refused to store the project (storage full or blocked?)');
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(why());
      t.onabort = () => rej(why());
    } catch (err) { rej(err); }   // e.g. DataCloneError, thrown synchronously by put()
  });
}
const get = (store, id) => tx(store, 'readonly', (s) => s.get(id));

/** A cheap fingerprint of the heavy files: they are rewritten only when it changes. */
function signature(source, hdriFile) {
  const set = source?.kind === 'files' ? source.files.map((f) => `${f.relPath || f.name}:${f.size}`).join('|') : source?.kind || '';
  return `${set}#${hdriFile ? `${hdriFile.name}:${hdriFile.size}` : ''}`;
}

export async function saveProject({ id, name, data, thumb, source, hdriFile }) {
  const sig = signature(source, hdriFile);
  const old = await get('files', id);
  if (!old || old.sig !== sig) {
    // Plain bytes (ArrayBuffer), not File/Blob objects: Safari refuses some Blobs in IndexedDB
    // with an empty error. Read everything BEFORE opening the transaction (it must not wait).
    const bytes = async (f) => ({ name: f.name, relPath: f.relPath || f.webkitRelativePath || f.name, type: f.type, data: await f.arrayBuffer() });
    const set = source?.kind === 'files' ? await Promise.all(source.files.map(bytes)) : null;
    const hdri = hdriFile ? await bytes(hdriFile) : null;
    await tx('files', 'readwrite', (s) => s.put({ id, sig, set, hdri }));
  }
  const prev = await get('projects', id);
  await tx('projects', 'readwrite', (s) => s.put({ id, name, updated: Date.now(), thumb: thumb ?? prev?.thumb ?? null, data }));
}

export async function listProjects() {
  const all = await tx('projects', 'readonly', (s) => s.getAll());
  return all.filter((p) => p.id !== AUTOSAVE).sort((a, b) => b.updated - a.updated);
}
export const getProject = (id) => get('projects', id);

/** → { record, files: { set: File[] | null, hdri: File | null } } */
export async function loadProject(id) {
  const record = await get('projects', id), f = await get('files', id);
  if (!record) return null;
  return { record, files: revive(f) };
}
function revive(f) {
  // x.data = bytes (current format); x.blob = Blob/File (projects saved before the Safari fix)
  const toFile = (x) => { const file = new File([x.data ?? x.blob], x.name, { type: x.type || '' }); file.relPath = x.relPath || x.name; return file; };
  return { set: f?.set ? f.set.map(toFile) : null, hdri: f?.hdri ? toFile(f.hdri) : null };
}

export async function deleteProject(id) {
  await tx('projects', 'readwrite', (s) => s.delete(id));
  await tx('files', 'readwrite', (s) => s.delete(id));
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export function persistStorage() { navigator.storage?.persist?.().catch(() => {}); }

// ---- portable file: <name>.setframer = zip { project.json, set/…, hdri/… } -----------------------
export async function packProject({ name, data, source, hdriFile }) {
  const tree = { 'project.json': [strToU8(JSON.stringify({ app: 'SetFrameR', format: 1, name, data }, null, 1)), { level: 6 }] };
  if (source?.kind === 'files') {
    for (const f of source.files) tree[`set/${f.relPath || f.webkitRelativePath || f.name}`] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];
  }
  if (hdriFile) tree[`hdri/${hdriFile.name}`] = [new Uint8Array(await hdriFile.arrayBuffer()), { level: 0 }];
  return zipSync(tree);
}

/** → { name, data, files: { set: File[] | null, hdri: File | null } } */
export async function unpackProject(file) {
  const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (!z['project.json']) throw new Error('Not a SetFrameR project file');
  const meta = JSON.parse(strFromU8(z['project.json']));
  const set = [], hdri = [];
  for (const [path, bytes] of Object.entries(z)) {
    if (path.endsWith('/')) continue;
    const name = path.split('/').pop();
    const f = new File([bytes], name);
    if (path.startsWith('set/')) { f.relPath = path.slice(4); set.push(f); }
    else if (path.startsWith('hdri/')) hdri.push(f);
  }
  return { name: meta.name, data: meta.data, files: { set: set.length ? set : null, hdri: hdri[0] || null } };
}
