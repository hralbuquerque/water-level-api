// Date helpers. Everything is UTC, matching the API (NOAA data is requested in GMT).
// Dates are passed around as "YYYY-MM-DD" strings, which also sort correctly as text.

export const DAY_MS = 24 * 60 * 60 * 1000;

// Today's date in UTC. Used instead of the local date so the API never sees a "future" day
// (for users ahead of UTC, the local date can be tomorrow in UTC terms).
export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** "2012-10-22" + 14 -> "2012-11-05" */
export function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar days in an inclusive range: the same day twice is 1 day. */
export function countDays(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

/** True for a real calendar date in YYYY-MM-DD form (rejects "2012-02-30", which JS would roll over). */
export function isValidIsoDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) return false;
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
}

/**
 * Mirrors RESOLUTIONS / pickResolution in backend/src/noaa.js so the form can
 * explain the choice and catch over-long ranges before calling the API.
 * The API stays the source of truth: its 400 messages are shown as-is.
 */
// `stepMs` is the normal spacing between readings: the chart uses it to spot gaps,
// and the summary uses it to turn "readings above trigger" into a duration.
export const RESOLUTIONS = {
  '6min': { label: '6-minute', maxDays: 366, stepMs: 6 * 60 * 1000, unitNoun: 'reading' },
  hourly: { label: 'Hourly', maxDays: 3660, stepMs: 60 * 60 * 1000, unitNoun: 'hour' },
  daily: { label: 'Daily max', maxDays: Infinity, stepMs: DAY_MS, unitNoun: 'day' },
};

/**
 * Start value meaning "each gauge's whole record". The API resolves it per gauge
 * and reports the first reading it found as the response's `start`.
 */
export const EARLIEST = 'earliest';

/**
 * What 'auto' becomes for a range (same thresholds as the backend's pickResolution).
 * A whole record is years to decades long, so 'auto' with EARLIEST is always daily.
 */
export function resolveResolution(start, end, requested) {
  if (requested !== 'auto') return requested;
  if (start === EARLIEST) return 'daily';
  const days = countDays(start, end);
  if (days <= 92) return '6min';
  if (days <= 1100) return 'hourly';
  return 'daily';
}

/** Client-side check of the same rules the API enforces. Returns a message or null. */
export function rangeProblem(start, end, requested) {
  if (start === EARLIEST) {
    if (!isValidIsoDate(end)) return 'Enter a valid end date.';
    if (end > todayUtc()) return `The end date can't be after today (${formatDate(todayUtc())}, UTC).`;
    if (resolveResolution(start, end, requested) !== 'daily') {
      return 'A full record is too long for 6-minute or hourly data. Pick Daily max or Auto.';
    }
    return null;
  }
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) return 'Enter a valid start and end date.';
  if (start > end) return 'The start date must be on or before the end date.';
  if (end > todayUtc()) return `The end date can't be after today (${formatDate(todayUtc())}, UTC).`;
  const resolution = resolveResolution(start, end, requested);
  const { maxDays, label } = RESOLUTIONS[resolution];
  const days = countDays(start, end);
  if (days > maxDays) {
    return `${label} data is limited to ${maxDays.toLocaleString()} days per request; this range is ${days.toLocaleString()}. Pick a coarser resolution or Auto.`;
  }
  return null;
}

// Formatters are created once and reused; building Intl formatters is relatively slow
const fmt = (options) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options });
const dateFmt = fmt({ year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFmt = fmt({ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "Oct 29, 2012" from a YYYY-MM-DD date or ISO timestamp */
export const formatDate = (d) => dateFmt.format(new Date(d.length === 10 ? `${d}T00:00:00Z` : d));

/** "Oct 29, 2012, 23:36 UTC" */
export const formatDateTime = (iso) => `${dateTimeFmt.format(new Date(iso))} UTC`;

/** Human length of a duration, e.g. "2 h 24 min", "3 days" */
export function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const days = Math.round(minutes / (24 * 60));
  return `${days.toLocaleString()} days`;
}

// ---- Axis ticks -------------------------------------------------------------

// Candidate gaps between x-axis ticks, smallest first. timeTicks picks the first one
// that fits. Steps of a month or more are counted in calendar months (months differ
// in length), shorter ones in milliseconds.
const HOUR = 60 * 60 * 1000;
const STEPS = [
  { ms: HOUR, kind: 'ms' },
  { ms: 3 * HOUR, kind: 'ms' },
  { ms: 6 * HOUR, kind: 'ms' },
  { ms: 12 * HOUR, kind: 'ms' },
  { ms: DAY_MS, kind: 'ms' },
  { ms: 2 * DAY_MS, kind: 'ms' },
  { ms: 7 * DAY_MS, kind: 'ms' },
  { months: 1 }, { months: 3 }, { months: 6 },
  { months: 12 }, { months: 24 }, { months: 60 }, { months: 120 }, { months: 240 }, { months: 600 },
];
// Rough length of a step, only used to choose between steps
const approxMs = (s) => s.ms ?? s.months * 30.44 * DAY_MS;

const tickFormats = {
  hour: fmt({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  day: fmt({ month: 'short', day: 'numeric' }),
  month: fmt({ month: 'short', year: 'numeric' }),
  year: fmt({ year: 'numeric' }),
};

/**
 * Calendar-aligned UTC ticks between t0 and t1 (ms), at most ~maxTicks of them.
 * @returns {{ ticks: number[], format: (t: number) => string }}
 */
export function timeTicks(t0, t1, maxTicks) {
  const span = t1 - t0;
  const step = STEPS.find((s) => span / approxMs(s) <= maxTicks) ?? STEPS[STEPS.length - 1];
  const ticks = [];
  if (step.ms) {
    // Align to the step in UTC (days and weeks align to midnight)
    let t = Math.ceil(t0 / step.ms) * step.ms;
    for (; t <= t1; t += step.ms) ticks.push(t);
    const format = step.ms < DAY_MS ? tickFormats.hour : tickFormats.day;
    return { ticks, format: (t) => format.format(new Date(t)) };
  }
  // Month-based steps: start at the first month boundary on or after t0 whose
  // month number is a multiple of the step (so 3-month ticks fall on Jan/Apr/Jul/Oct
  // and 10-year ticks on 1990, 2000, ...), then step forward month by month.
  const start = new Date(t0);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  // Round up to the first month that is a multiple of the step
  const total = Math.ceil((y * 12 + m + (start.getUTCDate() > 1 || start.getUTCHours() > 0 ? 1 : 0)) / step.months) * step.months;
  y = Math.floor(total / 12);
  m = total % 12;
  for (let t = Date.UTC(y, m, 1); t <= t1; ) {
    ticks.push(t);
    m += step.months;
    y += Math.floor(m / 12);
    m %= 12;
    t = Date.UTC(y, m, 1);
  }
  const format = step.months >= 12 ? tickFormats.year : tickFormats.month;
  return { ticks, format: (t) => format.format(new Date(t)) };
}

/**
 * Round-number ticks covering [lo, hi], about `count` of them, spaced by 1, 2, 2.5
 * or 5 times a power of ten (e.g. 0, 2.5, 5, 7.5 ...). A flat range is widened first.
 */
export function niceTicks(lo, hi, count = 5) {
  if (hi - lo < 1e-9) {
    lo -= 0.5;
    hi += 0.5;
  }
  const raw = (hi - lo) / count || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const first = Math.floor(lo / step) * step;
  const last = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = first; v <= last + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}
