/**
 * Refresh data/stations.json from NOAA's Metadata API: every water-level station
 * with its name, state, coordinates and the date NOAA says it was established.
 *
 * Run from backend/:  node scripts/syncStations.js
 *
 * `established` is where "All history" starts looking for a station's data
 * (with a safety margin; see probeStartFor in src/noaa.js).
 */

// TODO: Add predictions variables

import { writeFileSync } from 'node:fs';

const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi';
// The bulk listing ignores expand=datums (it only returns a `self` link), so
// datums are fetched per station below.
const url = `${MDAPI}/stations.json?type=waterlevels&expand=details`;
const response = await fetch(url);
if (!response.ok) throw new Error(`NOAA Metadata API returned ${response.status} ${response.statusText}`);
const { stations } = await response.json();

// The datums we support. NOAA names NAVD as 'NAVD88'.
const WANTED_DATUMS = ['MSL', 'NAVD88'];

// Which of WANTED_DATUMS NOAA has a value for at this station, e.g. ['MSL', 'NAVD88'].
// Some stations list datum names with null values; those aren't usable, so skip them.
async function fetchDatums(id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${MDAPI}/stations/${id}/datums.json`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json();
      return (body.datums ?? []).filter((d) => d.value != null && WANTED_DATUMS.includes(d.name)).map((d) => d.name);
    } catch (err) {
      if (attempt === 3) {
        console.warn(`Station ${id}: could not fetch datums (${err.message})`);
        return [];
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

// Fetch with a small concurrency limit so we don't hammer NOAA.
const datumsById = new Map();
const queue = stations.map((s) => s.id);
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      datumsById.set(id, await fetchDatums(id));
    }
  }),
);

const slim = stations.map((s) => ({
  id: s.id,
  name: s.name,
  state: s.state,
  lat: s.lat,
  lng: s.lng,
  established: s.details?.established ? s.details.established.slice(0, 10) : null, // "1920-05-24 00:00:00" -> "1920-05-24"
  datums: datumsById.get(s.id) ?? [],
}));

writeFileSync('data/stations.json', `${JSON.stringify(slim, null, 2)}\n`);
const count = (name) => slim.filter((s) => s.datums.includes(name)).length;
console.log(`Wrote ${slim.length} stations to data/stations.json`);
console.log(`  MSL: ${count('MSL')}  NAVD88: ${count('NAVD88')}  neither: ${slim.filter((s) => !s.datums.length).length}`);