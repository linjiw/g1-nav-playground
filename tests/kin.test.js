import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerpQpos } from '../js/kin.js';

const pose = (quat) => [0, 0, 0.8, ...quat, ...Array(29).fill(0)];
test('equivalent quaternion signs do not collapse or flip the robot', () => {
  const a = pose([0.5, 0.5, 0.5, 0.5]), b = pose([-0.5, -0.5, -0.5, -0.5]);
  for (const u of [0, 0.25, 0.5, 0.75, 1]) {
    const q = lerpQpos(a, b, u, new Float64Array(36));
    assert.deepEqual([...q.slice(3, 7)], a.slice(3, 7));
  }
});
test('interpolation follows the shortest rotation and preserves position and joints', () => {
  const a = pose([1, 0, 0, 0]), b = pose([0, 0, 0, 1]);
  b[0] = 2; b[7] = 0.4;
  const q = lerpQpos(a, b, 0.5, new Float64Array(36));
  assert.equal(q[0], 1);
  assert.equal(q[7], 0.2);
  assert.ok(Math.abs(q[3] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(q[6] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...q.slice(3, 7)) - 1) < 1e-12);
});
