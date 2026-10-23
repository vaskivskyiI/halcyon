// Request timings per route (in memory, since the server started) for the diagnostics page: what is slow.
const routes = new Map();
const started = Date.now();

export function recordTiming(req, status, ms) {
  const url = req.routeOptions?.url;
  if (!url || !url.startsWith('/api/') || url === '/api/ws') return;
  const key = `${req.method} ${url}`;
  let r = routes.get(key);
  if (!r) routes.set(key, r = { n: 0, errors: 0, max: 0, recent: [] });
  r.n++; if (status >= 500) r.errors++;
  r.max = Math.max(r.max, ms);
  r.recent.push(ms); if (r.recent.length > 200) r.recent.shift();
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

/** The slowest routes (by 95th percentile of the last 200 requests each). */
export function timingSummary(limit = 25) {
  return {
    sinceMinutes: Math.round((Date.now() - started) / 60e3),
    routes: [...routes].map(([route, r]) => ({ route, requests: r.n, errors: r.errors, p50ms: Math.round(pct(r.recent, 0.5)), p95ms: Math.round(pct(r.recent, 0.95)), maxMs: Math.round(r.max) }))
      .sort((a, b) => b.p95ms - a.p95ms).slice(0, limit),
  };
}
