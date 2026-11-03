// FREE BUILD — a click-only 3D brick sandbox.
// Every action is a single click: no dragging, no keyboard, no typing.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const GRID = 16;            // baseplate is 16 × 16 studs
const HALF = GRID / 2;
const H = 1.2;              // brick height in stud units (classic 9.6mm / 8mm)
const STUD_R = 0.3;
const STUD_H = 0.18;
const GAP = 0.03;           // tiny seam between neighbouring bricks
const MAX_LEVEL = 24;       // build height limit

// [width along x, depth along z]
const TYPES = { '1x1': [1, 1], '1x2': [1, 2], '2x2': [2, 2], '2x4': [2, 4] };

const COLORS = [
  { name: 'Red',    hex: '#d9302a' },
  { name: 'Orange', hex: '#f2852b' },
  { name: 'Yellow', hex: '#f6c431' },
  { name: 'Green',  hex: '#2a9d4f' },
  { name: 'Blue',   hex: '#1f63c6' },
  { name: 'White',  hex: '#f3f1ec' },
];

const HINTS = {
  build: 'Click the baseplate or a brick to place it',
  buildTouch: 'Tap a spot to preview, tap again to place',
  select: 'Click a brick to select it, then press Delete',
};

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const state = {
  mode: 'edit',        // 'edit' | 'finish'
  tool: 'build',       // 'build' | 'select'
  type: '2x4',
  color: 0,
  rot: 0,              // 0 or 1 (90°). Two 90° turns return to the same footprint.
  rotDeg: 0,           // purely cosmetic counter for the button icon
  selected: null,      // brick id
  muted: false,
};

const bricks = new Map();   // id -> brick record
const occ = new Map();      // "x,y,z" -> brick id
const brickMeshes = [];     // meshes for raycasting
const history = [];         // undo stack
let nextId = 1;

const key = (x, y, z) => `${x},${y},${z}`;
const dims = (type, rot) => {
  const [w, d] = TYPES[type];
  return rot ? [d, w] : [w, d];
};
function cellsOf(s) {
  const [fw, fd] = dims(s.type, s.rot);
  const out = [];
  for (let i = 0; i < fw; i++) for (let j = 0; j < fd; j++) out.push([s.x + i, s.z + j]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Renderer / scene                                                   */
/* ------------------------------------------------------------------ */

const stage = document.getElementById('stage');
const canvas = document.getElementById('scene');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const hemi = new THREE.HemisphereLight(0xffffff, 0xe6dfd2, 0.75);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff6ea, 2.6);
sun.position.set(9, 24, 13);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -17, right: 17, top: 17, bottom: -17, near: 1, far: 80 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.025;
sun.shadow.radius = 4;
scene.add(sun);

// Soft shadow catcher beneath the baseplate so the plate sits on the page.
const catcher = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.ShadowMaterial({ color: 0x5a4a30, opacity: 0.16 })
);
catcher.rotation.x = -Math.PI / 2;
catcher.position.y = -0.32;
catcher.receiveShadow = true;
scene.add(catcher);

/* ---------- baseplate ---------- */
const plateMat = new THREE.MeshPhysicalMaterial({
  color: '#d3dbcb', roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.5,
});
const plate = new THREE.Mesh(new RoundedBoxGeometry(GRID + 0.2, 0.3, GRID + 0.2, 3, 0.1), plateMat);
plate.position.y = -0.15;
plate.receiveShadow = true;
plate.castShadow = true;
scene.add(plate);

{
  const studGeo = new THREE.CylinderGeometry(STUD_R, STUD_R, STUD_H, 20);
  const studs = new THREE.InstancedMesh(studGeo, plateMat, GRID * GRID);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
    m.makeTranslation(i - HALF + 0.5, STUD_H / 2, j - HALF + 0.5);
    studs.setMatrixAt(n++, m);
  }
  studs.receiveShadow = true;
  studs.castShadow = true;
  scene.add(studs);
}

