import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const read = async (file) => JSON.parse(await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
test('all twelve goals use the same audited checkpoint, preserve failures, and match the model card', async () => {
  const model = await read('data/planner.json'), index = await read('data/runs/index.json');
  assert.equal(index.length, 12);
  assert.equal(new Set(index.map((r) => r.scene)).size, 8);
  assert.equal(new Set(index.map((r) => r.file)).size, 12);
  for (const entry of index) {
    const bytes = await fs.readFile(new URL(`../data/runs/${entry.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), model.run_sha256[entry.file]);
    const run = JSON.parse(bytes), m = run.meta, p = m.provenance;
    assert.equal(p.checkpoint_sha256, model.checkpoint_sha256);
    assert.equal(p.profile, 'learned-generator');
    assert.equal(p.attempt, 1); assert.equal(p.episode_seed, 1); assert.equal(p.noise_episode, 1);
    for (const key of ['guidance', 'pose_overrides', 'retrieval', 'pose_refinement', 'leg_ik']) assert.equal(p[key], false);
    for (const plan of run.plans) {
      for (const key of ['tight', 'narrow', 'side', 'gate_side']) assert.equal(plan.flags[key], false);
      assert.equal(plan.duck, false);
      assert.ok(['nearest_safe', 'resampled', 'stop', 'most_clearance'].includes(plan.rule));
      assert.ok(plan.pools.every((pool) => ['go', 'stop'].includes(pool.kind)));
      for (const pool of plan.pools) {
        assert.equal(pool.xy.length, pool.n * pool.frames * 2);
        assert.ok(pool.frames >= 2);
      }
      assert.equal(plan.qpos.length, plan.frames * 36);
    }
    const contacts = run.events.some((e) => e.type === 'contact'), fall = run.events.some((e) => e.type === 'fall');
    assert.equal(m.contact_ticks > 0, contacts); assert.equal(m.fell, fall);
    assert.equal(m.outcome, entry.outcome); assert.equal(m.outcome, model.outcomes[entry.file]);
    const distance = Math.hypot(...m.goal.map((x, i) => x - run.frames.at(-1).q[i]));
    assert.ok(Math.abs(distance - m.final_distance_m) < 0.0001);
    assert.equal(m.clean, m.outcome === 'reached');
    if (m.clean) {
      assert.ok(distance < 0.4); assert.ok(!contacts && !fall);
      assert.equal(run.frames.at(-1).mode, 'hold');
      assert.ok(run.events.some((e) => e.type === 'reached'));
    }
    assert.equal(run.events.at(-1).outcome, m.outcome);
  }
});
