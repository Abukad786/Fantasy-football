// Fetch helpers. Everything goes through our server's /api relay.
// Last good responses are kept in localStorage so the app still opens offline.

const mem = new Map();

function store(key, val) {
  try { localStorage.setItem('gc:' + key, JSON.stringify({ t: Date.now(), v: val })); } catch {}
}
function load(key) {
  try { return JSON.parse(localStorage.getItem('gc:' + key))?.v ?? null; } catch { return null; }
}

export async function get(path, { persist = false, fresh = false } = {}) {
  if (!fresh && mem.has(path)) return mem.get(path);
  const p = (async () => {
    try {
      const res = await fetch(path);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (persist) store(path, data);
      return data;
    } catch (err) {
      mem.delete(path);
      const cached = persist ? load(path) : null;
      if (cached) return cached;
      throw err;
    }
  })();
  mem.set(path, p);
  return p;
}

export const fpl = {
  bootstrap: (o) => get('/api/fpl/bootstrap-static/', { persist: true, ...o }),
  fixtures: (o) => get('/api/fpl/fixtures/', { persist: true, ...o }),
  entry: (id, o) => get(`/api/fpl/entry/${id}/`, { persist: true, ...o }),
  history: (id, o) => get(`/api/fpl/entry/${id}/history/`, { persist: true, ...o }),
  transfers: (id, o) => get(`/api/fpl/entry/${id}/transfers/`, o),
  picks: (id, gw, o) => get(`/api/fpl/entry/${id}/event/${gw}/picks/`, { persist: true, ...o }),
  standings: (id, page = 1, o) => get(`/api/fpl/leagues-classic/${id}/standings/?page_standings=${page}`, { persist: true, ...o }),
  live: (gw, o) => get(`/api/fpl/event/${gw}/live/`, o),
  element: (id, o) => get(`/api/fpl/element-summary/${id}/`, o),
};

export const youtube = (c, o) =>
  get(`/api/youtube?${c.ytId ? `channel=${encodeURIComponent(c.ytId)}` : `handle=${encodeURIComponent(c.yt || '')}`}`, { persist: true, ...o });

export const news = (o) => get('/api/news', { persist: true, ...o });

export function clearMemory() { mem.clear(); }

/** Run async jobs with limited concurrency (be gentle with the FPL API). */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
      }
    })
  );
  return out;
}
