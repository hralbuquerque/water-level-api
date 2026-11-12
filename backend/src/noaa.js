/**
 * NOAA Water Level Data API Integration
 *
 * Fetches historical water level readings from NOAA's CO-OPS Data API at one of
 * three resolutions, paging past NOAA's per-request limits.
 * Tests mock the global `fetch`, so nothing here calls NOAA during tests.
 */

const NOAA_API_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

export const DATUM = 'MLLW';
export const UNITS = 'english';
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_DATA = /no data was found/i;

/**
 * The resolutions the API serves. `chunkDays` is NOAA's per-request limit (end
 * date inclusive); `maxDays` is our cap on one API call, chosen so a response
 * stays around 90k readings per station at most.
 *
 * - 1min:   observed 1-minute data. Always preliminary: NOAA never verifies it.
 *           Starts around 2008. NOAA serves at most 4 days per request.
 * - 6min:   observed 6-minute data. Preliminary within days, verified later.
 * - hourly: verified hourly heights. Lags real time by roughly a month.
 * - daily:  verified daily max and min. NOAA computes these from 6-minute data
 *           (keeps the true storm peak, mid-1990s onward) or from hourly data (goes
 *           back much further). Both are fetched and the 6-minute value wins for any
 *           day that has one. Lags real time by one to two months.
 */
export const RESOLUTIONS = {
  '1min': { product: 'one_minute_water_level', chunkDays: 4, maxDays: 31 },
  '6min': { product: 'water_level', chunkDays: 31, maxDays: 366 },
  hourly: { product: 'hourly_height', chunkDays: 365, maxDays: 3660 },
  daily: { product: 'daily_max_min', chunkDays: 3650, maxDays: Infinity },
};

// Ranges `auto` serves at each resolution before stepping down to the next.
// `auto` never picks 1min: it doesn't exist before ~2008 and is never verified,
// so it's opt-in (resolution=1min) and used by fetchLatest.
const AUTO_6MIN_MAX_DAYS = 92;
const AUTO_HOURLY_MAX_DAYS = 1100;

// Kept for callers that only deal in 6-minute data.
export const CHUNK_DAYS = RESOLUTIONS['6min'].chunkDays;
export const MAX_RANGE_DAYS = RESOLUTIONS['6min'].maxDays;

// Range bounds are a date ("2012-10-29") or a date and UTC time ("2012-10-29T14:30").
// A date-only start means 00:00 and a date-only end means the whole day (23:59).
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const datePart = (d) => d.slice(0, 10);
const timePart = (d) => (d.length > 10 ? d.slice(11, 16) : null);
// "2012-10-29" -> "20121029"; "2012-10-29T14:30" -> "20121029 14:30" (NOAA's format)
const toNoaaDate = (d) => d.replace('T', ' ').replaceAll('-', '');
const toIsoDate = (date) => date.toISOString().slice(0, 10);
const parseIsoDate = (d) => new Date(`${datePart(d)}T00:00:00Z`);

/** `start=earliest` asks for each station's full record instead of a fixed start date. */
export const EARLIEST = 'earliest';

// NOAA's `established` date is close to where a station's data begins, but not
// exact: Prudhoe Bay (9497645) has readings from 1988, two years before its listed
// 1990. So "earliest" starts looking this long before `established`; the empty
// stretch costs one or two cheap "no data" requests and is skipped.
const ESTABLISHED_MARGIN_YEARS = 10;
// For a station without an `established` date: older than any NOAA record (1853)
const FALLBACK_EARLIEST = '1850-01-01';

/**
 * The date to start searching from when a station's full record is requested.
 *
 * @param {string|null} established - YYYY-MM-DD from data/stations.json
 * @returns {string} YYYY-MM-DD
 */
export function probeStartFor(established) {
  if (!established) return FALLBACK_EARLIEST;
  const date = parseIsoDate(established);
  date.setUTCFullYear(date.getUTCFullYear() - ESTABLISHED_MARGIN_YEARS);
  return toIsoDate(date);
}

/** Inclusive number of calendar days in a range (times are ignored). */
export function countDays(startDate, endDate) {
  return (parseIsoDate(endDate) - parseIsoDate(startDate)) / DAY_MS + 1;
}

