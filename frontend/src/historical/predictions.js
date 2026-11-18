/**
 * Tide predictions alongside observed readings.
 *
 * NOAA's predictions are the astronomical tide only: what the tide alone would
 * do, with no storm surge, wind, pressure or river flow. Observed minus predicted
 * (the "residual" or surge) is how far the weather pushed the water above or
 * below the tide, which is what a storm-surge trigger is really about.
 *
 * Each readings resolution is compared with the matching prediction interval.
 * Daily data is the day's maximum, so it's compared with the day's highest
 * predicted high tide (observed daily max minus that is the "skew surge").
 */
import { DAY_MS, RESOLUTIONS, countDays } from './time.js';

// Readings resolution -> prediction interval, and the API's range cap for each
const PREDICTION_INTERVAL = { '1min': '1min', '6min': '6min', hourly: 'hourly', daily: 'hilo' };
const MAX_DAYS = { '1min': 31, '6min': 366, hourly: 3660, hilo: 3660 };

/**
 * The prediction request matching a readings response: same range (as the API
 * reported it, so "All history" uses the real first reading) at the matching interval.
 *
 * @returns {{ interval: string, start: string, end: string } | { error: string }}
 */
export function predictionRequestFor(data) {
  const interval = PREDICTION_INTERVAL[data.resolution];
  const days = countDays(data.start.slice(0, 10), data.end.slice(0, 10)); // bounds may carry times
  if (days > MAX_DAYS[interval]) {
    return { error: `Tide predictions cover up to ${MAX_DAYS[interval].toLocaleString()} days at ${RESOLUTIONS[data.resolution].label.toLowerCase()} resolution; this range is ${days.toLocaleString()} days.` };
  }
  return { interval, start: data.start, end: data.end };
}

// How a reading is matched to its prediction: by exact time, or by UTC date for daily data
const keyFor = (resolution) => (resolution === 'daily' ? (t) => t.slice(0, 10) : (t) => t);

/** hilo predictions -> one row per UTC day: that day's highest high tide. */
function dailyHighs(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (r.type !== 'high' || r.v === null) continue;
    const day = r.t.slice(0, 10);
    if (!byDate.has(day) || r.v > byDate.get(day).v) byDate.set(day, r);
  }
  return [...byDate.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
}

/**
 * Turn a predictions response into one series per gauge, keyed by station id,
 * ready for the chart: { id, times, values, readings, stepMs, valueFor(reading), error }.
 * `valueFor` returns the prediction matching an observed reading, or null.
 */
export function toPredictionSeries(response, resolution) {
  const gauges = response.stations ?? [{ station: response.station, predictions: response.predictions }];
  const key = keyFor(resolution);
  const stepMs = resolution === 'daily' ? DAY_MS : RESOLUTIONS[resolution].stepMs;
  const out = new Map();
  for (const g of gauges) {
    if (g.error) {
      out.set(g.station, { id: g.station, error: g.error });
      continue;
    }
    const readings = resolution === 'daily' ? dailyHighs(g.predictions ?? []) : g.predictions ?? [];
    const byKey = new Map(readings.map((r) => [key(r.t), r.v]));
    out.set(g.station, {
      id: g.station,
      error: null,
      readings,
      times: readings.map((r) => Date.parse(r.t)),
      values: readings.map((r) => r.v),
      stepMs,
      valueFor: (reading) => byKey.get(key(reading.t)) ?? null,
    });
  }
  return out;
}

/**
 * The largest residual (observed minus predicted) in one gauge's readings, or
 * null if no reading has a prediction to compare with.
 *
 * @returns {{ v: number, t: string, observed: number, predicted: number } | null}
 */
export function maxResidual(observed, prediction) {
  if (!prediction || prediction.error) return null;
  let best = null;
  for (const r of observed.readings) {
    if (r.v === null) continue;
    const p = prediction.valueFor(r);
    if (p === null) continue;
    const v = r.v - p;
    if (!best || v > best.v) best = { v, t: r.t, observed: r.v, predicted: p };
  }
  return best;
}

/** "+1.23 ft" / "−0.45 ft": residuals read best with an explicit sign. */
export const formatResidual = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} ft`;
