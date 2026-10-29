// Where the page finds its live server, robot model and recorded runs.
//   served by playground/server.py itself (local mode): the same origin;
//   a site built with a <meta name="g1nav-server"> (tools/build_site.py --live): that public server, recorded runs as
//   the fallback; a static site (the default build): recorded runs only, no server is ever contacted.
//   ?server=<url>   a live server on this computer (http://127.0.0.1:<port> or http://localhost:<port> only, so a link
//                   cannot point the page at someone else's server); ?server=off   recorded runs only

const params = new URLSearchParams(location.search);
const meta = (name) => { const m = document.querySelector(`meta[name="${name}"]`); return m ? m.content : null; };
const local = meta('g1nav-local') !== null;
const publicServer = meta('g1nav-server');

function chosenServer() {
  const fallback = local ? '' : publicServer;
  const s = params.get('server');
  if (s === null) return fallback;
  if (s === 'off') return null;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) && u.pathname === '/') return u.origin;
  } catch { /* not a URL */ }
  return fallback;
}

const server = chosenServer();
export const CONFIG = {
  local,
  recordedOnly: server === null,
  server,
  model: local ? '/api/model' : 'assets/robot',
  data: local ? '/data' : 'data',
};
