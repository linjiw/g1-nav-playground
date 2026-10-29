// Where the robot comes from: a live server (this machine's planner + SONIC, over Server-Sent Events) or recorded runs
// (static JSON next to the page, used when the live server is offline or full).

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// A per-tab secret: it identifies this page to the server's driver lease. Its public name (`handle`) is a hash.
export async function clientIdentity() {
  let id = null;
  try { id = sessionStorage.getItem('g1nav-client'); } catch { /* storage blocked */ }
  if (!id || !/^[0-9a-f]{32}$/.test(id)) {
    id = hex(crypto.getRandomValues(new Uint8Array(16)));
    try { sessionStorage.setItem('g1nav-client', id); } catch { /* storage blocked */ }
  }
  let handle = null;
  if (crypto.subtle) handle = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)))).slice(0, 10);
  return { id, handle };
}

async function fetchJSON(url, ms = 30000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// Is a live server reachable at `base`? Resolves to its health record, or null.
export async function probe(base, ms = 4500) {
  try {
    const h = await fetchJSON(`${base}/api/health`, ms, { cache: 'no-store' });
    return h && h.ok ? h : null;
  } catch { return null; }
}

export class LiveSource {
  constructor(base, client, on) {
    this.base = base;
    this.client = client;
    this.on = on; // { hello, episode, frames, plan, event, status, down }
    this.es = null;
    this.kind = 'live';
  }
  connect() {
    this.close();
    const es = new EventSource(`${this.base}/api/stream?client=${encodeURIComponent(this.client.id)}`);
    const route = (name) => es.addEventListener(name, (m) => { try { this.on[name](JSON.parse(m.data)); } catch (e) { console.error(name, e); } });
    for (const k of ['hello', 'episode', 'frames', 'plan', 'event', 'status']) route(k);
    es.onerror = () => this.on.down && this.on.down(es.readyState === EventSource.CLOSED);
    this.es = es;
  }
  close() { if (this.es) { this.es.close(); this.es = null; } }
  async cmd(op, extra = {}) {
    try {
      const r = await fetch(`${this.base}/api/cmd`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': this.client.id },
        body: JSON.stringify({ op, ...extra }),
      });
      const body = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, ...body };
    } catch (e) {
      return { ok: false, status: 0, error: 'the live server did not answer' };
    }
  }
}

export class RecordedSource {
  constructor(base, maxCachedRuns = 4, expectedProfile = null, version = '') {
    this.base = base;
    this.kind = 'recorded';
    this.cache = new Map();
    this.maxCachedRuns = maxCachedRuns;
    this.expectedProfile = expectedProfile;
    this.query = version ? `?v=${encodeURIComponent(version)}` : '';
  }
  async index() {
    if (!this._index) this._index = fetchJSON(`${this.base}/runs/index.json${this.query}`).catch((e) => {
      this._index = null;
      throw e;
    });
    return this._index;
  }
  async run(file) {
    let pending = this.cache.get(file);
    if (!pending) pending = fetchJSON(`${this.base}/runs/${file}${this.query}`).then((run) => {
      if (!run.meta || !Array.isArray(run.boxes) || !run.frames?.length ||
          !Array.isArray(run.plans) || !Array.isArray(run.events) ||
          run.frames.some((f) => !Number.isFinite(f.t) || f.q?.length !== 36 || !f.q.every(Number.isFinite))) {
        throw new Error('Invalid recorded run');
      }
      if (this.expectedProfile) {
        const p = run.meta.provenance;
        if (p?.profile !== this.expectedProfile || !/^[0-9a-f]{64}$/.test(p.checkpoint_sha256) ||
            ['guidance', 'pose_overrides', 'retrieval', 'pose_refinement', 'leg_ik'].some((key) => p[key] !== false)) {
          throw new Error('This recording does not match the learned-planner edition');
        }
      }
      return run;
    }).catch((e) => {
      if (this.cache.get(file) === pending) this.cache.delete(file);
      throw e;
    });
    // Keep recently used runs, without retaining every scene's decoded motion data.
    this.cache.delete(file);
    this.cache.set(file, pending);
    while (this.cache.size > this.maxCachedRuns) this.cache.delete(this.cache.keys().next().value);
    return pending;
  }
}
