import { Router } from 'express';
import { LATEST_RESOLUTION, fetchLatest } from '../noaa.js';
import { STATIONS, getStationsForLocation } from '../stations.js';
import { meta } from './shared.js';

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

  const settled = await Promise.allSettled(stations.map((s) => fetchLatest(s.id)));
  const results = settled.map((outcome, i) => ({
    station: stations[i].id,
    name: stations[i].name,
    ...(outcome.status === 'fulfilled' ? { reading: outcome.value } : { error: outcome.reason.message }),
  }));

  res.json({ location: req.params.loc, ...meta(LATEST_RESOLUTION), stations: results });
});

// The latest reading from a single gauge by NOAA station ID
router.get('/stations/:id/latest', async (req, res) => {
  const station = STATIONS[req.params.id];
  if (!station) {
    return res.status(404).json({ error: 'unknown station' });
  }

  try {
    const reading = await fetchLatest(station.id);
    res.json({ station: station.id, name: station.name, ...meta(LATEST_RESOLUTION), reading });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
