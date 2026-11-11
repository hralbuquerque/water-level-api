import { EARLIEST, fetchReadings, getDateRangeError, pickResolution, probeStartFor, RESOLUTIONS } from '../noaa.js';
import { STATIONS, getStationsForLocation, listLocations } from '../stations.js';

// Shared response fields. Every reading also carries datum/units, but these make the
// basis explicit at the top level; retrievedAt records when NOAA's preliminary/verified
// flags were observed, which matters for settlement.
const meta = (resolution) => ({
  resolution,
  datum: 'MLLW',
  units: 'english',
  timeZone: 'GMT',
  retrievedAt: new Date().toISOString(),
});

const RESOLUTION_NAMES = ['auto', ...Object.keys(RESOLUTIONS)].join(', ');

/**
 * Validate `start`, `end` and `resolution` query params for a set of stations.
 *
 * - The default resolution is 6min so API callers get full detail unless they opt out;
 *   `auto` steps down to hourly or daily for long ranges.
 * - `start=earliest` fetches each station's whole record: every station gets its own
 *   search start from its `established` date (see probeStartFor). With `auto` this
 *   always means daily data, since a full record is years to decades long.
 *
 * @returns {{ error: string } | { end: string, resolution: string, starts: string[], earliest: boolean }}
 *   `starts[i]` is where to begin fetching for `stations[i]`
 */
function parseRangeQuery(query, stations) {
  const { start, end, resolution: requested = '6min' } = query;
  const earliest = start === EARLIEST;

  // Never search past `end`: a station established after it then simply has no data
  const starts = stations.map((s) => {
    if (!earliest) return start;
    const probe = probeStartFor(s.established);
    return end && probe > end ? end : probe;
  });
  const firstStart = starts.reduce((a, b) => (a < b ? a : b));

  const basicError = getDateRangeError(firstStart, end, 'daily'); // format/order/future checks, no span cap
  if (basicError) return { error: basicError };

  const resolution = earliest && requested === 'auto' ? 'daily' : pickResolution(firstStart, end, requested);
  if (!resolution) return { error: `resolution must be one of: ${RESOLUTION_NAMES}` };

  const spanError = getDateRangeError(firstStart, end, resolution);
  if (spanError) {
    return { error: earliest ? `${spanError}. A full record needs resolution=daily or auto.` : spanError };
  }

  return { end, resolution, starts, earliest };
}

/**
 * The `start` to report. For a fixed start that's the requested date; for
 * `earliest` it's the date of the oldest reading actually found, so clients can
 * label and scale to the real record rather than the search window.
 */
function reportedStart(range, query, readingLists) {
  if (!range.earliest) return query.start;
  const firstDates = readingLists.filter((r) => r?.length).map((r) => r[0].t.slice(0, 10));
  return firstDates.length ? firstDates.reduce((a, b) => (a < b ? a : b)) : range.starts.reduce((a, b) => (a < b ? a : b));
}

export function setupRoutes(app) {
  // Named locations and their gauges, e.g. nyc -> The Battery, Sandy Hook, Kings Point
  app.get('/locations', (req, res) => {
    res.json({ locations: listLocations() });
  });

  // Every NOAA water-level station this API can serve
  app.get('/stations', (req, res) => {
    res.json({ stations: Object.values(STATIONS) });
  });

  // All gauges for a location
  app.get('/locations/:loc/historical', async (req, res) => {
    const stations = getStationsForLocation(req.params.loc);
    if (stations.length === 0) {
      return res.status(404).json({ error: 'unknown location' });
    }

    const range = parseRangeQuery(req.query, stations);
    if (range.error) {
      return res.status(400).json({ error: range.error });
    }
    const { end, resolution, starts } = range;

    const settled = await Promise.allSettled(
      stations.map((s, i) => fetchReadings(s.id, starts[i], end, resolution))
    );

    const results = settled.map((outcome, i) => ({
      station: stations[i].id,
      name: stations[i].name,
      ...(outcome.status === 'fulfilled'
        ? { readings: outcome.value }
        : { error: outcome.reason.message }),
    }));

    const start = reportedStart(range, req.query, results.map((r) => r.readings));
    res.json({ location: req.params.loc, start, end, ...meta(resolution), stations: results });
  });

  // A single gauge by NOAA station ID
  app.get('/stations/:id/historical', async (req, res) => {
    const station = STATIONS[req.params.id];
    if (!station) {
      return res.status(404).json({ error: 'unknown station' });
    }

    const range = parseRangeQuery(req.query, [station]);
    if (range.error) {
      return res.status(400).json({ error: range.error });
    }
    const { end, resolution, starts } = range;

    try {
      const readings = await fetchReadings(station.id, starts[0], end, resolution);
      const start = reportedStart(range, req.query, [readings]);
      res.json({ station: station.id, name: station.name, start, end, ...meta(resolution), readings });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}
