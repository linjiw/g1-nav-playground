// The robot's meshes and kinematic tree (navloop.export_model): int16 vertices over each mesh's bounding box, uint16
// faces, two levels of detail. A Robot is one posed copy (the hero or a ghost) built from them.

import * as THREE from 'three';
import { Kinematics } from './kin.js';

async function download(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const total = Number(r.headers.get('Content-Length')) || 0;
  if (!r.body || !r.body.getReader) return r.arrayBuffer();
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const buf = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.length; }
  return buf.buffer;
}

function geometry(blob, d) {
  const qv = new Int16Array(blob, d.v, d.nv * 3), pos = new Float32Array(d.nv * 3);
  for (let i = 0; i < d.nv; i++) {
    for (let k = 0; k < 3; k++) pos[3 * i + k] = d.lo[k] + (qv[3 * i + k] + 32768) * d.scale[k];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(blob, d.f, d.nf * 3), 1));
  g.computeVertexNormals();
  return g;
}

export async function loadRobotModel(base, onProgress = () => {}) {
  const manifest = await (await fetch(`${base}.json`)).json();
  const blob = await download(`${base}.bin`, onProgress);
  const geo = { full: new Map(), lite: new Map() };
  for (const [id, m] of Object.entries(manifest.meshes)) {
    geo.full.set(Number(id), geometry(blob, m.full));
    geo.lite.set(Number(id), geometry(blob, m.lite));
  }
  return { manifest, geo, bytes: blob.byteLength };
}

export class Robot {
  constructor(model, { lod = 'full', material, shadows = true }) {
    this.kin = new Kinematics(model.manifest.bodies);
    this.root = new THREE.Group();
    this.links = model.manifest.bodies.map(() => {
      const g = new THREE.Group();
      g.matrixAutoUpdate = true;
      this.root.add(g);
      return g;
    });
    for (const gm of model.manifest.geoms) {
      const mesh = new THREE.Mesh(model.geo[lod].get(gm.mesh), material(gm.rgba));
      mesh.position.fromArray(gm.pos);
      mesh.quaternion.set(gm.quat[1], gm.quat[2], gm.quat[3], gm.quat[0]);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      this.links[gm.body].add(mesh);
    }
  }
  // Pose every link from a joint state (36 numbers).
  pose(q) {
    const { pos, quat } = this.kin.forward(q);
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i];
      l.position.set(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
      l.quaternion.set(quat[4 * i + 1], quat[4 * i + 2], quat[4 * i + 3], quat[4 * i]);
    }
    return this;
  }
  set visible(v) { this.root.visible = v; }
  get visible() { return this.root.visible; }
}

export function solidMaterials() {
  const cache = new Map();
  return (rgba) => {
    const key = rgba.join('/');
    if (!cache.has(key)) {
      const c = new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace);
      cache.set(key, new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.2 }));
    }
    return cache.get(key);
  };
}

export function ghostMaterial(color, opacity) {
  const m = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.45, transparent: true, opacity, depthWrite: false });
  return () => m;
}
