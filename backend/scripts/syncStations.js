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

const url = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels&expand=details';
const response = await fetch(url);
if (!response.ok) throw new Error(`NOAA Metadata API returned ${response.status} ${response.statusText}`);
const { stations } = await response.json();

const slim = stations.map((s) => ({
  id: s.id,
  name: s.name,
  state: s.state,
  lat: s.lat,
  lng: s.lng,
  established: s.details?.established ? s.details.established.slice(0, 10) : null, // "1920-05-24 00:00:00" -> "1920-05-24"
}));

writeFileSync('data/stations.json', `${JSON.stringify(slim, null, 2)}\n`);
console.log(`Wrote ${slim.length} stations to data/stations.json`);
