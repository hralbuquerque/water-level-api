import { readFileSync } from 'node:fs';

/**
 * Datums we serve readings on, most preferred first. Both are standard bases for
 * parametric triggers. NOAA names NAVD as NAVD88. Every station with NAVD88 also
 * has MSL, but the fallback keeps us safe if that ever changes.
 */
export const DATUM_PREFERENCE = ['MSL', 'NAVD88'];

/**
 * All NOAA water-level stations, loaded from data/stations.json
 */
const raw = JSON.parse(
  readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8')
);

const pickDatum = (s) => DATUM_PREFERENCE.find((d) => s.datums?.includes(d)) ?? null;

/**
 * Stations NOAA lists but we don't serve because they have neither MSL nor NAVD88
 * (Great Lakes stations use IGLD; some Puerto Rico and Niagara stations have no
 * published datums). Kept so requests for them get an explanation, not just a 404.
 */
const UNSUPPORTED = new Set(raw.filter((s) => !pickDatum(s)).map((s) => String(s.id)));

export function unsupportedStationError(stationId) {
  return UNSUPPORTED.has(String(stationId))
    ? `station ${stationId} has no ${DATUM_PREFERENCE.join(' or ')} datum, so it isn't supported`
    : 'unknown station';
}

/** Every station we serve, each with the one datum its readings are on. */
export const STATIONS = Object.fromEntries(
  raw.filter(pickDatum).map((s) => [String(s.id), {
    id: String(s.id),
    name: s.name,
    state: s.state,
    lat: s.lat,
    lng: s.lng,
    // YYYY-MM-DD NOAA lists as the station's start, or null. Approximate: some
    // stations have a little data from before it (see probeStartFor in noaa.js).
    established: s.established ?? null,
    datum: pickDatum(s), // what readings for this station are reported against
    datums: s.datums.filter((d) => DATUM_PREFERENCE.includes(d)), // all supported datums it has
    // Tide predictions NOAA publishes: 'harmonic' (every interval), 'subordinate'
    // (high/low only) or null (none)
    predictions: s.predictions ?? null,
  }])
);

const LOCATION_STATIONS = {
  // The Battery, Sandy Hook, Kings Point
  nyc: { label: 'New York City', stations: ['8518750', '8531680', '8516945'] },
};

export function isValidStation(stationId) {
  return String(stationId) in STATIONS;
}

/**
 * The datum to read this station on: `requested` (MSL or NAVD88) if the station
 * has it, or the station's default when nothing is requested. Throws for a station
 * we don't serve or one that lacks the requested datum.
 */
export function datumFor(stationId, requested) {
  const station = STATIONS[String(stationId)];
  if (!station) throw new Error(unsupportedStationError(stationId));
  if (requested == null) return station.datum;
  if (!station.datums.includes(requested)) {
    throw new Error(`station ${station.id} has no ${requested} datum (available: ${station.datums.join(', ')})`);
  }
  return requested;
}

/** Error message for a `datum` query value we don't recognize, or null if it's fine. */
export function getDatumError(datum) {
  return datum == null || DATUM_PREFERENCE.includes(datum) ? null : `datum must be one of: ${DATUM_PREFERENCE.join(', ')}`;
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


/**
 * Every named location with its gauges, in display order.
 */
export function listLocations() {
  return Object.entries(LOCATION_STATIONS).map(([id, loc]) => ({
    id,
    name: loc.label,
    stations: loc.stations.map((sid) => STATIONS[sid]).filter(Boolean),
  }));
}
