import { Router } from 'express';
import { LATEST_RESOLUTION, fetchLatest } from '../noaa.js';
import { STATIONS, getStationsForLocation, unsupportedStationError } from '../stations.js';
import { meta, parseDatumQuery } from './shared.js';

const router = Router();

// `reading` is the gauge's most recent 1-minute reading (always preliminary), or
// null when the gauge has reported nothing recently (an outage).

// The latest reading from every gauge in a location. One gauge failing doesn't
// fail the others: it gets an `error` instead of a `reading`.
router.get('/locations/:loc/latest', async (req, res) => {
  const stations = getStationsForLocation(req.params.loc);
  if (stations.length === 0) {
    return res.status(404).json({ error: 'unknown location' });
  }
  const datum = parseDatumQuery(req.query, stations);
  if (datum.error) {
    return res.status(400).json({ error: datum.error });
  }

  const settled = await Promise.allSettled(stations.map((s) => fetchLatest(s.id, datum.requested)));
  const results = settled.map((outcome, i) => ({
    station: stations[i].id,
    name: stations[i].name,
    datum: datum.datumOf(stations[i]),
    ...(outcome.status === 'fulfilled' ? { reading: outcome.value } : { error: outcome.reason.message }),
  }));

  res.json({ location: req.params.loc, ...meta(LATEST_RESOLUTION, datum.shared), stations: results });
});

// The latest reading from a single gauge by NOAA station ID
router.get('/stations/:id/latest', async (req, res) => {
  const station = STATIONS[req.params.id];
  if (!station) {
    return res.status(404).json({ error: unsupportedStationError(req.params.id) });
  }
  const datum = parseDatumQuery(req.query, [station]);
  if (datum.error) {
    return res.status(400).json({ error: datum.error });
  }
  if (!station.datums.includes(datum.datumOf(station))) {
    return res.status(400).json({ error: `station ${station.id} has no ${datum.requested} datum (available: ${station.datums.join(', ')})` });
  }

  try {
    const reading = await fetchLatest(station.id, datum.requested);
    res.json({ station: station.id, name: station.name, ...meta(LATEST_RESOLUTION, datum.shared), reading });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