/**
 * Resolve a requested resolution (`auto` or a key of RESOLUTIONS) for a range.
 * Short ranges get full 6-minute detail; long ones step down so responses stay small.
 *
 * @returns {string|null} - A RESOLUTIONS key, or null if the request is not recognised
 */
export function pickResolution(startDate, endDate, requested = 'auto') {
  if (requested !== 'auto') return Object.hasOwn(RESOLUTIONS, requested) ? requested : null;
  const days = countDays(startDate, endDate);
  if (days <= AUTO_6MIN_MAX_DAYS) return '6min';
  if (days <= AUTO_HOURLY_MAX_DAYS) return 'hourly';
  return 'daily';
}

/**
 * Split an inclusive YYYY-MM-DD range into consecutive, non-overlapping chunks
 * of at most `chunkDays` calendar days.
 *
 * @returns {Array<[string, string]>} - [start, end] pairs, both inclusive
 */
export function splitDateRange(startDate, endDate, chunkDays = CHUNK_DAYS) {
  const chunks = [];
  const last = parseIsoDate(endDate); // parseIsoDate drops any time; fetchReadings puts the times back on
  for (let cur = parseIsoDate(startDate); cur <= last; cur = new Date(cur.getTime() + chunkDays * DAY_MS)) {
    const chunkEnd = new Date(Math.min(cur.getTime() + (chunkDays - 1) * DAY_MS, last.getTime()));
    chunks.push([toIsoDate(cur), toIsoDate(chunkEnd)]);
  }
  return chunks;
}

/**
 * Make one NOAA datagetter request and return its `data` field. `params` holds the
 * request-specific fields (product, and begin_date/end_date or date); the station,
 * datum, units, time zone and format are always added here.
 * Returns null when NOAA reports no data (gauge outage, before the station existed,
 * not yet verified); throws on any other NOAA error.
 */
async function callNoaa(stationId, params) {
  const query = new URLSearchParams({
    station: stationId,
    ...params,
    datum: DATUM,
    time_zone: 'gmt',
    units: UNITS,
    format: 'json',
    application: 'rhodex-water-level-api',
  });

  const response = await fetch(`${NOAA_API_URL}?${query.toString()}`);

  // NOAA can return an error as a non-2xx status or as a 200 with an `error` field.
  // The body may not be JSON at all (e.g. an HTML gateway page), so never let parsing throw.
  const data = await response.json().catch(() => null);
  const message = data?.error?.message?.trim();
  if (response.ok && message && NO_DATA.test(message)) return null;
  if (!response.ok || data?.error) {
    throw new Error(`NOAA API error: ${message || response.statusText}`);
  }
  if (data?.data == null || typeof data.data !== 'object') {
    throw new Error('Invalid NOAA response: missing data field');
  }
  return data.data;
}

/** One date-range chunk of a product (see RESOLUTIONS). */
async function fetchChunk(stationId, startDate, endDate, config, extra = {}) {
  return callNoaa(stationId, {
    product: config.product,
    ...extra,
    begin_date: toNoaaDate(startDate),
    end_date: toNoaaDate(endDate),
  });
}

/**
 * Fetch historical water level readings from NOAA for a station, paging past
 * NOAA's per-request limits. Chunks are fetched sequentially to stay polite to
 * NOAA. Any hard NOAA error fails the whole range, so callers never get silently
 * partial data.
 *
 * @param {string|number} stationId - The NOAA tide gauge ID
 * @param {string} startDate - YYYY-MM-DD, or YYYY-MM-DDTHH:mm (UTC) to start at a time (inclusive)
 * @param {string} endDate - YYYY-MM-DD (through end of day UTC), or YYYY-MM-DDTHH:mm (inclusive)
 * @param {string} [resolution='6min'] - A key of RESOLUTIONS
 * @returns {Promise<Array>} - Parsed readings, oldest first
 */
// Quality flag for rows that don't carry their own `q`. 6-minute rows always do.
const QUALITY_DEFAULTS = {
  '1min': 'p', // one_minute_water_level is never verified
  '6min': null,
  hourly: 'v', // hourly_height and daily_max_min are verified-only products
  daily: 'v',
};

