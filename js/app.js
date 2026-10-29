// G1 Nav Playground page: the 3D view, the playback buffer, overlays, HUD, input, the driver lease and the editor.
// The robot comes from a live server (navloop on this machine, streamed) or from recorded runs; both deliver the same
// ticks (joint state), plans and events, and the page plays them back smoothly, a little behind the newest tick.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from './config.js?v=learned-20261029-v1';
import { icon } from './icons.js?v=learned-20261029-v1';
import { lerpQpos } from './kin.js?v=learned-20261029-v1';
import { loadRobotModel, Robot, solidMaterials, ghostMaterial } from './robot.js?v=learned-20261029-v1';
import { clientIdentity, probe, LiveSource, RecordedSource } from './source.js?v=learned-20261029-v1';

const DT = 0.02, NQ = 36;
const el = (id) => document.getElementById(id);
// Everything put into innerHTML goes through esc(): strings come from the server or from recorded files.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const HUE = { input: 0xa78bfa, plan: 0x2dd4bf, goal: 0xf59e0b, bad: 0xf87171, cand: 0xe5e7eb, trail: 0xe5e7eb, route: 0xe5e7eb };
const MAX_TICKS_KEPT = 30000; // 10 min
const coarse = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------------------------------------------------- 3D
const renderer = new THREE.WebGLRenderer({ antialias: !coarse, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.15;
el('view').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x0d0f12);
scene.background = SKY;
scene.fog = new THREE.FogExp2(SKY, 0.045);
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 150);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.minDistance = 1.6;
controls.maxDistance = 20;
controls.maxPolarAngle = 1.48;
controls.screenSpacePanning = false;
let needsRender = true;
let occlusionDirty = true;
controls.addEventListener('change', () => { needsRender = occlusionDirty = true; });
renderer.domElement.addEventListener('webglcontextrestored', () => {
  needsRender = renderer.shadowMap.needsUpdate = true;
});

scene.add(new THREE.HemisphereLight(0xdfe7f2, 0x202428, 1.1));
const key = new THREE.DirectionalLight(0xfff4e8, 2.2);
key.castShadow = true;
key.shadow.mapSize.setScalar(coarse ? 1024 : 2048);
Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 30 });
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.03;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0x9fb4d6, 0.7);
fill.position.set(-8, 4, 6);
scene.add(fill);

// The simulation is z-up; this group maps it into three's y-up world.
const zup = new THREE.Group();
zup.rotation.x = -Math.PI / 2;
scene.add(zup);

const ground = (() => {
  // 0.5 m minor and 1 m major lines, drawn once into a tiling texture (one tile = 2 m)
  const n = 512, c = Object.assign(document.createElement('canvas'), { width: n, height: n }), g = c.getContext('2d');
  g.fillStyle = '#16191d'; g.fillRect(0, 0, n, n);
  const line = (p, w, a) => { g.fillStyle = `rgba(230,236,245,${a})`; g.fillRect(p - w / 2, 0, w, n); g.fillRect(0, p - w / 2, n, w); };
  for (let i = 0; i < 4; i++) line((i * n) / 4, 1.5, 0.05);
  for (let i = 0; i < 2; i++) line((i * n) / 2, 2.5, 0.1);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(50, 50);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  m.receiveShadow = true;
  zup.add(m);
  return m;
})();

function tag(text) {
  // a small rounded label that always faces the camera
  const c = Object.assign(document.createElement('canvas'), { width: 256, height: 72 }), g = c.getContext('2d');
  g.font = '600 34px Inter, system-ui, sans-serif';
  const w = Math.min(248, g.measureText(text).width + 36);
  g.fillStyle = 'rgba(13,15,18,0.86)';
  g.beginPath(); g.roundRect(128 - w / 2, 8, w, 56, 28); g.fill();
  g.fillStyle = '#e8ecf2'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 37);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(0.72, 0.2, 1);
  return s;
}

// ---------------------------------------------------------------------------------------------------------- state
const S = {
  source: null, client: null, health: null, hello: null, episode: null, status: null, scenes: [],
  ticks: [], plans: [], events: [], // the current run, in order
  disp: null, rate: 0, prod: 1, view: 'live', replaySpeed: 1, // live (follow the newest tick) | review (scrubbed) | replay
  arrivals: [], shown: null, planCursor: -1, eventCursor: -1, edit: null, recorded: null, runs: [],
  goalHint: true, lastDrive: false,
};
const ui = { candidates: !coarse, plan: true, route: true, ghosts: false, reference: false, trail: true };
let hero, inputGhost, endGhost, refGhost;
let LOCAL = null; // ./local.js when this machine's server serves the page (raw rule names, plan times, refine switch)