// Invisible picking plane at the baseplate surface.
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/* ---------- brick geometry (generated, cached per footprint) ---------- */
const geoCache = new Map();
function brickGeometry(fw, fd) {
  const k = `${fw}x${fd}`;
  if (geoCache.has(k)) return geoCache.get(k);
  const body = new RoundedBoxGeometry(fw - GAP, H - 0.01, fd - GAP, 2, 0.055);
  body.translate(0, (H - 0.01) / 2, 0);
  const parts = [body];
  for (let i = 0; i < fw; i++) for (let j = 0; j < fd; j++) {
    const stud = new THREE.CylinderGeometry(STUD_R, STUD_R, STUD_H, 24);
    stud.translate(i - fw / 2 + 0.5, H + STUD_H / 2 - 0.01, j - fd / 2 + 0.5);
    parts.push(stud);
  }
  const g = mergeGeometries(parts.map(p => p.toNonIndexed()));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  geoCache.set(k, g);
  return g;
}

const baseMaterials = COLORS.map(c => new THREE.MeshPhysicalMaterial({
  color: c.hex, roughness: 0.3, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.22,
}));

/* ---------- ghost (placement preview) ---------- */
const ghostMat = new THREE.MeshStandardMaterial({
  color: COLORS[0].hex, transparent: true, opacity: 0.5, depthWrite: false, roughness: 0.4,
});
const ghost = new THREE.Mesh(brickGeometry(2, 4), ghostMat);
ghost.visible = false;
ghost.renderOrder = 2;
scene.add(ghost);
const ghostEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false })
);
ghostEdges.renderOrder = 3;
ghostEdges.visible = false;
scene.add(ghostEdges);

/* ---------- selection outline ---------- */
const selBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: 0x23211d, transparent: true, opacity: 0.95, depthTest: false })
);
selBox.renderOrder = 4;
selBox.visible = false;
scene.add(selBox);

/* ------------------------------------------------------------------ */
/* Camera — isometric orthographic, moved only by buttons             */
/* ------------------------------------------------------------------ */

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
const ELEV = Math.atan(1 / Math.SQRT2);          // true isometric elevation (35.26°)
const STEP = Math.PI / 4;
const HOME_TARGET = new THREE.Vector3(0, 1.4, 0);
const view = {
  theta: STEP, thetaT: STEP,
  zoom: 1, zoomT: 1,
  target: HOME_TARGET.clone(), targetT: HOME_TARGET.clone(),
};
let frustumH = 22;
let saved = null; // camera state saved before Finish

function applyCamera() {
  const R = 80;
  const c = Math.cos(ELEV);
  camera.position.set(
    view.target.x + R * c * Math.sin(view.theta),
    view.target.y + R * Math.sin(ELEV),
    view.target.z + R * c * Math.cos(view.theta)
  );
  camera.lookAt(view.target);
  camera.zoom = view.zoom;
  camera.updateProjectionMatrix();
}

function resize() {
  const w = Math.max(1, stage.clientWidth);
  const h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  const aspect = w / h;
  frustumH = Math.max(21, 26 / aspect);
  camera.left = (-frustumH * aspect) / 2;
  camera.right = (frustumH * aspect) / 2;
  camera.top = frustumH / 2;
  camera.bottom = -frustumH / 2;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();
applyCamera();

/* ------------------------------------------------------------------ */
/* Sound — tiny synthesized clicks, no audio files                    */
/* ------------------------------------------------------------------ */

let actx = null;
let booted = false;
function audio() {
  if (state.muted || !booted) return null;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  } catch { return null; }
}
function tone(f0, f1, dur, type = 'sine', gain = 0.12, delay = 0) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, gain, freq, delay = 0) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + delay;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const s = a.createBufferSource(); s.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
  const g = a.createGain(); g.gain.value = gain;
  s.connect(f).connect(g).connect(a.destination);
  s.start(t);
}
const sfx = {
  place()  { noise(0.05, 0.9, 3200); tone(420, 160, 0.07, 'triangle', 0.16); noise(0.035, 0.6, 1800, 0.09); },
  ui()     { tone(880, 760, 0.05, 'sine', 0.06); },
  select() { tone(660, 990, 0.08, 'sine', 0.08); },
  rotate() { tone(520, 780, 0.09, 'triangle', 0.08); },
  remove() { tone(600, 180, 0.13, 'triangle', 0.12); noise(0.04, 0.4, 2400); },
  undo()   { tone(700, 420, 0.09, 'sine', 0.08); },
  error()  { tone(190, 150, 0.09, 'square', 0.045); tone(190, 140, 0.09, 'square', 0.045, 0.11); },
  finish() { [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.16, 'triangle', 0.09, i * 0.09)); },
};

