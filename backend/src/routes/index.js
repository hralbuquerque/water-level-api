import { fetchReadings, validateDateRange } from '../noaa.js';
import { STATIONS, getStationsForLocation } from '../stations.js';

const DATE_ERROR =
  'start and end are required as YYYY-MM-DD, not in the future, at most 31 days apart';

export function setupRoutes(app) {
  // All gauges for a location (e.g. nyc -> The Battery, Sandy Hook, Kings Point)
  app.get('/locations/:loc/historical', async (req, res) => {
    const { start, end } = req.query;

    const stations = getStationsForLocation(req.params.loc);
    if (stations.length === 0) {
      return res.status(404).json({ error: 'unknown location' });
    }

    if (!start || !end || !validateDateRange(start, end)) {
      return res.status(400).json({ error: DATE_ERROR });
    }

    const settled = await Promise.allSettled(
      stations.map((s) => fetchReadings(s.id, start, end))
    );

    const results = settled.map((outcome, i) => ({
      station: stations[i].id,
      name: stations[i].name,
      ...(outcome.status === 'fulfilled'
        ? { readings: outcome.value }
        : { error: outcome.reason.message }),
    }));

    res.json({ location: req.params.loc, start, end, stations: results });
  });

  // A single gauge by NOAA station ID
  app.get('/stations/:id/historical', async (req, res) => {
    const { start, end } = req.query;

    const station = STATIONS[req.params.id];
    if (!station) {
      return res.status(404).json({ error: 'unknown station' });
    }

    if (!start || !end || !validateDateRange(start, end)) {
      return res.status(400).json({ error: DATE_ERROR });
    }

    try {
      const readings = await fetchReadings(station.id, start, end);
      res.json({ station: station.id, name: station.name, start, end, readings });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}