// ---------------------------------------------------------------------------------------------------------- overlays
const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const fan = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false }));
const path = new THREE.Line(new THREE.BufferGeometry(), lineMat(HUE.plan, 1));
const route = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: HUE.route, dashSize: 0.14, gapSize: 0.1, transparent: true, opacity: 0.4 }));
const trail = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 2048), 3));
  g.setDrawRange(0, 0);
  return new THREE.Line(g, lineMat(HUE.trail, 0.22));
})();
const goalRing = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.3, 48), new THREE.MeshBasicMaterial({ color: HUE.goal, transparent: true, opacity: 0.95, depthWrite: false }));
const goalZone = new THREE.Mesh(new THREE.RingGeometry(0.385, 0.4, 72), new THREE.MeshBasicMaterial({ color: HUE.goal, transparent: true, opacity: 0.35, depthWrite: false }));
const nextReplan = new THREE.Mesh(new THREE.CircleGeometry(0.055, 24), new THREE.MeshBasicMaterial({ color: HUE.plan, depthWrite: false }));
const steer = (() => {
  const s = new THREE.Shape();
  s.moveTo(0.22, 0); s.lineTo(-0.08, 0.11); s.lineTo(-0.02, 0); s.lineTo(-0.08, -0.11); s.closePath();
  return new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshBasicMaterial({ color: HUE.plan, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
})();
const markers = new THREE.Group(); // recorded mode: the goals that have a recorded run
for (const o of [fan, path, route, trail, goalRing, goalZone, nextReplan, steer]) { o.visible = false; o.renderOrder = 2; zup.add(o); }
zup.add(markers);

function setPolyline(line, xy, z, dashed = false) {
  const a = new Float32Array((xy.length / 2) * 3);
  for (let i = 0, j = 0; i + 1 < xy.length; i += 2, j += 3) { a[j] = xy[i]; a[j + 1] = xy[i + 1]; a[j + 2] = z; }
  updateAttribute(line.geometry, 'position', a);
  line.geometry.setDrawRange(0, a.length / 3);
  line.geometry.computeBoundingSphere();
  if (dashed) {
    const distances = new Float32Array(xy.length / 2);
    for (let i = 1; i < distances.length; i++) distances[i] = distances[i - 1] + Math.hypot(xy[2 * i] - xy[2 * i - 2], xy[2 * i + 1] - xy[2 * i - 1]);
    updateAttribute(line.geometry, 'lineDistance', distances, 1);
  }
}
function updateAttribute(geometry, name, values, itemSize = 3) {
  let attribute = geometry.getAttribute(name);
  if (!attribute || attribute.array.length !== values.length) {
    // Reallocate only when the topology changes; dispose old GPU buffers first.
    geometry.dispose();
    attribute = new THREE.BufferAttribute(new Float32Array(values), itemSize);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
  } else {
    attribute.array.set(values);
    attribute.needsUpdate = true;
  }
}
const planFrame = (p, f) => p.qpos.slice(f * NQ, f * NQ + NQ);

function drawPlan(p) {
  const pos = [], col = [], white = new THREE.Color(HUE.cand), red = new THREE.Color(HUE.bad);
  for (const pool of p.pools || []) {
    const F = pool.frames;
    for (let k = 0; k < pool.n; k++) {
      if (pool.start + k === p.choice) continue;
      const bad = pool.clear[k] < p.margin_m, c = bad ? red : white, a = bad ? 0.75 : 0.32;
      for (let j = 0; j + 1 < F; j++) {
        const o = (k * F + j) * 2;
        pos.push(pool.xy[o], pool.xy[o + 1], 0.01, pool.xy[o + 2], pool.xy[o + 3], 0.01);
        col.push(c.r * a, c.g * a, c.b * a, c.r * a, c.g * a, c.b * a);
      }
    }
  }
  updateAttribute(fan.geometry, 'position', pos);
  updateAttribute(fan.geometry, 'color', col);
  fan.geometry.setDrawRange(0, pos.length / 3);
  fan.geometry.computeBoundingSphere();
  const xy = [];
  for (let f = 0; f < p.frames; f++) xy.push(p.qpos[f * NQ], p.qpos[f * NQ + 1]);
  setPolyline(path, xy, 0.014);
  setPolyline(route, p.route, 0.008, true);
  steer.position.set(p.local_goal[0], p.local_goal[1], 0.016);
  steer.rotation.z = p.local_goal[2];
  const k = Math.min(p.frames - 1, p.next_due);
  nextReplan.position.set(p.qpos[k * NQ], p.qpos[k * NQ + 1], 0.016);
  inputGhost.pose(p.anchor_q);
  endGhost.pose(planFrame(p, p.frames - 1));
  S.shown = p;
  needsRender = true;
}

// ---------------------------------------------------------------------------------------------------------- obstacles
const obstacles = new THREE.Group();
zup.add(obstacles);
let solids = [];
// Only for scene-owned geometry/materials; robot meshes share their model resources.
function disposeGroup(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    const materials = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const material of materials) { material.map?.dispose(); material.dispose(); }
  });
  group.clear();
  needsRender = true;
}
function buildObstacles(boxes, editing = false) {
  disposeGroup(obstacles);
  occlusionDirty = true;
  renderer.shadowMap.needsUpdate = true;
  solids = boxes.map((b, i) => {
    const h = b.z_top - b.z_bottom, over = b.z_bottom > 0.05;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2 * b.half_xy[0], 2 * b.half_xy[1], h),
      new THREE.MeshStandardMaterial({ color: over ? 0x6b5a4c : 0x3f454d, roughness: 0.7, metalness: 0.05, transparent: true }));
    mesh.position.set(b.center_xy[0], b.center_xy[1], b.z_bottom + h / 2);
    mesh.rotation.z = b.yaw;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.index = i;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), lineMat(0xffffff, editing ? 0.4 : 0.1));
    mesh.add(edges);
    obstacles.add(mesh);
    if (over) {
      const t = tag(`${b.z_bottom.toFixed(2)} m`);
      t.position.set(b.center_xy[0], b.center_xy[1], b.z_top + 0.22);
      obstacles.add(t);
    }
    return { mesh, edges, box: b, glow: 0 };
  });
}
const _ray = new THREE.Raycaster(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
function seeThrough(q) {
  // obstacles between the camera and the robot fade, so walls never hide it
  const hit = new Set(), meshes = solids.map((s) => s.mesh);
  for (const z of [0.3, 0.75, 1.2]) {
    _b.set(q[0], q[1], z).applyMatrix4(zup.matrixWorld);
    _a.subVectors(_b, camera.position);
    _ray.set(camera.position, _a.clone().normalize());
    _ray.far = Math.max(0, _a.length() - 0.25);
    for (const h of _ray.intersectObjects(meshes, false)) hit.add(h.object.userData.index);
  }
  occlusionDirty = false;
  for (const s of solids) {
    const m = s.mesh.material, want = hit.has(s.mesh.userData.index) ? 0.2 : 1;
    const previous = m.opacity;
    m.opacity = Math.abs(want - m.opacity) < 0.001 ? want : m.opacity + (want - m.opacity) * 0.2;
    if (m.opacity !== previous) needsRender = true;
    if (m.opacity !== want) occlusionDirty = true;
    m.depthWrite = m.opacity > 0.95;
  }
}
function glowContacts(q, force, dt) {
  for (const s of solids) {
    if (force > 5) {
      const b = s.box, c = Math.cos(-b.yaw), sn = Math.sin(-b.yaw), dx = q[0] - b.center_xy[0], dy = q[1] - b.center_xy[1];
      const ex = Math.abs(c * dx - sn * dy) - b.half_xy[0], ey = Math.abs(sn * dx + c * dy) - b.half_xy[1];
      if (Math.hypot(Math.max(ex, 0), Math.max(ey, 0)) < 0.7) s.glow = 0.5;
    }
    const previous = s.glow;
    s.glow = Math.max(0, s.glow - dt);
    if (previous !== s.glow) needsRender = true;
    s.mesh.material.emissive.setHex(HUE.bad);
    s.mesh.material.emissiveIntensity = s.glow;
  }
}

// ---------------------------------------------------------------------------------------------------------- run data
function resetRun() {
  S.ticks = []; S.plans = []; S.events = []; S.disp = null; S.arrivals = [];
  S.shown = null; S.planCursor = -1; S.eventCursor = -1; S.trailAt = -1;
  S.marksKey = null;
  posedTime = null;
  lastDisplayedTime = null;
  needsRender = true;
  for (const o of [fan, path, route, steer, nextReplan]) o.visible = false;
  trace.length = 0;
  el('trace').innerHTML = '';
  el('marks').innerHTML = '';
  el('caption').classList.remove('on');
  el('toast').classList.remove('on');
}
function addTicks(list) {
  const last = S.ticks.length ? S.ticks[S.ticks.length - 1].tick : -1;
  for (const f of list) if (f.tick > last || !S.ticks.length) S.ticks.push(f);
  if (S.ticks.length > MAX_TICKS_KEPT) S.ticks.splice(0, S.ticks.length - MAX_TICKS_KEPT);
  if (S.ticks.length) S.arrivals.push([performance.now() / 1000, S.ticks[S.ticks.length - 1].t]);
}
const sceneOf = (id) => S.scenes.find((s) => s.id === id);

// live stream handlers
const on = {
  hello(h) {
    S.hello = h;
    S.scenes = h.scenes;
    document.body.classList.toggle('public', !!h.public);
    if (h.last_frame && h.last_frame.mode !== 'idle') hideHint();
    renderScenes();
    on.episode(h.episode, true);
    if (h.last_plan) S.plans.push(h.last_plan);
    if (h.last_frame) addTicks([h.last_frame]);
    on.status(h.status);
    setLoad('load-link', 1, h.public ? 'live · this lab machine' : 'live · local');
    ready();
  },
  episode(e, fresh = false) {
    const newRun = fresh || !S.episode || e.episode !== S.episode.episode;
    S.episode = e;
    needsRender = true;
    if (newRun) { resetRun(); if (!S.edit) buildObstacles(e.boxes); }
    renderScenes();
    renderControls();
  },
  frames: addTicks,
  plan: (p) => S.plans.push(p),
  event: (e) => { S.events.push(e); if (e.type === 'goal') hideHint(); },
  status(s) {
    S.status = s;
    el('busy').classList.toggle('on', !!s.busy && !s.paused);
    if (s.error && s.error !== S.lastError) { toast('The simulation hit an error and restarted.', true); S.lastError = s.error; }
    renderLink();
  },
  down(closed) {
    renderLink(true);
    if (closed) setTimeout(() => S.source && S.source.kind === 'live' && S.source.connect(), 3000);
  },
};

// ---------------------------------------------------------------------------------------------------------- playback
function productionRate(now, planning) {
  S.arrivals = S.arrivals.filter((a) => now - a[0] <= 8);
  const span = planning ? 6 : 1.5, rec = S.arrivals.filter((a) => now - a[0] <= span);
  if (rec.length < 2) return S.prod || 1;
  const a = rec[0], b = rec[rec.length - 1];
  return b[0] - a[0] > 0.5 ? Math.max(0.01, (b[1] - a[1]) / (b[0] - a[0])) : (S.prod || 1);
}
function advance(dt) {
  if (!S.ticks.length) return;
  const head = S.ticks[S.ticks.length - 1].t, first = S.ticks[0].t;
  if (S.disp === null) S.disp = S.view === 'replay' ? first : head;
  if (S.view === 'live') {
    const st = S.status || {}, planning = ['navigate', 'settle'].includes(st.mode) && !st.paused;
    const target = planning ? 1.2 * (S.shown ? S.shown.next_due : 8) * DT : 0.06; // keep about one replan buffered
    // Standing still before a new goal is not worth watching in slow motion: jump to where the walking starts.
    const i = tickIndex(S.disp);
    if (['idle', 'hold'].includes(S.ticks[i].mode)) {
      for (let k = i + 1; k < S.ticks.length; k++) {
        if (S.ticks[k].mode === 'navigate') { S.disp = Math.max(S.disp, S.ticks[k].t - 0.04); break; }
      }
    }
    const lag = head - S.disp;
    if (lag > Math.max(3, 6 * target)) S.disp = head - target;
    S.prod = productionRate(performance.now() / 1000, planning);
    const cap = lag > 2 * target ? 1.5 : 1;
    const want = Math.min(cap, Math.max(0, S.prod * (1 + 0.6 * (lag - target) / Math.max(target, 0.05))));
    S.rate += (want - S.rate) * Math.min(1, dt * 2.5);
    if (lag <= 0.002) S.rate = Math.min(S.rate, S.prod);
    S.disp = Math.min(head, S.disp + S.rate * dt);
  } else if (S.view === 'replay') {
    S.rate = S.replaySpeed;
    S.disp = Math.min(head, S.disp + S.replaySpeed * dt);
    if (S.disp >= head) {
      if (S.source && S.source.kind === 'live') setView('live');
      else { S.view = 'review'; renderPlayback(); }
    }
  } else S.rate = 0;
  S.disp = Math.max(first, S.disp);
}
function tickIndex(t) {
  let lo = 0, hi = S.ticks.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S.ticks[m].t <= t) lo = m; else hi = m - 1; }
  return lo;
}
function latestAt(list, t) {
  let lo = 0, hi = list.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].t <= t + 1e-9) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