/* ------------------------------------------------------------------ */
/* Rules: placement validity                                          */
/* ------------------------------------------------------------------ */

function check(s) {
  const [fw, fd] = dims(s.type, s.rot);
  if (s.x < 0 || s.z < 0 || s.x + fw > GRID || s.z + fd > GRID) return { ok: false, reason: 'That would hang off the baseplate' };
  if (s.y < 0) return { ok: false, reason: 'Out of bounds' };
  if (s.y >= MAX_LEVEL) return { ok: false, reason: 'That’s as high as it goes' };
  const cells = cellsOf(s);
  for (const [cx, cz] of cells) {
    if (occ.has(key(cx, s.y, cz))) return { ok: false, reason: 'Something is already there' };
  }
  if (s.y > 0) {
    const supported = cells.some(([cx, cz]) => occ.has(key(cx, s.y - 1, cz)));
    if (!supported) return { ok: false, reason: 'Bricks need something underneath' };
  }
  return { ok: true };
}

// Bricks that would be left floating if `id` were removed.
function dependentsOf(id) {
  const b = bricks.get(id);
  const above = new Set();
  for (const [cx, cz] of cellsOf(b)) {
    const o = occ.get(key(cx, b.y + 1, cz));
    if (o) above.add(o);
  }
  const out = [];
  for (const aid of above) {
    const a = bricks.get(aid);
    const other = cellsOf(a).some(([cx, cz]) => {
      const u = occ.get(key(cx, a.y - 1, cz));
      return u && u !== id;
    });
    if (!other) out.push(aid);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Brick lifecycle                                                    */
/* ------------------------------------------------------------------ */

const anims = [];

function brickPosition(b) {
  const [fw, fd] = dims(b.type, b.rot);
  return new THREE.Vector3(b.x - HALF + fw / 2, b.y * H, b.z - HALF + fd / 2);
}

function addBrick(spec, { animate = true } = {}) {
  const id = spec.id ?? nextId++;
  nextId = Math.max(nextId, id + 1);
  const b = { id, type: spec.type, rot: spec.rot, x: spec.x, z: spec.z, y: spec.y, color: spec.color };
  const [fw, fd] = dims(b.type, b.rot);
  const mesh = new THREE.Mesh(brickGeometry(fw, fd), baseMaterials[b.color].clone());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.copy(brickPosition(b));
  mesh.userData.id = id;
  b.mesh = mesh;
  scene.add(mesh);
  brickMeshes.push(mesh);
  for (const [cx, cz] of cellsOf(b)) occ.set(key(cx, b.y, cz), id);
  bricks.set(id, b);
  if (animate) {
    mesh.position.y += 0.9;
    anims.push({ kind: 'drop', mesh, t: 0, baseY: b.y * H });
  }
  updateCount();
  return b;
}

function removeBrick(id, { animate = true } = {}) {
  const b = bricks.get(id);
  if (!b) return null;
  for (const [cx, cz] of cellsOf(b)) occ.delete(key(cx, b.y, cz));
  bricks.delete(id);
  const i = brickMeshes.indexOf(b.mesh);
  if (i >= 0) brickMeshes.splice(i, 1);
  if (state.selected === id) setSelected(null);
  if (hoverBrickId === id) hoverBrickId = null;
  for (let k = anims.length - 1; k >= 0; k--) if (anims[k].mesh === b.mesh) anims.splice(k, 1);
  if (animate) {
    b.mesh.material.transparent = true;
    anims.push({ kind: 'pop', mesh: b.mesh, t: 0 });
  } else {
    disposeMesh(b.mesh);
  }
  updateCount();
  return specOf(b);
}

function disposeMesh(m) {
  scene.remove(m);
  m.material.dispose();
}

const specOf = b => ({ id: b.id, type: b.type, rot: b.rot, x: b.x, z: b.z, y: b.y, color: b.color });

function clearAll() {
  for (const id of [...bricks.keys()]) removeBrick(id, { animate: false });
}

/* ------------------------------------------------------------------ */
/* Actions (all undoable)                                             */
/* ------------------------------------------------------------------ */

function place(spec) {
  const res = check(spec);
  if (!res.ok) { reject(res.reason); return false; }
  const b = addBrick(spec);
  history.push({ t: 'add', id: b.id });
  sfx.place();
  updateButtons();
  return true;
}

function deleteSelected() {
  const id = state.selected;
  if (id == null) {
    setTool('select');
    flash('Click a brick to select it, then press Delete', 'good');
    return;
  }
  const deps = dependentsOf(id);
  if (deps.length) {
    reject(deps.length === 1 ? 'Remove the brick on top first' : `Remove the ${deps.length} bricks on top first`);
    for (const d of deps) anims.push({ kind: 'wiggle', mesh: bricks.get(d).mesh, t: 0, baseX: bricks.get(d).mesh.position.x });
    return;
  }
  const spec = removeBrick(id);
  history.push({ t: 'remove', spec });
  sfx.remove();
  flash('Brick removed', 'good');
  updateButtons();
}

function undo() {
  const a = history.pop();
  if (!a) { reject('Nothing to undo'); return; }
  if (a.t === 'add') removeBrick(a.id);
  else if (a.t === 'remove') addBrick(a.spec);
  else if (a.t === 'reset') {
    a.specs.sort((p, q) => p.y - q.y).forEach(s => addBrick(s));
  }
  sfx.undo();
  flash(a.t === 'reset' ? 'Build restored' : 'Undone', 'good');
  updateButtons();
}

function reset() {
  if (!bricks.size) { reject('The baseplate is already empty'); return; }
  const specs = [...bricks.values()].map(specOf);
  clearAll();
  history.push({ t: 'reset', specs });
  sfx.remove();
  flash('Baseplate cleared — Undo brings it back', 'good');
  updateButtons();
}

/* ------------------------------------------------------------------ */
/* Picking                                                            */
/* ------------------------------------------------------------------ */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let pointerInside = false;
let lastPointerType = 'mouse';
let hover = null;          // { spec, ok, reason }
let hoverBrickId = null;   // brick under cursor (select tool)
let pendingTapKey = null;  // touch: first tap previews, second tap places

function setPointer(e) {
  const r = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  lastPointerType = e.pointerType || 'mouse';
}

function pickBrick() {
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObjects(brickMeshes, false)[0] || null;
}

// Works out which grid cells + level the cursor is pointing at.
function computeTarget() {
  raycaster.setFromCamera(ndc, camera);
  const [fw, fd] = dims(state.type, state.rot);
  let px, pz, level;
  const hit = raycaster.intersectObjects(brickMeshes, false)[0];
  if (hit) {
    const b = bricks.get(hit.object.userData.id);
    const n = hit.face.normal;
    const top = (b.y + 1) * H;
    if (n.y > 0.5 || hit.point.y > top - 0.02) {
      // top face or a stud: stack on top
      level = b.y + 1;
      px = hit.point.x + HALF;
      pz = hit.point.z + HALF;
    } else if (n.y < -0.5) {
      return null;
    } else {
      // side face: place next to it, same level
      level = b.y;
      const cx = Math.floor(hit.point.x + HALF + n.x * 0.5);
      const cz = Math.floor(hit.point.z + HALF + n.z * 0.5);
      px = cx + 0.5; pz = cz + 0.5;
      if (cx < 0 || cz < 0 || cx >= GRID || cz >= GRID) return null;
    }
  } else {
    const p = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, p)) return null;
    if (Math.abs(p.x) > HALF || Math.abs(p.z) > HALF) return null;
    level = 0;
    px = p.x + HALF;
    pz = p.z + HALF;
  }
  // Centre the footprint on the cursor, then keep it on the plate.
  const x = Math.min(Math.max(Math.round(px - fw / 2), 0), GRID - fw);
  const z = Math.min(Math.max(Math.round(pz - fd / 2), 0), GRID - fd);
  return { type: state.type, rot: state.rot, color: state.color, x, z, y: level };
}

