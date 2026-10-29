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

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), ms); })]);
  } finally { clearTimeout(timer); }
}

// Is a live server reachable at `base`? Resolves to its health record, or null.
export async function probe(base, ms = 4500) {
  try {
    const r = await withTimeout(fetch(`${base}/api/health`, { cache: 'no-store' }), ms);
    if (!r.ok) return null;
    const h = await r.json();
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
  constructor(base) {
    this.base = base;
    this.kind = 'recorded';
    this.cache = new Map();
  }
  async index() {
    if (!this._index) this._index = fetch(`${this.base}/runs/index.json`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    return this._index;
  }
  async run(file) {
    if (!this.cache.has(file)) this.cache.set(file, fetch(`${this.base}/runs/${file}`).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${file}`);
      return r.json();
    }));
    return this.cache.get(file);
  }
}