// ---------------------------------------------------------------------------------------------------------- HUD
const RULE = {
  nearest_safe: 'Clears the margin', nearest_safe_checked: 'Clears the margin, checked', resampled: 'Resampled', resampled_checked: 'Resampled, checked',
  stop: 'Fallback · most clearance', stop_checked: 'Fallback · most clearance', most_clearance: 'Most clearance', most_clearance_checked: 'Most clearance',
  committed: 'Committed', committed_checked: 'Committed', continue: 'Continue', duck_release: 'Duck release', duck_release_checked: 'Duck release', stand: 'Stand',
};
function ruleText(r) {
  // the public server and recorded runs use the vocabulary above; the local server sends the planner's own names
  if (RULE[r]) return RULE[r];
  const k = LOCAL && LOCAL.ruleKey(r);
  return k ? RULE[k] : r.replace(/_/g, ' ');
}
const holding = (r) => /stop|clearance/.test(r);
function skills(p) {
  const s = [];
  if (p.duck) s.push('duck');
  if (p.flags && (p.flags.side || p.flags.gate_side)) s.push('side-step');
  else if (p.flags && p.flags.narrow) s.push('narrow');
  else if (p.flags && p.flags.tight) s.push('arms in');
  return s;
}
function caption(p, t) {
  // one plain sentence for what the planner is doing right now
  if (!p) return '';
  const boxes = (S.episode && S.episode.boxes) || [];
  if (holding(p.rule)) return 'No forward plan clears the margin · trying a fallback';
  if (p.flags && (p.flags.side || p.flags.gate_side)) {
    const g = p.flags.gate_gap_m;
    return g && g < 1 ? `Turning sideways through a ${g.toFixed(2)} m gap` : 'Turning sideways through the gap';
  }
  if (p.duck) {
    const q = p.anchor_q, over = boxes.filter((b) => b.z_bottom > 0.05)
      .map((b) => ({ b, d: Math.hypot(b.center_xy[0] - q[0], b.center_xy[1] - q[1]) })).sort((a, c) => a.d - c.d)[0];
    return over ? `Ducking under the ${over.b.z_bottom.toFixed(2)} m bar` : 'Ducking under an overhead';
  }
  if (p.flags && p.flags.narrow) return 'Narrow passage · arms tucked, tighter margins';
  if (p.flags && p.flags.tight) return 'Tight passage · arms in front';
  return '';
}
const trace = [];
function logLine(iconName, title, detail, bad = false) {
  trace.unshift({ iconName, title, detail, bad });
  trace.length = Math.min(trace.length, 6);
  el('trace').innerHTML = trace.map((l) => `<li class="${l.bad ? 'bad' : ''}">${icon(l.iconName, 14)}<b>${esc(l.title)}</b><span>${esc(l.detail)}</span></li>`).join('');
}
function planIcon(p) {
  if (holding(p.rule)) return 'triangle-alert';
  const s = skills(p);
  if (s.includes('side-step')) return 'move-horizontal';
  if (s.includes('duck')) return 'arrow-down-to-line';
  if (s.length) return 'shrink';
  return 'footprints';
}
function logPlan(p) {
  const s = skills(p), clear = p.chosen_clearance_m == null ? '' : ` · ${p.chosen_clearance_m.toFixed(2)} m clear`;
  const secs = LOCAL ? LOCAL.planSeconds(p) : '';
  logLine(planIcon(p), ruleText(p.rule) + (s.length ? ` · ${s.join(' · ')}` : ''), `${p.safe}/${p.candidates} pass${clear}${secs}`, holding(p.rule));
}
function logEvent(e, notify = true) {
  if (e.type === 'goal') logLine('flag', 'New goal', `${e.xy[0].toFixed(1)}, ${e.xy[1].toFixed(1)} m`);
  else if (e.type === 'reached') {
    const g = [...S.events].reverse().find((x) => x.type === 'goal' && x.t <= e.t), dur = e.t - (g ? g.t : 0);
    logLine('flag', 'Entered goal region', `${dur.toFixed(1)} s`);
    if (notify) toast(`Entered the goal region in ${dur.toFixed(1)} s · settling`);
  }
  else if (e.type === 'contact') logLine('triangle-alert', 'Touched an obstacle', `${e.force_n} N`, true);
  else if (e.type === 'fall') { logLine('triangle-alert', 'Fell', `pelvis ${e.height_m} m`, true); if (notify) toast('The robot fell. Reset to try again.', true); }
  else if (e.type === 'push') logLine('zap', 'Shoved', `${Math.hypot(...e.dv).toFixed(1)} m/s`);
  else if (e.type === 'finished') logLine(e.outcome === 'reached' ? 'flag' : 'triangle-alert', OUTCOME[e.outcome] || e.outcome, 'Recording ended', e.outcome !== 'reached');
  else if (e.type === 'scene_refused' && notify) toast('That layout could not start in the simulator; back to the default scene.', true);
}
function rebuildTrace(t) {
  trace.length = 0;
  el('trace').innerHTML = '';
  S.planCursor = latestAt(S.plans, t);
  S.eventCursor = latestAt(S.events, t);
  const entries = [
    ...S.plans.slice(0, S.planCursor + 1).filter((p) => p.tick > 0).map((p) => ({ t: p.t, plan: p })),
    ...S.events.slice(0, S.eventCursor + 1).filter((e) => ['goal', 'reached', 'contact', 'fall', 'push', 'finished'].includes(e.type)).map((e) => ({ t: e.t, event: e })),
  ].sort((a, b) => a.t - b.t).slice(-6);
  for (const entry of entries) entry.plan ? logPlan(entry.plan) : logEvent(entry.event, false);
}
let toastTimer;
function toast(text, bad = false) {
  const t = el('toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 3200);
}

const MODE = { idle: 'Standing · waiting for a goal', navigate: 'Walking to the goal', settle: 'Stopping at the goal', hold: 'Standing', fallen: 'Fallen' };
const OUTCOME = { reached: 'Reached the goal', contact: 'Obstacle contact', fall: 'Fell', time_limit: 'Time limit · goal not reached', stopped_near_goal: 'Stopped near the goal' };
let hudClock = 0;
function hud(dt, f, p) {
  hudClock += dt;
  if (hudClock < 0.1) return;
  hudClock = 0;
  const mode = f ? f.mode : 'idle';
  const atEnd = S.recorded && S.episode?.meta && S.disp >= S.ticks.at(-1).t - 1e-6;
  let state = MODE[mode] || mode;
  if (mode === 'hold' && S.events.some((e) => e.type === 'reached' && e.t <= S.disp + 1e-9)) {
    const goal = S.episode?.goal;
    state = goal && f && Math.hypot(f.q[0] - goal[0], f.q[1] - goal[1]) > 0.4 ? 'Stopped near the goal' : 'At the goal';
  }
  if (mode === 'navigate' && p && holding(p.rule)) state = 'Trying a fallback motion';
  else if (mode === 'navigate' && p && p.tick > 0 && skills(p).length) state = `Walking · ${skills(p).join(' · ')}`;
  if (atEnd) state = OUTCOME[S.episode.meta.outcome] || state;
  if (S.status && S.status.paused && S.view === 'live') state = `Paused · ${state}`;
  el('state').textContent = state;
  el('speed').textContent = f ? `${f.speed.toFixed(2)} m/s` : '–';
  el('plans').textContent = p ? p.n : 0;
  const r = Math.min(1, S.rate);
  el('rtf').textContent = S.view === 'live' ? `${r >= 0.995 ? '1' : r.toFixed(2)}×` : S.view === 'replay' ? `${S.replaySpeed}× replay` : 'paused';
  el('viewers').textContent = S.status && S.status.viewers != null ? S.status.viewers : '–';
  const newest = S.ticks.length ? S.ticks[S.ticks.length - 1].mode : mode;
  const cap = atEnd ? (OUTCOME[S.episode.meta.outcome] || '') : caption(mode === 'navigate' || mode === 'settle' ? p : null) ||
    (S.view === 'live' && newest === 'navigate' && (mode === 'idle' || mode === 'hold') ? 'Planning the first step…' : '');
  if (cap) el('caption').textContent = cap; // keep the last words while it fades out
  el('caption').classList.toggle('on', !!cap);
  // plan bar: the plan being tracked, the playhead inside it, the next replan
  const bar = el('planbar');
  if (p && f && p.tick <= f.tick && (mode === 'navigate' || mode === 'settle' || mode === 'hold')) {
    const off = f.tick - p.tick, n = p.frames;
    bar.style.setProperty('--at', `${Math.min(1, off / (n - 1)) * 100}%`);
    bar.style.setProperty('--next', `${Math.min(1, p.next_due / (n - 1)) * 100}%`);
    bar.classList.remove('idle');
    el('plan-label').textContent = mode === 'hold' ? `plan ${p.n} · held at its last frame` : `plan ${p.n} · ${(n * DT).toFixed(1)} s ahead · ${p.candidates} candidates · ${ruleText(p.rule)}`;
  } else {
    bar.classList.add('idle');
    el('plan-label').textContent = mode === 'fallen' ? 'fallen' : 'no plan · standing';
  }
  // run bar
  if (S.ticks.length) {
    const t0 = S.ticks[0].t, t1 = Math.max(t0 + 1, S.ticks[S.ticks.length - 1].t), span = t1 - t0;
    const runbar = el('runbar');
    runbar.style.setProperty('--head', `${(100 * (S.ticks[S.ticks.length - 1].t - t0)) / span}%`);
    runbar.style.setProperty('--at', `${(100 * (S.disp - t0)) / span}%`);
    const key = `${S.plans.length}/${S.events.length}/${Math.round(span)}`;
    if (key !== S.marksKey) {
      S.marksKey = key;
      const pct = (t) => (100 * (Number(t) - t0)) / span;
      const m = S.plans.filter((x) => x.tick > 0 && x.t >= t0).map((x) => `<i style="left:${pct(x.t)}%"></i>`);
      for (const e of S.events) if (['reached', 'fall', 'contact'].includes(e.type) && e.t >= t0) m.push(`<i class="ev ${e.type === 'reached' ? '' : 'bad'}" style="left:${pct(e.t)}%"></i>`);
      el('marks').innerHTML = m.join('');
    }
    el('run-time').textContent = `${(S.disp - t0).toFixed(1)} / ${span.toFixed(1)} s`;
  }
}

// ---------------------------------------------------------------------------------------------------------- frame loop
const _q = new Float64Array(NQ);
let camFollow = null;
let posedTime = null, lastDisplayedTime = null;
function follow(q, dt) {
  const p = new THREE.Vector3(q[0], 0.8, -q[1]);
  if (!camFollow) {
    camFollow = p.clone(); controls.target.copy(p); camera.position.set(p.x - 3.4, 3.9, p.z + 4.6);
    key.position.set(p.x + 4, 9, p.z + 3); key.target.position.copy(p);
    needsRender = renderer.shadowMap.needsUpdate = true;
    return;
  }
  const k = 1 - Math.exp(-dt * 4); // smooth, so a shove or a stumble does not jerk the view
  const d = p.clone().sub(camFollow).multiplyScalar(k);
  if (d.lengthSq() < 1e-10) return;
  camFollow.add(d);
  controls.target.add(d);
  camera.position.add(d);
  key.position.set(camFollow.x + 4, 9, camFollow.z + 3);
  key.target.position.copy(camFollow);
  needsRender = renderer.shadowMap.needsUpdate = true;
}

function frame(dt) {
  advance(dt);
  if (!hero || !S.ticks.length) return;
  const i = tickIndex(S.disp), a = S.ticks[i], b = S.ticks[Math.min(i + 1, S.ticks.length - 1)];
  const u = b.t > a.t ? Math.min(1, Math.max(0, (S.disp - a.t) / (b.t - a.t))) : 0;
  const q = lerpQpos(a.q, b.q, u, _q);
  const poseChanged = S.disp !== posedTime;
  if (poseChanged) {
    hero.pose(q);
    posedTime = S.disp;
    needsRender = renderer.shadowMap.needsUpdate = true;
  }
  follow(q, dt);
  const pi = latestAt(S.plans, S.disp), p = pi >= 0 ? S.plans[pi] : null;
  if (p && p !== S.shown) drawPlan(p);
  if (!p) S.shown = null;
  if (lastDisplayedTime === null || S.disp < lastDisplayedTime || (S.view === 'review' && S.disp !== lastDisplayedTime)) {
    rebuildTrace(S.disp);
  } else if (S.view !== 'review') {
    for (let k = S.planCursor + 1; k <= pi; k++) if (S.plans[k].tick > 0 || S.plans.length === 1) logPlan(S.plans[k]);
    for (let k = S.eventCursor + 1; k < S.events.length && S.events[k].t <= S.disp + 1e-9; k++) { logEvent(S.events[k]); S.eventCursor = k; }
  }
  S.planCursor = pi;
  lastDisplayedTime = S.disp;
  const planning = a.mode === 'navigate' || a.mode === 'settle', show = !!p && planning;
  fan.visible = ui.candidates && show;
  path.visible = steer.visible = nextReplan.visible = ui.plan && show;
  route.visible = ui.route && show;
  inputGhost.visible = endGhost.visible = ui.ghosts && show;
  refGhost.visible = ui.reference && !!p && a.mode !== 'idle' && a.mode !== 'fallen';
  if (refGhost.visible) refGhost.pose(planFrame(p, Math.min(p.frames - 1, Math.max(0, a.tick - p.tick))));
  const goal = S.episode && S.episode.goal;
  goalRing.visible = goalZone.visible = !!goal && (a.mode !== 'idle' || S.view === 'live');
  if (goal) { goalRing.position.set(goal[0], goal[1], 0.015); goalZone.position.copy(goalRing.position); }
  markers.visible = !!S.recorded;
  if (poseChanged) for (const m of markers.children) m.rotation.z -= dt * 0.8;
  if (ui.trail && i !== S.trailAt) {
    S.trailAt = i;
    const buf = trail.geometry.attributes.position.array, n = Math.min(2048, Math.floor(i / 2) + 1), from = i - 2 * (n - 1);
    for (let k = 0; k < n; k++) { const f = S.ticks[Math.max(0, from + 2 * k)]; buf[3 * k] = f.q[0]; buf[3 * k + 1] = f.q[1]; buf[3 * k + 2] = 0.006; }
    trail.geometry.setDrawRange(0, n);
    trail.geometry.attributes.position.needsUpdate = true;
    trail.geometry.computeBoundingSphere();
  }
  trail.visible = ui.trail && i > 1;
  glowContacts(q, a.force, dt);
  if (!S.edit && (poseChanged || occlusionDirty)) seeThrough(q);
  hud(dt, a, p);
}

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(Math.max((now - last) / 1000, 1 / 240), 1 / 4);
  last = now;
  if (document.hidden) return;
  frame(dt);
  controls.update();
  if (needsRender) { renderer.render(scene, camera); needsRender = false; }
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  needsRender = true;
});