const specKey = s => s && `${s.type}|${s.rot}|${s.x}|${s.y}|${s.z}`;

function refreshHover() {
  if (state.mode !== 'edit' || !pointerInside) {
    hover = null; setHoverBrick(null); return;
  }
  if (state.tool === 'select') {
    hover = null;
    const h = pickBrick();
    setHoverBrick(h ? h.object.userData.id : null);
    return;
  }
  setHoverBrick(null);
  if (lastPointerType === 'touch' && !pendingTapKey) { hover = null; return; }
  const spec = computeTarget();
  if (!spec) { hover = null; return; }
  const res = check(spec);
  hover = { spec, ok: res.ok, reason: res.reason };
}

function setHoverBrick(id) {
  if (hoverBrickId === id) return;
  const prev = hoverBrickId && bricks.get(hoverBrickId);
  if (prev && prev.id !== state.selected) prev.mesh.material.emissive.setHex(0x000000);
  hoverBrickId = id;
  const b = id && bricks.get(id);
  if (b && b.id !== state.selected) b.mesh.material.emissive.setHex(0x2a2a2a);
}

function setSelected(id) {
  const prev = state.selected != null && bricks.get(state.selected);
  if (prev) prev.mesh.material.emissive.setHex(0x000000);
  state.selected = id;
  const b = id != null && bricks.get(id);
  if (b) {
    const [fw, fd] = dims(b.type, b.rot);
    selBox.scale.set(fw + 0.08, H + STUD_H + 0.08, fd + 0.08);
    const p = brickPosition(b);
    selBox.position.set(p.x, p.y + (H + STUD_H) / 2, p.z);
    selBox.visible = true;
  } else {
    selBox.visible = false;
  }
  updateButtons();
}