export async function fetchReadings(stationId, startDate, endDate, resolution = '6min') {
  const config = RESOLUTIONS[resolution];
  if (!config) throw new Error(`Unknown resolution: ${resolution}`);

  const meta = {
    station: String(stationId),
    datum: DATUM,
    units: UNITS,
    defaultQuality: QUALITY_DEFAULTS[resolution],
  };
  const readings = [];
  const chunks = splitDateRange(startDate, endDate, config.chunkDays);
  // Chunks are whole days; put the requested times back on the first and last.
  // Daily data has one value per day, so times don't apply to it.
  if (resolution !== 'daily') {
    if (timePart(startDate)) chunks[0][0] = startDate;
    if (timePart(endDate)) chunks.at(-1)[1] = endDate;
  }
  for (const [chunkStart, chunkEnd] of chunks) {
    if (resolution === 'daily') {
      readings.push(...(await fetchDailyChunk(stationId, chunkStart, chunkEnd, config, meta)));
      continue;
    }
    const data = await fetchChunk(stationId, chunkStart, chunkEnd, config);
    if (data !== null) readings.push(...parseReadings(data, meta));
  }
  if (readings.length === 0) {
    throw new Error(`NOAA API error: No data was found for station ${stationId} between ${startDate} and ${endDate}`);
  }
  return readings;
}

/**
 * The station's most recent 1-minute reading (one_minute_water_level with
 * `date=latest`). 1-minute data is never verified, so it is always preliminary
 * (q: 'p') and has no sigma or flags (s and f are null).
 * Resolves to null when the gauge has reported nothing recently (outage or
 * decommissioned station); throws on any other NOAA error.
 *
 * @param {string|number} stationId - The NOAA tide gauge ID
 * @returns {Promise<Object|null>} - One reading in the same shape as fetchReadings
 */
/** The resolution fetchLatest reads; routes report it as the response's `resolution`. */
export const LATEST_RESOLUTION = '1min';

export async function fetchLatest(stationId) {
  const latestData = await callNoaa(stationId, { product: RESOLUTIONS[LATEST_RESOLUTION].product, date: 'latest' });
  if (latestData === null) return null;
  const [reading] = parseReadings(latestData, {
    station: String(stationId),
    datum: DATUM,
    units: UNITS,
    defaultQuality: QUALITY_DEFAULTS[LATEST_RESOLUTION],
  });
  return reading ?? null;
}

/**
 * Daily max/min for one chunk: 6-minute-based where NOAA has it, hourly-based to
 * fill the days before 6-minute recording began (or any day it is missing).
 */