// ---------------------------------------------------------------------------------------------------------- driving
const live = () => S.source && S.source.kind === 'live';
const publicLive = () => live() && S.hello && S.hello.public;
const lease = () => (S.status && S.status.lease) || { driver: null };
const driving = () => !publicLive() || (S.client && lease().driver === S.client.handle);

// Send a world-changing command; on the public server, take the wheel first if nobody holds it.
async function act(op, extra = {}) {
  if (!live()) return false;
  if (publicLive() && !driving()) {
    if (lease().driver) { toast('Someone else is driving right now. You can watch; it frees up within a minute of them going idle.'); return false; }
    const r = await S.source.cmd('drive');
    if (!r.ok) { toast(r.error === 'someone else is driving' ? 'Someone else just took the wheel.' : `Could not take the wheel: ${r.error}`, true); return false; }
    if (r.lease) S.status = { ...(S.status || {}), lease: r.lease };
    renderLink();
  }
  const r = await S.source.cmd(op, extra);
  if (!r.ok) {
    if (r.status === 429) toast('A bit slower, please.');
    else toast(r.status === 0 ? 'The live server did not answer.' : `Not accepted: ${r.error}`, true);
    return false;
  }
  if (r.lease) S.status = { ...(S.status || {}), lease: r.lease };
  return true;
}
function renderLink(down = false) {
  const pill = el('link'), btn = el('wheel');
  let text, cls = 'live', showBtn = false, btnText = '';
  if (S.recorded && CONFIG.recordedOnly) { text = 'Recorded runs · click an amber ring to replay it'; cls = 'rec'; }
  else if (S.recorded) { text = 'Recorded runs · the live demo is offline'; cls = 'rec'; showBtn = true; btnText = 'Try live'; }
  else if (down) { text = 'Reconnecting to the live server…'; cls = 'down'; }
  else if (!publicLive()) text = 'Live · running on this machine';
  else {
    const L = lease(), n = (S.status && S.status.viewers) || 1, watching = n > 1 ? ` · ${n} watching` : '';
    if (driving()) { text = `Live · you're driving · ${fmt(Math.min(L.left_s, L.idle_left_s))} left${watching}`; showBtn = true; btnText = 'Hand back'; cls = 'live you'; }
    else if (L.driver) { text = `Live · someone is driving${watching}`; cls = 'live busy'; }
    else { text = `Live · click the floor to drive${watching}`; showBtn = true; btnText = 'Take the wheel'; }
  }
  if (S.lastDrive && publicLive() && !driving()) toast('Your turn ended. Click the floor to drive again.');
  S.lastDrive = publicLive() && driving();
  el('link-text').textContent = text;
  pill.className = `link ${cls}`;
  btn.hidden = !showBtn;
  btn.textContent = btnText;
  document.body.classList.toggle('watching', publicLive() && !driving());
  document.body.classList.toggle('recorded', !!S.recorded);
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
el('wheel').onclick = async () => {
  if (S.recorded) return goLive(true);
  if (driving()) { S.lastDrive = false; await S.source.cmd('release'); return; }
  const r = await S.source.cmd('drive');
  if (!r.ok) toast(r.error === 'someone else is driving' ? 'Someone else just took the wheel.' : `Could not take the wheel: ${r.error}`, true);
};

// ---------------------------------------------------------------------------------------------------------- views
function setView(v) {
  S.view = v;
  needsRender = true;
  renderPlayback();
}
function renderPlayback() {
  el('to-live').classList.toggle('on', S.view === 'live');
  el('to-live').hidden = !live();
  el('play').innerHTML = icon(S.view === 'replay' ? 'pause' : 'play', 13);
  el('play').title = S.view === 'replay' ? 'Pause the replay' : 'Replay this run';
  el('play').setAttribute('aria-label', el('play').title);
  if (S.recorded) {
    const paused = S.view !== 'replay';
    el('pause').querySelector('.lbl').textContent = paused ? 'Resume' : 'Pause';
    el('pause').querySelector('[data-icon]').innerHTML = icon(paused ? 'play' : 'pause');
  }
}
function seekTo(time) {
  if (!S.ticks.length) return;
  S.disp = Math.max(S.ticks[0].t, Math.min(S.ticks[S.ticks.length - 1].t, time));
  rebuildTrace(S.disp);
  lastDisplayedTime = S.disp;
  el('toast').classList.remove('on');
  needsRender = true;
}
(function scrub() {
  const bar = el('runbar');
  let dragging = false;
  const seek = (e) => {
    if (!S.ticks.length) return;
    const r = bar.getBoundingClientRect(), t0 = S.ticks[0].t, t1 = Math.max(t0 + 1, S.ticks[S.ticks.length - 1].t);
    seekTo(t0 + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (t1 - t0));
    setView('review');
  };
  bar.addEventListener('pointerdown', (e) => { dragging = true; bar.setPointerCapture(e.pointerId); seek(e); });
  bar.addEventListener('pointermove', (e) => dragging && seek(e));
  bar.addEventListener('pointerup', () => { dragging = false; });
  bar.addEventListener('pointercancel', () => { dragging = false; });
})();
el('play').onclick = () => {
  if (!S.ticks.length) return;
  if (S.view === 'replay') return setView('review');
  if (S.view === 'live' || S.disp >= S.ticks[S.ticks.length - 1].t - 1e-6) seekTo(S.ticks[0].t);
  setView('replay');
};
el('to-live').onclick = () => setView('live');
el('rate').onclick = () => {
  S.replaySpeed = S.replaySpeed === 1 ? 2 : S.replaySpeed === 2 ? 0.5 : 1;
  el('rate').textContent = `${S.replaySpeed}×`;
};

// ---------------------------------------------------------------------------------------------------------- input
const ndc = (e) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
function onFloor(e) {
  _ray.setFromCamera(ndc(e), camera);
  _ray.far = Infinity;
  const h = _ray.intersectObject(ground)[0];
  return h ? zup.worldToLocal(h.point.clone()) : null;
}
function obstacleAt(e) {
  _ray.setFromCamera(ndc(e), camera);
  _ray.far = Infinity;
  const h = _ray.intersectObjects(solids.map((s) => s.mesh), false)[0];
  return h ? h.object.userData.index : null;
}
let press = null, dragBox = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary) { press = null; return; }
  press = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (S.edit) {
    const k = obstacleAt(e), p = onFloor(e);
    pick(k);
    if (k !== null && p) {
      const b = S.edit.boxes[k];
      dragBox = { k, dx: b.center_xy[0] - p.x, dy: b.center_xy[1] - p.y };
      controls.enabled = false;
    }
  }
});
renderer.domElement.addEventListener('pointercancel', () => {
  press = dragBox = null;
  controls.enabled = true;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragBox) return;
  const p = onFloor(e);
  if (!p) return;
  const b = S.edit.boxes[dragBox.k];
  b.center_xy = [Math.round((p.x + dragBox.dx) * 20) / 20, Math.round((p.y + dragBox.dy) * 20) / 20];
  solids[dragBox.k].mesh.position.set(b.center_xy[0], b.center_xy[1], solids[dragBox.k].mesh.position.z);
  needsRender = renderer.shadowMap.needsUpdate = true;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (dragBox) { dragBox = null; controls.enabled = true; buildObstacles(S.edit.boxes, true); pick(S.edit.sel); press = null; return; }
  if (!press) return;
  const tap = Math.hypot(e.clientX - press.x, e.clientY - press.y) < 8 && performance.now() - press.t < 450;
  press = null;
  if (!tap || S.edit) return;
  const p = onFloor(e);
  if (p) clickFloor(p.x, p.y);
});
async function clickFloor(x, y) {
  if (S.recorded) {
    const near = S.recorded.markers.map((m) => ({ m, d: Math.hypot(m.goal[0] - x, m.goal[1] - y) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 1.2) return playRecorded(near.m.file);
    return toast(CONFIG.recordedOnly ? 'Each amber ring is a recorded run. Click one to replay it.'
      : 'The live demo is offline, so only the marked goals have runs. Pick an amber ring.');
  }
  if (S.status && S.status.mode === 'fallen') return toast('The robot fell. Reset to try again.', true);
  if (S.view !== 'live') setView('live');
  if (await act('goal', { xy: [Math.round(x * 100) / 100, Math.round(y * 100) / 100] })) hideHint();
}
function cameraForward() {
  const d = new THREE.Vector3().subVectors(controls.target, camera.position), l = Math.hypot(d.x, d.z) || 1;
  return [d.x / l, -d.z / l];
}
const shove = () => { const f = cameraForward(); act('push', { dv: [0.6 * f[0], 0.6 * f[1]] }); };
function hideHint() { if (S.goalHint) { S.goalHint = false; el('hint').classList.remove('on'); } }

addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.closest('input, textarea, select, [contenteditable="true"]') || el('about').open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (t.closest('button, summary') && ['Space', 'Enter'].includes(e.code)) return;
  if (e.repeat) return;
  if (e.code === 'Space') e.preventDefault();
  if (S.edit) return editKey(e);
  if (e.code === 'Space') {
    if (S.recorded) return el('play').click();
    act('pause', { value: !(S.episode && S.episode.paused) });
  } else if (e.code === 'KeyR') resetScene();
  else if (e.code === 'Escape') S.recorded ? setView('review') : act('stop');
  else if (e.code === 'KeyF') shove();
  else if (e.code === 'KeyE') startEdit();
  else if (/^Digit[1-8]$/.test(e.code)) { const s = S.scenes[Number(e.code.slice(5)) - 1]; if (s) chooseScene(s.id); }
});
addEventListener('pointerup', (e) => { const c = e.target.closest && e.target.closest('button, input[type=checkbox]'); if (c) setTimeout(() => c.blur(), 0); });

