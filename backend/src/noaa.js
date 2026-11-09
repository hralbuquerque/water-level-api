/**
 * NOAA Water Level Data API Integration
 *
 * Fetches historical water level readings from NOAA's Tides and Currents API.
 * The fetchReadings function is designed to be easily mocked for testing.
 */

// NOAA API endpoint
const NOAA_API_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

const DATUM = 'MLLW';
const UNITS = 'english';
const toNoaaDate = (d) => d.replaceAll('-', '');
/**
 * Fetch historical water level readings from NOAA
 *
 * @param {string|number} stationId - The NOAA tide gauge ID
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @returns {Promise<Array>} - Parsed readings
 */
export async function fetchReadings(stationId, startDate, endDate) {

  const params = new URLSearchParams({
    station: stationId,
    product: 'water_level',

    begin_date: toNoaaDate(startDate),
    end_date: toNoaaDate(endDate),

    datum: DATUM,
    time_zone: 'gmt',
    units: UNITS,
    format: 'json',
    application: 'rhodex-water-level-api',
  });

  const response = await fetch(`${NOAA_API_URL}?${params.toString()}`);

  // NOAA can return an error as a non-2xx status or as a 200 with an `error` field.
  // The body may not be JSON at all (e.g. an HTML gateway page), so never let parsing throw.
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    throw new Error(`NOAA API error: ${data?.error?.message ?? response.statusText}`);
  }
  if (!Array.isArray(data?.data)) {
    throw new Error('Invalid NOAA response: missing or non-array data field');
  }

  return parseReadings(data.data, { station: String(stationId), datum: DATUM, units: UNITS });
}

/**
 * Parse raw NOAA data into structured readings format
 *
 * @param {Array} rawData - Raw NOAA data array from API response
 * @returns {Array} - Array of parsed reading objects
 */
export function parseReadings(rawData, meta = {}) {
  return rawData.map((row) => parseSingleReading(row, meta));
}

/**
 * Parse a single reading row into structured format
 *
 * @param {Object} row - Single data row from NOAA API
 * @param {Object} meta - Station, datum and units to stamp onto the reading
 * @returns {Object} - Parsed reading object
 */
function parseSingleReading(row, meta) {
  return {
    station: meta.station ?? null,
    datum: meta.datum ?? null,
    units: meta.units ?? null,
    t: parseTimestamp(row.t),
    v: parseValue(row.v),
    s: parseValue(row.s), // standard deviation of the 1-second samples
    f: row.f ?? null,
    q: row.q || null,
  };
}


function parseTimestamp(ts) {
  // "2012-10-29 23:00" -> "2012-10-29T23:00:00Z" (explicit UTC)
  return new Date(ts.replace(' ', 'T') + ':00Z').toISOString();
}

/**
 * Parse value string to number or null
 *
 * @param {string} val - String value from NOAA data
 * @returns {number|null} - Numeric value or null if empty
 */
function parseValue(val) {
  const num = Number.parseFloat(val);
  return Number.isFinite(num) ? num : null;
}

/**
 * Validate date range against NOAA's constraints
 *
 * @param {string} from - Start date in YYYY-MM-DD format
 * @param {string} to - End date in YYYY-MM-DD format
 * @returns {boolean} - True if valid, false otherwise
 */
export function validateDateRange(from, to) {
  // Must look like YYYY-MM-DD before we even try to parse it
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return false;

  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);

  // Catches impossible dates like 2012-13-45
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return false;

  if (fromDate > toDate) return false;

  const now = new Date();
  if (fromDate > now || toDate > now) return false;

  const diffDays = Math.ceil((toDate - fromDate) / (1000 * 60 * 60 * 24));
  if (diffDays > 31) return false;

  return true;
}
