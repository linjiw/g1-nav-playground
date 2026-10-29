// Forward kinematics of the G1 from its joint state (MuJoCo qpos: root xyz, root quat wxyz, 29 hinges), using the
// kinematic tree exported from the compiled MjModel (navloop.export_model). Same algorithm as mj_kinematics for a free
// root and one hinge per body; checked against MuJoCo to 1e-15 (tools/kin_check.mjs).

const qmul = (a, b, o) => {
  const [w1, x1, y1, z1] = a, [w2, x2, y2, z2] = b;
  o[0] = w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2;
  o[1] = w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2;
  o[2] = w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2;
  o[3] = w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2;
  return o;
};
const qrot = (q, v, o) => {
  // v + 2 u x (u x v + w v), u = (x, y, z)
  const [w, x, y, z] = q;
  const cx = y * v[2] - z * v[1] + w * v[0], cy = z * v[0] - x * v[2] + w * v[1], cz = x * v[1] - y * v[0] + w * v[2];
  o[0] = v[0] + 2 * (y * cz - z * cy);
  o[1] = v[1] + 2 * (z * cx - x * cz);
  o[2] = v[2] + 2 * (x * cy - y * cx);
  return o;
};

export class Kinematics {
  constructor(bodies) {
    this.bodies = bodies;
    this.n = bodies.length;
    this.pos = new Float64Array(this.n * 3);
    this.quat = new Float64Array(this.n * 4);
  }
  // Fills this.pos (n x 3) and this.quat (n x 4, wxyz) from qpos; returns this.
  forward(q) {
    const P = this.pos, Q = this.quat, t3 = [0, 0, 0], t4 = [0, 0, 0, 0], tq = [0, 0, 0, 0], a = [0, 0, 0];
    for (let b = 0; b < this.n; b++) {
      const B = this.bodies[b], j = B.joint;
      if (j && j.type === 'free') {
        const o = j.adr, l = Math.hypot(q[o + 3], q[o + 4], q[o + 5], q[o + 6]) || 1;
        P[3 * b] = q[o]; P[3 * b + 1] = q[o + 1]; P[3 * b + 2] = q[o + 2];
        for (let k = 0; k < 4; k++) Q[4 * b + k] = q[o + 3 + k] / l;
        continue;
      }
      const p = B.parent;
      const pq = p < 0 ? [1, 0, 0, 0] : [Q[4 * p], Q[4 * p + 1], Q[4 * p + 2], Q[4 * p + 3]];
      const pp = p < 0 ? [0, 0, 0] : [P[3 * p], P[3 * p + 1], P[3 * p + 2]];
      qrot(pq, B.pos, t3);
      let px = pp[0] + t3[0], py = pp[1] + t3[1], pz = pp[2] + t3[2];
      qmul(pq, B.quat, t4);
      if (j && j.type === 'hinge') {
        // rotate about the joint axis through its anchor, keeping the anchor fixed (as mj_kinematics does)
        qrot(t4, j.pos, a);
        const ax = px + a[0], ay = py + a[1], az = pz + a[2];
        const ang = q[j.adr] - j.q0, s = Math.sin(ang / 2);
        qmul([t4[0], t4[1], t4[2], t4[3]], [Math.cos(ang / 2), s * j.axis[0], s * j.axis[1], s * j.axis[2]], tq);
        t4[0] = tq[0]; t4[1] = tq[1]; t4[2] = tq[2]; t4[3] = tq[3];
        qrot(t4, j.pos, a);
        px = ax - a[0]; py = ay - a[1]; pz = az - a[2];
      }
      P[3 * b] = px; P[3 * b + 1] = py; P[3 * b + 2] = pz;
      Q[4 * b] = t4[0]; Q[4 * b + 1] = t4[1]; Q[4 * b + 2] = t4[2]; Q[4 * b + 3] = t4[3];
    }
    return this;
  }
}

// Joint-state interpolation for playback: root position and joints linearly, root orientation by slerp.
export function lerpQpos(a, b, u, out) {
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * u;
  let dot = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6];
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  if (dot < 0.9995) {
    const th = Math.acos(Math.min(1, dot)), s = Math.sin(th), wa = Math.sin((1 - u) * th) / s, wb = sign * Math.sin(u * th) / s;
    for (let k = 3; k < 7; k++) out[k] = wa * a[k] + wb * b[k];
  }
  return out;
}