// ---------------------------------------------------------------------------------------------------------- editor
function pick(k) {
  if (!S.edit) return;
  needsRender = true;
  S.edit.sel = k;
  solids.forEach((s, i) => { s.edges.material.color.setHex(i === k ? HUE.plan : 0xffffff); s.edges.material.opacity = i === k ? 1 : 0.4; });
}
function startEdit() {
  if (S.edit || !S.episode || !live()) return;
  if (publicLive() && !driving() && lease().driver) return toast('Someone else is driving; you can edit once it is your turn.');
  S.edit = { boxes: JSON.parse(JSON.stringify(S.episode.boxes)), sel: null };
  document.body.classList.add('editing');
  buildObstacles(S.edit.boxes, true);
}
function endEdit(apply) {
  if (!S.edit) return;
  const boxes = S.edit.boxes;
  S.edit = null;
  document.body.classList.remove('editing');
  buildObstacles(S.episode.boxes);
  if (apply) act('reset', { boxes });
}
function editKey(e) {
  if (e.key === 'Escape') return endEdit(false);
  const k = S.edit.sel;
  if (k === null || k === undefined) return;
  const b = S.edit.boxes[k];
  if (e.code === 'KeyQ' || e.code === 'KeyW') b.yaw += (e.code === 'KeyQ' ? 1 : -1) * (Math.PI / 12);
  else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const d = e.code === 'BracketLeft' ? -0.05 : 0.05;
    if (b.z_bottom > 0.05) { b.z_bottom = Math.min(2.2, Math.max(0.4, b.z_bottom + d)); b.z_top = b.z_bottom + 0.2; }
    else b.z_top = Math.min(2.5, Math.max(0.1, b.z_top + d));
  } else if (e.code === 'Delete' || e.code === 'Backspace') { S.edit.boxes.splice(k, 1); S.edit.sel = null; }
  else return;
  e.preventDefault();
  buildObstacles(S.edit.boxes, true);
  pick(S.edit.sel);
}
function addObstacle(kind) {
  if (!S.edit || S.edit.boxes.length >= 40) return;
  const t = zup.worldToLocal(controls.target.clone());
  const [sx, sy, z0, z1] = { box: [0.5, 0.5, 0, 1.0], wall: [0.16, 2.0, 0, 1.6], bar: [0.2, 1.8, 1.15, 1.35] }[kind];
  S.edit.boxes.push({ center_xy: [Math.round(t.x * 20) / 20 + 1, Math.round(t.y * 20) / 20], half_xy: [sx / 2, sy / 2], yaw: 0, z_bottom: z0, z_top: z1 });
  buildObstacles(S.edit.boxes, true);
  pick(S.edit.boxes.length - 1);
}
el('edit').onclick = () => (S.edit ? endEdit(false) : startEdit());
el('edit-apply').onclick = () => endEdit(true);
el('edit-cancel').onclick = () => endEdit(false);
for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => addObstacle(b.dataset.add);

