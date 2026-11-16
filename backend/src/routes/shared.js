// Helpers shared by more than one route module.
import { getDatumError } from '../stations.js';

/**
 * Response fields every readings endpoint includes. Every reading also carries
 * datum/units, but these make the basis explicit at the top level; retrievedAt
 * records when NOAA's preliminary/verified flags were observed, which matters
 * for settlement.
 */
export const meta = (resolution, datum) => ({
  resolution,
  datum, // the station's datum; for a location, the one its gauges share (null if they differ)
  units: 'english',
  timeZone: 'GMT',
  retrievedAt: new Date().toISOString(),
});

/**
 * Read the optional `?datum=` (MSL or NAVD88). Without it each station uses its
 * default (MSL where it has one). `datumOf(station)` is the datum a station's
 * readings will be on; `shared` is the one all the stations use, or null.
 *
 * @returns {{ error: string } | { requested?: string, datumOf: Function, shared: string|null }}
 */
export function parseDatumQuery(query, stations) {
  const requested = query.datum;
  const error = getDatumError(requested);
  if (error) return { error };
  const datumOf = (s) => requested ?? s.datum;
  const all = stations.map(datumOf);
  return { requested, datumOf, shared: all.every((d) => d === all[0]) ? all[0] ?? null : null };
}