async function fetchDailyChunk(stationId, startDate, endDate, config, meta) {
  const fromSixMin = await fetchChunk(stationId, startDate, endDate, config, { interval: '6' });
  const fromHourly = await fetchChunk(stationId, startDate, endDate, config);

  const byDate = new Map();
  for (const r of fromHourly ? parseDailyMaxMin(fromHourly, meta) : []) byDate.set(r.t.slice(0, 10), r);
  for (const r of fromSixMin ? parseDailyMaxMin(fromSixMin, meta) : []) byDate.set(r.t.slice(0, 10), r);
  return [...byDate.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
}

/**
 * Parse raw NOAA 6-minute or hourly rows into structured readings.
 *
 * @param {Array} rawData - Raw NOAA `data` array
 * @param {Object} meta - Station, datum and units to stamp onto each reading
 * @returns {Array} - Parsed reading objects
 */
export function parseReadings(rawData, meta = {}) {
  if (!Array.isArray(rawData)) throw new Error('Invalid NOAA response: non-array data field');
  return rawData.map((row) => parseSingleReading(row, meta));
}

function parseSingleReading(row, meta) {
  return {
    station: meta.station ?? null,
    datum: meta.datum ?? null,
    units: meta.units ?? null,
    t: parseTimestamp(row.t),
    v: parseValue(row.v),
    s: parseValue(row.s), // standard deviation of the 1-second samples
    f: row.f ?? null,
    // 6-minute rows carry their own flag; hourly_height has none because it is a verified-only product
    q: row.q || (meta.defaultQuality ?? null),
  };
}

/**
 * Parse NOAA's daily_max_min response into one reading per day. NOAA returns
 * the maxima and minima as separate arrays (possibly split across several objects);
 * they are joined by date. `t`/`v` are the day's maximum, which is what a surge
 * trigger cares about. The minimum rides along as `tMin`/`vMin`.
 */
export function parseDailyMaxMin(rawData, meta = {}) {
  const blocks = Array.isArray(rawData) ? rawData : [rawData];
  const merged = Object.assign({}, ...blocks);
  const maxRows = merged.dailyMax6Min ?? merged.dailyMaxHourly;
  const minRows = merged.dailyMin6Min ?? merged.dailyMinHourly ?? [];
  if (!Array.isArray(maxRows)) throw new Error('Invalid NOAA response: missing daily maxima');

  const source = merged.dailyMax6Min ? '6min' : 'hourly';
  const pick = (row, field) => row[`${field}6Min`] ?? row[`${field}Hourly`];
  const minByDate = new Map(minRows.map((row) => [pick(row, 'date'), row]));

  return maxRows.map((row) => {
    const date = pick(row, 'date');
    const min = minByDate.get(date);
    return {
      station: meta.station ?? null,
      datum: meta.datum ?? null,
      units: meta.units ?? null,
      t: parseTimestamp(`${date} ${pick(row, 'time')}`),
      v: parseValue(pick(row, 'value')),
      tMin: min ? parseTimestamp(`${date} ${pick(min, 'time')}`) : null,
      vMin: min ? parseValue(pick(min, 'value')) : null,
      complete: parseValue(pick(row, 'pcComplete')), // % of the day's data NOAA had
      f: pick(row, 'flag') ?? null,
      q: 'v', // daily_max_min is a verified-only product
      source, // which NOAA data the max/min were computed from
    };
  });
}

function parseTimestamp(ts) {
  // "2012-10-29 23:00" -> "2012-10-29T23:00:00.000Z" (explicit UTC)
  return new Date(ts.replace(' ', 'T') + ':00Z').toISOString();
}

/**
 * Parse a NOAA value to a number, or null if empty or non-numeric.
 */
function parseValue(val) {
  const num = Number.parseFloat(val);
  return Number.isFinite(num) ? num : null;
}

/**
 * Explain why a date range is invalid, or return null if it is valid.
 * Bounds are inclusive YYYY-MM-DD or YYYY-MM-DDTHH:mm, in UTC.
 *
 * @param {string} from - Start date
 * @param {string} to - End date
 * @param {string} [resolution='6min'] - A key of RESOLUTIONS; sets the maximum span
 * @returns {string|null}
 */
export function getDateRangeError(from, to, resolution = '6min') {
  if (!from || !to) return 'start and end are required';
  if (!DATE_TIME.test(from) || !DATE_TIME.test(to)) return 'dates must be YYYY-MM-DD or YYYY-MM-DDTHH:mm (UTC)';

  for (const d of [from, to]) {
    const date = parseIsoDate(d);
    // Catches impossible dates like 2012-13-45 and rollovers like 2012-02-30
    if (Number.isNaN(date.getTime()) || toIsoDate(date) !== datePart(d)) return `invalid date: ${d}`;
    const time = timePart(d);
    if (time && (Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59)) return `invalid time: ${d}`;
  }

  // Compare instants: a date-only start is 00:00, a date-only end is 23:59
  const startAt = Date.parse(`${datePart(from)}T${timePart(from) ?? '00:00'}:00Z`);
  const endAt = Date.parse(`${datePart(to)}T${timePart(to) ?? '23:59'}:00Z`);
  if (startAt > endAt) return 'start must be on or before end';
  const now = Date.now();
  // The end may be later today (NOAA returns what exists so far), but not a future day
  if (startAt > now || parseIsoDate(to).getTime() > now) return 'dates cannot be in the future';

  const { maxDays } = RESOLUTIONS[resolution];
  const days = countDays(from, to);
  if (days > maxDays) {
    return `range is ${days} days; the maximum at ${resolution} resolution is ${maxDays}`;
  }

  return null;
}

/**
 * @returns {boolean} - True if the range is valid (see getDateRangeError)
 */
export function validateDateRange(from, to, resolution = '6min') {
  return getDateRangeError(from, to, resolution) === null;
}