/* ---------- pointer events (clicks + hover only; no drag) ---------- */
canvas.addEventListener('pointermove', e => { pointerInside = true; setPointer(e); });
canvas.addEventListener('pointerenter', e => { pointerInside = true; setPointer(e); });
canvas.addEventListener('pointerleave', () => { if (lastPointerType !== 'touch') pointerInside = false; });
canvas.addEventListener('pointerdown', e => { pointerInside = true; setPointer(e); });
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('click', e => {
  if (state.mode !== 'edit') return;
  setPointer(e);
  pointerInside = true;

  if (state.tool === 'select') {
    const h = pickBrick();
    if (h) {
      const id = h.object.userData.id;
      if (state.selected === id) { setSelected(null); sfx.ui(); flash(HINTS.select); }
      else { setSelected(id); sfx.select(); flash('Selected — press Delete to remove it', 'good'); }
    } else if (state.selected != null) {
      setSelected(null); sfx.ui();
    }
    setHoverBrick(null);
    return;
  }

  // Build tool
  if (lastPointerType === 'touch') {
    const spec = computeTarget();
    if (!spec) { pendingTapKey = null; return; }
    const k = specKey(spec);
    if (pendingTapKey !== k) {
      pendingTapKey = k;
      refreshHover();
      flash('Tap the same spot again to place');
      sfx.ui();
      return;
    }
    pendingTapKey = null;
    place(spec);
    return;
  }

  const spec = computeTarget();
  if (!spec) return;
  if (place(spec)) refreshHover();
});

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

const $ = id => document.getElementById(id);
const hintEl = $('hint');
let hintTimer = 0;

