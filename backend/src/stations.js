import { readFileSync } from 'node:fs';

/**
 * All NOAA water-level stations, loaded from data/stations.json
 */
const raw = JSON.parse(
  readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8')
);

export const STATIONS = Object.fromEntries(
  raw.map((s) => [String(s.id), {
    id: String(s.id),
    name: s.name,
    state: s.state,
    lat: s.lat,
    lng: s.lng,
  }])
);

const LOCATION_STATIONS = {
  // The Battery, Sandy Hook, Kings Point
  nyc: { label: 'New York City', stations: ['8518750', '8531680', '8516945'] },
};

export function isValidStation(stationId) {
  return String(stationId) in STATIONS;
}

export function getStationName(stationId) {
  const s = STATIONS[String(stationId)];
  return s ? `${s.name} : ${s.state}` : null;
}

export function getStationLocation(stationId) {
  const id = String(stationId);
  const entry = Object.entries(LOCATION_STATIONS).find(([, loc]) => loc.stations.includes(id));
  return entry ? entry[0] : null;
}

export function getStationsForLocation(loc) {
  const key = Object.keys(LOCATION_STATIONS).find((k) => k.toLowerCase() === String(loc).toLowerCase());
  return key ? LOCATION_STATIONS[key].stations.map((id) => STATIONS[id]).filter(Boolean) : [];
}