// ---------------------------------------------------------------------------------------------------------- panel
function chooseScene(id) {
  if (S.recorded) return showRecordedScene(id, true);
  act('reset', { scene: id });
}
function resetScene() {
  if (S.recorded) { if (S.ticks.length) seekTo(S.ticks[0].t); return setView('replay'); }
  act('reset');
}
function renderScenes() {
  const box = el('scenes');
  if (box.childElementCount !== S.scenes.length) {
    box.innerHTML = '';
    S.scenes.forEach((s, i) => {
      const b = document.createElement('button');
      b.dataset.scene = s.id;
      b.title = `${s.name}: ${s.skills.join(', ')} (key ${i + 1})`;
      b.innerHTML = `<span>${esc(s.name)}</span><small>${esc(s.skills.join(' · '))}</small>`;
      b.onclick = () => chooseScene(s.id);
      box.appendChild(b);
    });
  }
  const cur = S.recorded ? S.recorded.scene : S.episode && S.episode.scene;
  for (const b of box.children) b.classList.toggle('on', b.dataset.scene === cur);
  for (const b of box.children) b.classList.toggle('loading', b.dataset.scene === S.pendingScene);
  const s = sceneOf(cur);
  el('blurb').textContent = s ? s.blurb : cur === 'custom' ? 'Your own layout.' : '';
}
function segmented(id, options, current, pickValue) {
  const box = el(id);
  box.innerHTML = '';
  for (const [value, text, title] of options) {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title || '';
    b.classList.toggle('on', value === current);
    b.onclick = () => pickValue(value);
    box.appendChild(b);
  }
}
function renderControls() {
  const e = S.episode;
  if (!e) return;
  segmented('replan', [[8, '0.16 s', 'as evaluated'], [16, '0.32 s'], [24, '0.48 s']], e.replan_ticks, (v) => act('option', { key: 'replan_ticks', value: v }));
  segmented('speedcap', [[1, '1×'], [0.5, '½×'], [0.25, '¼×']], e.speed, (v) => act('speed', { value: v }));
  if (LOCAL) LOCAL.syncPlannerSwitch(e);
  el('pause').querySelector('.lbl').textContent = e.paused ? 'Resume' : 'Pause';
  el('pause').querySelector('[data-icon]').innerHTML = icon(e.paused ? 'play' : 'pause');
}
function buildPanel() {
  for (const n of document.querySelectorAll('[data-icon]')) n.innerHTML = icon(n.dataset.icon, Number(n.dataset.size) || 16);
  if (LOCAL) LOCAL.addPlannerSwitch(el('planner-local'), act);
  const toggles = [['candidates', 'Candidate motions', 'cand'], ['plan', 'Chosen plan & steering', 'plan'], ['route', 'Route', 'route'],
    ['ghosts', 'Predicted planner poses', 'input'], ['reference', 'Pose SONIC tracks', 'plan'], ['trail', 'Trail', 'trail']];
  for (const [k, text, sw] of toggles) {
    const l = document.createElement('label');
    l.innerHTML = `<span><i class="sw sw-${sw}"></i>${text}</span><input type="checkbox" role="switch" ${ui[k] ? 'checked' : ''}>`;
    l.querySelector('input').onchange = (ev) => { ui[k] = ev.target.checked; needsRender = true; };
    el('overlays').appendChild(l);
  }
  el('pause').onclick = () => (S.recorded ? el('play').click() : act('pause', { value: !(S.episode && S.episode.paused) }));
  el('reset').onclick = resetScene;
  el('shove').onclick = shove;
  el('menu').onclick = () => document.body.classList.toggle('side-closed');
  if (matchMedia('(max-width: 760px)').matches) document.body.classList.add('side-closed');
  el('splash-skip').onclick = () => document.body.classList.add('dismissed');
  const about = el('about');
  el('about-open').onclick = () => about.showModal();
  el('about-close').onclick = () => about.close();
  about.onclick = (e) => { if (e.target === about) about.close(); };
  renderPlayback();
}