function baseHint() {
  if (state.tool === 'select') return HINTS.select;
  return matchMedia('(hover: none)').matches ? HINTS.buildTouch : HINTS.build;
}
function flash(text, kind = '', ms = 2200) {
  hintEl.textContent = text;
  hintEl.className = 'hint ' + kind;
  void hintEl.offsetWidth;
  hintEl.classList.add(kind === 'warn' ? 'shake' : 'bump');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hintEl.className = 'hint'; hintEl.textContent = baseHint(); }, ms);
}
function reject(reason) {
  sfx.error();
  flash(reason, 'warn');
  if (ghost.visible) anims.push({ kind: 'shake', mesh: ghost, t: 0 });
}

function brickIcon(type, hex) {
  const [w, d] = TYPES[type];
  const cols = d, rows = w;          // draw long side horizontally
  const s = 12, pad = 2;
  const W = cols * s + pad * 2, Hh = rows * s + pad * 2;
  let studs = '';
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const cx = pad + i * s + s / 2, cy = pad + j * s + s / 2;
    studs += `<circle cx="${cx}" cy="${cy}" r="3.6" fill="${hex}"/><circle cx="${cx}" cy="${cy}" r="3.6" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="1"/>`;
  }
  const stroke = hex.toLowerCase() === '#f3f1ec' ? '#cfc8ba' : 'rgba(0,0,0,.18)';
  return `<svg viewBox="0 0 ${W} ${Hh + 3}" aria-hidden="true">
    <rect x="1" y="4" width="${W - 2}" height="${Hh - 2}" rx="3" fill="rgba(0,0,0,.18)"/>
    <rect x="1" y="1" width="${W - 2}" height="${Hh - 2}" rx="3" fill="${hex}" stroke="${stroke}"/>
    ${studs}</svg>`;
}

function renderBrickIcons() {
  const hex = COLORS[state.color].hex;
  document.querySelectorAll('.brick-btn').forEach(btn => {
    btn.querySelector('svg').outerHTML = brickIcon(btn.dataset.type, hex);
    btn.classList.toggle('active', state.tool === 'build' && btn.dataset.type === state.type);
  });
}

function buildColorButtons() {
  const wrap = $('colors');
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.setProperty('--c', c.hex);
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.dataset.index = i;
    b.addEventListener('click', () => setColor(i));
    wrap.appendChild(b);
  });
}

function setColor(i) {
  state.color = i;
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', +s.dataset.index === i));
  const hex = COLORS[i].hex;
  document.documentElement.style.setProperty('--accent', i === 5 ? '#c9c1b0' : hex);
  ghostMat.color.set(hex);
  if (state.tool !== 'build') setTool('build');
  renderBrickIcons();
  sfx.ui();
}

function setType(t) {
  state.type = t;
  setTool('build');
  renderBrickIcons();
  sfx.ui();
}

function setTool(tool) {
  state.tool = tool;
  pendingTapKey = null;
  if (tool === 'build') setSelected(null);
  $('btn-select').classList.toggle('active', tool === 'select');
  stage.classList.toggle('picking', tool === 'select');
  stage.classList.toggle('building', tool === 'build');
  renderBrickIcons();
  setHoverBrick(null);
  clearTimeout(hintTimer);
  hintEl.className = 'hint';
  hintEl.textContent = baseHint();
  updateButtons();
}

function rotate() {
  state.rot ^= 1;
  state.rotDeg += 90;
  const btn = $('btn-rotate');
  btn.querySelector('svg').style.transform = `rotate(${state.rotDeg}deg)`;
  if (state.tool !== 'build') setTool('build');
  const [w, d] = TYPES[state.type];
  flash(w === d ? 'Rotated — square bricks look the same either way' : 'Rotated 90°', 'good', 1400);
  sfx.rotate();
}

function updateCount() {
  const n = bricks.size;
  $('count').textContent = n;
  $('count-label').textContent = n === 1 ? 'brick placed' : 'bricks placed';
}

function updateButtons() {
  $('btn-undo').disabled = history.length === 0;
  $('btn-delete').classList.toggle('armed', state.selected != null);
}

/* ---------- camera buttons ---------- */
function camRotate(dir) { view.thetaT += dir * STEP; sfx.ui(); }
function camZoom(f) {
  const z = Math.min(2.8, Math.max(0.55, view.zoomT * f));
  if (z === view.zoomT) { sfx.error(); return; }
  view.zoomT = z; sfx.ui();
}

