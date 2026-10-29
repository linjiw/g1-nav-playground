import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordedSource, probe } from '../js/source.js';

const run = () => ({ meta: { scene: 'empty' }, boxes: [], frames: [{ t: 0, q: Array(36).fill(0) }], plans: [], events: [] });

test('a failed download is retryable and concurrent requests share a download', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? new Response('', { status: 503 }) : Response.json(run()));
  const source = new RecordedSource('data');
  await assert.rejects(source.run('empty-0.json'), /503/);
  const [a, b] = await Promise.all([source.run('empty-0.json'), source.run('empty-0.json')]);
  assert.equal(a, b);
  assert.equal(requests, 2);
});
test('cache retains recently used runs within its memory limit', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(run()); });
  const source = new RecordedSource('data', 2);
  await source.run('a'); await source.run('b'); await source.run('a'); await source.run('c');
  assert.equal(source.cache.size, 2);
  assert.ok(source.cache.has('a'));
  assert.ok(!source.cache.has('b'));
  await source.run('b');
  assert.equal(requests, 4);
});
test('invalid runs do not poison future retries', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++requests === 1 ? { ...run(), frames: [] } : run()));
  const source = new RecordedSource('data');
  await assert.rejects(source.run('empty'), /Invalid recorded run/);
  assert.equal((await source.run('empty')).frames.length, 1);
});
test('an index failure is retryable', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? new Response('', { status: 503 }) : Response.json([{ file: 'empty' }]));
  const source = new RecordedSource('data');
  await assert.rejects(source.index());
  assert.equal((await source.index()).length, 1);
});
test('health timeout aborts a stalled response body as well as the request', async (t) => {
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  }) }));
  assert.equal(await probe('http://localhost', 20), null);
  assert.ok(aborted);
});