// ---------------------------------------------------------------------------------------------------------- recorded mode
let recordedRequest = 0;
async function goRecorded(why) {
  recordedRequest++;
  if (S.source && S.source.close) S.source.close();
  const rec = new RecordedSource(CONFIG.data, coarse ? 2 : 4, 'learned-generator', CONFIG.dataVersion);
  S.source = rec;
  S.runs = await rec.index();
  if (!S.runs.length) throw new Error('No recorded runs found. Please retry.');
  if (!S.scenes.length) S.scenes = SCENE_FALLBACK.filter((s) => S.runs.some((r) => r.scene === s.id));
  S.recorded = { scene: null, markers: [], why };
  setLoad('load-link', 1, 'recorded runs');
  renderLink();
  renderScenes();
  const first = FEATURED.find((id) => S.runs.some((r) => r.scene === id)) || S.runs[0].scene;
  if (!await showRecordedScene(first, true)) throw new Error('Could not load the first run. Please retry.');
  ready();
}
async function showRecordedScene(id, autoplay) {
  const runs = S.runs.filter((r) => r.scene === id);
  if (!runs.length) return toast('No recorded run for this playground yet.');
  if (autoplay) return playRecorded(runs[0].file);
  S.recorded.scene = id;
  S.recorded.markers = runs.map((r) => ({ goal: r.goal, file: r.file }));
  disposeGroup(markers);
  for (const r of runs) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.32, 40, 1, 0, Math.PI * 1.6), new THREE.MeshBasicMaterial({ color: HUE.goal, transparent: true, opacity: 0.7, depthWrite: false }));
    m.position.set(r.goal[0], r.goal[1], 0.012);
    markers.add(m);
  }
  renderScenes();
}
async function playRecorded(file) {
  const source = S.source, request = ++recordedRequest;
  if (source?.kind !== 'recorded') return false;
  S.pendingScene = S.runs.find((r) => r.file === file)?.scene;
  el('scenes').setAttribute('aria-busy', 'true');
  renderScenes();
  let run;
  try { run = await source.run(file); } catch (e) {
    if (request === recordedRequest) toast(`Could not load that run (${e.message}). Select it again to retry.`, true);
    return false;
  } finally {
    if (request === recordedRequest) {
      S.pendingScene = null;
      el('scenes').setAttribute('aria-busy', 'false');
      renderScenes();
    }
  }
  // A slower response must never replace a more recent scene or live connection.
  if (request !== recordedRequest || source !== S.source || !S.recorded) return false;
  if (run.meta.scene !== S.recorded.scene) showRecordedScene(run.meta.scene, false);
  S.episode = { boxes: run.boxes, goal: run.meta.goal, scene: run.meta.scene, episode: file, meta: run.meta, replan_ticks: 8, speed: 1, paused: false };
  const meta = run.meta, provenance = meta.provenance;
  el('run-result').hidden = !provenance;
  if (provenance) {
    el('run-result').dataset.outcome = meta.outcome;
    el('outcome').textContent = `Recorded outcome: ${OUTCOME[meta.outcome] || meta.outcome}`;
    el('run-detail').textContent = `One fixed-seed attempt · ${meta.final_distance_m.toFixed(2)} m from goal at end`;
    el('model-summary').textContent = `Model: Flow whole-body planner · checkpoint ${provenance.checkpoint_sha256.slice(0, 12)}. The same weights and settings are used in every scene. See the repository's model card for the checkpoint comparison and full outcomes.`;
  }
  resetRun();
  buildObstacles(run.boxes);
  S.ticks = run.frames;
  S.plans = run.plans;
  S.events = run.events;
  S.status = { mode: 'hold', viewers: null };
  S.disp = S.ticks[0].t;
  camFollow = null;
  setView('replay');
  hideHint();
  return true;
}
async function goLive(manual = false) {
  if (CONFIG.server === null) return goRecorded('off');
  setLoad('load-link', 0.3, 'looking for the live server…');
  const h = await probe(CONFIG.server);
  if (!h || (h.max_viewers && h.viewers >= h.max_viewers)) {
    if (manual) toast(h ? 'The live demo is full right now. Try again in a minute.' : 'The live demo is still offline.', true);
    if (!S.recorded) await goRecorded(h ? 'full' : 'offline');
    return;
  }
  S.health = h;
  recordedRequest++;
  S.source?.close?.();
  S.pendingScene = null;
  el('scenes').setAttribute('aria-busy', 'false');
  if (S.recorded) { S.recorded = null; disposeGroup(markers); }
  S.source = new LiveSource(CONFIG.server, S.client, on);
  S.source.connect();
  setView('live');
  renderLink();
}
const FEATURED = ['open', 'empty', 'slalom', 'lowbar', 'corridor', 'gate', 'clutter', 'course']; // introduce navigation before the stress tests
// scene names for the recorded mode when the live server never answered (mirrors playground/scenes.py)
const SCENE_FALLBACK = [ // keep in step with scenes.py
  ['open', 'Open floor', ['walk', 'turn'], 'A few boxes on an open floor.'], ['slalom', 'Slalom', ['weave', 'turn'], 'Walls that leave a 0.87 m opening on alternating sides.'],
  ['lowbar', 'Low bar', ['overhead test'], 'A 1.12 m beam. Tests learned lowering without a scripted duck target.'],
  ['corridor', 'Narrow corridor', ['clearance test'], '0.80 m, then 0.62 m between walls. No arm-position preset.'],
  ['gate', 'Shoulder gate', ['posture test'], 'A 0.40 m arm-height slot, open at the legs. No forced sideways turn or retrieved motion.'],
  ['clutter', 'Clutter', ['weave'], 'Scattered boxes with at least 0.75 m spacing.'], ['course', 'Course', ['combined test'], 'Slalom, a low bar, and boxes before the goal.'],
  ['empty', 'Empty', ['walk'], 'Nothing but floor.'],
].map(([id, name, sk, blurb]) => ({ id, name, skills: sk, blurb, goal: [0, 0] }));