/* ---------- finish / showcase ---------- */
function finish() {
  if (!bricks.size) { reject('Place at least one brick first'); return; }
  state.mode = 'finish';
  saved = { zoom: view.zoomT };
  setSelected(null);
  setHoverBrick(null);
  hover = null;
  document.body.classList.add('finished');
  $('showcase').setAttribute('aria-hidden', 'false');
  const n = bricks.size;
  const colorsUsed = new Set([...bricks.values()].map(b => b.color)).size;
  const height = Math.max(...[...bricks.values()].map(b => b.y)) + 1;
  $('showcase-sub').textContent =
    `${n} ${n === 1 ? 'brick' : 'bricks'} · ${colorsUsed} ${colorsUsed === 1 ? 'colour' : 'colours'} · ${height} ${height === 1 ? 'layer' : 'layers'} high`;
  // Frame the structure after the layout change settles.
  requestAnimationFrame(() => requestAnimationFrame(frameStructure));
  sfx.finish();
}

function frameStructure() {
  const box = new THREE.Box3();
  for (const b of bricks.values()) {
    const [fw, fd] = dims(b.type, b.rot);
    const p = brickPosition(b);
    box.expandByPoint(new THREE.Vector3(p.x - fw / 2, p.y, p.z - fd / 2));
    box.expandByPoint(new THREE.Vector3(p.x + fw / 2, p.y + H + STUD_H, p.z + fd / 2));
  }
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  view.targetT.copy(c);
  // Rough screen extent of the box in an isometric view, from any angle.
  const horiz = Math.hypot(size.x, size.z);
  const vert = size.y * Math.cos(ELEV) + horiz * Math.sin(ELEV);
  const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
  const need = Math.max(vert / 0.55, horiz / (0.62 * aspect), 6);
  view.zoomT = Math.min(2.4, Math.max(0.7, frustumH / need));
}

function backToEdit() {
  state.mode = 'edit';
  document.body.classList.remove('finished');
  $('showcase').setAttribute('aria-hidden', 'true');
  view.thetaT = Math.round(view.theta / STEP) * STEP;
  view.zoomT = saved ? saved.zoom : 1;
  view.targetT.copy(HOME_TARGET);
  setTool(state.tool);
  sfx.ui();
}

function newCreation() {
  clearAll();
  history.length = 0;
  backToEdit();
  view.zoomT = 1;
  updateButtons();
  flash('Fresh baseplate — build anything', 'good');
}

/* ---------- wire up ---------- */
buildColorButtons();
document.querySelectorAll('.brick-btn').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));
$('btn-select').addEventListener('click', () => { setTool(state.tool === 'select' ? 'build' : 'select'); sfx.ui(); });
$('btn-rotate').addEventListener('click', rotate);
$('btn-undo').addEventListener('click', undo);
$('btn-delete').addEventListener('click', deleteSelected);
$('btn-reset').addEventListener('click', reset);
$('btn-finish').addEventListener('click', finish);
$('btn-edit').addEventListener('click', backToEdit);
$('btn-new').addEventListener('click', newCreation);
$('cam-left').addEventListener('click', () => camRotate(-1));
$('cam-right').addEventListener('click', () => camRotate(1));
$('cam-in').addEventListener('click', () => camZoom(1.25));
$('cam-out').addEventListener('click', () => camZoom(1 / 1.25));
$('btn-mute').addEventListener('click', () => {
  state.muted = !state.muted;
  $('btn-mute').setAttribute('aria-pressed', String(state.muted));
  if (!state.muted) sfx.ui();
});

setColor(0);
setTool('build');
updateCount();
booted = true;

/* ------------------------------------------------------------------ */
/* Loop                                                               */
/* ------------------------------------------------------------------ */

