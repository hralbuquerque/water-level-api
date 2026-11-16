/**
 * Client for the water-level backend (routes in backend/src/routes/).
 *
 * In development every call goes to /api/..., which the Vite dev server proxies to
 * the Express API (see vite.config.js). A production build can point somewhere else
 * by setting VITE_API_BASE at build time, e.g. VITE_API_BASE=https://api.example.com.
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

/**
 * GET a backend path and return its JSON. Throws an Error carrying the API's own
 * `error` message on non-2xx responses.
 */
export async function getJson(path, { signal } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { signal });
  } catch (err) {
    // fetch only rejects when no response arrived at all (server down, wrong port, offline).
    // Aborts are rethrown untouched so callers can ignore them.
    if (err.name === 'AbortError') throw err;
    throw new Error('Could not reach the water-level API. Is the backend running? (cd backend && npm run dev)');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `The API returned ${response.status} ${response.statusText}`);
  }
  if (body === null) throw new Error('The API returned a response that was not JSON');
  return body;
}

/** Everything the location picker needs: named locations and every NOAA station. */
export function fetchDirectory({ signal } = {}) {
  return Promise.all([getJson('/locations', { signal }), getJson('/stations', { signal })]).then(
    ([l, s]) => ({ locations: l.locations, stations: s.stations }),
  );
}

/**
 * Readings for a location (all its gauges) or a single station over a date range.
 *
 * @param {{ type: 'location'|'station', id: string }} target
 * @param {{ start: string, end: string, resolution: string, datum?: string }} range - YYYY-MM-DD dates, or
 *   YYYY-MM-DDTHH:mm for a time range (UTC, inclusive),
 *   'auto' | '1min' | '6min' | 'hourly' | 'daily', and optionally 'MSL' | 'NAVD88'
 *   (omitted: each gauge's default, MSL)
 */
export function fetchHistorical(target, { start, end, resolution, datum }, { signal } = {}) {
  const base = target.type === 'location' ? `/locations/${encodeURIComponent(target.id)}` : `/stations/${encodeURIComponent(target.id)}`;
  const query = new URLSearchParams({ start, end, resolution });
  if (datum) query.set('datum', datum);
  return getJson(`${base}/historical?${query}`, { signal });
}