// ---------------------------------------------------------------------------------------------------------- start
function setLoad(id, frac, text) {
  const row = el(id);
  row.querySelector('i').style.width = `${Math.round(frac * 100)}%`;
  if (text) row.querySelector('em').textContent = text;
}
function ready() {
  if (hero && (S.hello || (S.recorded && S.ticks.length))) {
    document.body.classList.add('ready');
    if (S.goalHint && !S.recorded) el('hint').classList.add('on');
  }
}

async function start() {
  document.body.classList.toggle('static-site', CONFIG.recordedOnly);
  if (CONFIG.local) LOCAL = await import('./local.js');
  buildPanel();
  S.client = await clientIdentity();
  const modelP = loadRobotModel(CONFIG.model, (got, total) => setLoad('load-model', total ? (0.95 * got) / total : 0.5,
    `${(got / 1e6).toFixed(1)}${total ? ` / ${(total / 1e6).toFixed(1)}` : ''} MB`));
  // Observe both startup promises immediately, including early network failures.
  const linkP = goLive().then(() => null, (error) => error);
  const model = await modelP;
  hero = new Robot(model, { material: solidMaterials() });
  inputGhost = new Robot(model, { lod: 'lite', material: ghostMaterial(HUE.input, 0.18), shadows: false });
  endGhost = new Robot(model, { lod: 'lite', material: ghostMaterial(HUE.plan, 0.26), shadows: false });
  refGhost = new Robot(model, { lod: 'lite', material: ghostMaterial(HUE.plan, 0.12), shadows: false });
  for (const g of [inputGhost, endGhost, refGhost]) { g.visible = false; g.root.renderOrder = 3; zup.add(g.root); }
  zup.add(hero.root);
  setLoad('load-model', 1, `ready · ${(model.bytes / 1e6).toFixed(1)} MB`);
  document.body.classList.add('model-ready');
  const linkError = await linkP;
  if (linkError) throw linkError;
  ready();
  window.NAV = { S, ui, camera, controls, act, cmd: (op, x) => S.source.cmd(op, x), playRecorded, goLive, goRecorded,
    stats: () => ({ ...renderer.info.memory, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      renderedFrames: renderer.info.render.frame, cachedRuns: S.source.cache?.size || 0 }) };
}
start().catch((e) => {
  console.error(e);
  el('load-error').textContent = `${String(e.message || e)} Check your connection and retry.`;
  el('load-retry').hidden = false;
});
el('load-retry').onclick = () => location.reload();
