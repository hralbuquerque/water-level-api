import { Router } from 'express';
import { PREDICTION_INTERVALS, countDays, fetchPredictions, getDateFormatError, predictionsError } from '../noaa.js';
import { STATIONS, getStationsForLocation, unsupportedStationError } from '../stations.js';
import { meta, parseDatumQuery } from './shared.js';

const router = Router();

const INTERVAL_NAMES = Object.keys(PREDICTION_INTERVALS).join(', ');

// Tide predictions are the astronomical tide only (no storm surge), from NOAA's
// `predictions` product. Unlike historical readings, dates may be in the future.
// Query: start, end (required, YYYY-MM-DD or YYYY-MM-DDTHH:mm UTC),
//        interval (default 6min; see PREDICTION_INTERVALS), datum (MSL or NAVD88).

/**
 * Validate `start`, `end` and `interval`.
 *
 * @returns {{ error: string } | { start: string, end: string, interval: string }}
 */
function parsePredictionQuery(query) {
  const { start, end, interval = '6min' } = query;
  const formatError = getDateFormatError(start, end);
  if (formatError) return { error: formatError };
  if (!Object.hasOwn(PREDICTION_INTERVALS, interval)) {
    return { error: `interval must be one of: ${INTERVAL_NAMES}` };
  }
  const config = PREDICTION_INTERVALS[interval];
  const days = countDays(start, end);
  if (days > config.maxDays) {
    return { error: `range is ${days} days; the maximum at the ${interval} interval is ${config.maxDays}` };
  }
  return { start, end, interval };
}

// Response fields shared by both endpoints. `interval` replaces the readings
// endpoints' `resolution`, and `kind` says these are predictions, not observations.
const predictionMeta = (interval, datum) => {
  const { resolution, ...rest } = meta(interval, datum);
  return { kind: 'astronomical tide prediction', interval: resolution, ...rest };
};

// All gauges for a location. One gauge failing (e.g. no predictions there) doesn't
// fail the others: it gets an `error` instead of `predictions`.
router.get('/locations/:loc/predictions', async (req, res) => {
  const stations = getStationsForLocation(req.params.loc);
  if (stations.length === 0) {
    return res.status(404).json({ error: 'unknown location' });
  }
  const datum = parseDatumQuery(req.query, stations);
  if (datum.error) {
    return res.status(400).json({ error: datum.error });
  }
  const range = parsePredictionQuery(req.query);
  if (range.error) {
    return res.status(400).json({ error: range.error });
  }
  const { start, end, interval } = range;

  const settled = await Promise.allSettled(
    stations.map((s) => fetchPredictions(s.id, start, end, interval, datum.requested))
  );
  const results = settled.map((outcome, i) => ({
    station: stations[i].id,
    name: stations[i].name,
    datum: datum.datumOf(stations[i]),
    ...(outcome.status === 'fulfilled' ? { predictions: outcome.value } : { error: outcome.reason.message }),
  }));

  res.json({ location: req.params.loc, start, end, ...predictionMeta(interval, datum.shared), stations: results });
});

// A single gauge by NOAA station ID
router.get('/stations/:id/predictions', async (req, res) => {
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
  const range = parsePredictionQuery(req.query);
  if (range.error) {
    return res.status(400).json({ error: range.error });
  }
  const { start, end, interval } = range;
  const unavailable = predictionsError(station, interval);
  if (unavailable) {
    return res.status(station.predictions ? 400 : 404).json({ error: unavailable });
  }

  try {
    const predictions = await fetchPredictions(station.id, start, end, interval, datum.requested);
    res.json({ station: station.id, name: station.name, start, end, ...predictionMeta(interval, datum.shared), predictions });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