const clock = new THREE.Clock();
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
let lastGhostKey = '';

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  // camera
  if (state.mode === 'finish') { view.theta += dt * 0.22; view.thetaT = view.theta; }
  const k = 1 - Math.exp(-dt * 7);
  view.theta += (view.thetaT - view.theta) * k;
  view.zoom += (view.zoomT - view.zoom) * k;
  view.target.lerp(view.targetT, k);
  applyCamera();

  // hover + ghost
  refreshHover();
  if (hover && state.mode === 'edit' && state.tool === 'build') {
    const s = hover.spec;
    const [fw, fd] = dims(s.type, s.rot);
    const gk = `${fw}x${fd}`;
    if (gk !== lastGhostKey) { ghost.geometry = brickGeometry(fw, fd); lastGhostKey = gk; }
    const p = brickPosition(s);
    ghost.position.x = p.x; ghost.position.z = p.z;
    ghost.position.y = p.y + 0.04 + Math.sin(time * 5) * 0.025;
    ghostMat.color.set(hover.ok ? COLORS[state.color].hex : '#ff3b30');
    ghostMat.opacity = hover.ok ? 0.55 : 0.32;
    ghostEdges.material.color.set(hover.ok ? 0xffffff : 0xff3b30);
    ghostEdges.scale.set(fw - GAP, H, fd - GAP);
    ghostEdges.position.set(p.x, p.y + H / 2 + 0.04, p.z);
    ghost.visible = ghostEdges.visible = true;
  } else {
    ghost.visible = ghostEdges.visible = false;
  }

  // selection pulse
  if (state.selected != null) {
    const b = bricks.get(state.selected);
    if (b) b.mesh.material.emissive.setScalar(0.12 + 0.1 * Math.sin(time * 6));
    selBox.material.opacity = 0.65 + 0.3 * Math.sin(time * 6);
  }

  // little animations
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i];
    a.t += dt;
    if (a.kind === 'drop') {
      const d = 0.16, sq = 0.14;
      if (a.t < d) {
        a.mesh.position.y = a.baseY + (1 - easeOutCubic(a.t / d)) * 0.9;
      } else {
        a.mesh.position.y = a.baseY;
        const u = Math.min(1, (a.t - d) / sq);
        const s = Math.sin(u * Math.PI) * (1 - u);
        a.mesh.scale.set(1 + s * 0.08, 1 - s * 0.12, 1 + s * 0.08);
        if (u >= 1) { a.mesh.scale.set(1, 1, 1); anims.splice(i, 1); }
      }
    } else if (a.kind === 'pop') {
      const u = Math.min(1, a.t / 0.16);
      a.mesh.scale.setScalar(1 + 0.12 * Math.sin(u * Math.PI) - 0.9 * u * u);
      a.mesh.material.opacity = 1 - u;
      if (u >= 1) { disposeMesh(a.mesh); anims.splice(i, 1); }
    } else if (a.kind === 'shake') {
      const u = Math.min(1, a.t / 0.3);
      a.mesh.position.x += Math.sin(u * Math.PI * 6) * 0.12 * (1 - u);
      if (u >= 1) anims.splice(i, 1);
    } else if (a.kind === 'wiggle') {
      const u = Math.min(1, a.t / 0.4);
      a.mesh.position.x = a.baseX + Math.sin(u * Math.PI * 6) * 0.08 * (1 - u);
      if (u >= 1) { a.mesh.position.x = a.baseX; anims.splice(i, 1); }
    }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ------------------------------------------------------------------ */
/* Read-only hooks for automated testing                              */
/* ------------------------------------------------------------------ */
window.FREEBUILD = {
  get state() { return { ...state, bricks: bricks.size, history: history.length, hover: hover && { ...hover } }; },
  bricks: () => [...bricks.values()].map(specOf),
  // client-space pixel position of a world point (for driving real mouse clicks)
  toScreen(x, y, z) {
    applyCamera();
    const v = new THREE.Vector3(x, y, z).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  },
  cellCenter(cx, cz, level = 0) { return this.toScreen(cx - HALF + 0.5, level * H + 0.001, cz - HALF + 0.5); },
  settle() { view.theta = view.thetaT; view.zoom = view.zoomT; view.target.copy(view.targetT); applyCamera(); },
};
