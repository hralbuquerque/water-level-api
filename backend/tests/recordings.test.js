import { test, describe, beforeEach, afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { splitDateRange } from '../src/noaa.js';

// Fake NOAA response: one verified reading, one missing value
const fakeNoaa = {
  data: [
    { t: '2012-10-29 23:00', v: '4.21', s: '0.02', f: '0,0,0,0', q: 'v' },
    { t: '2012-10-29 23:06', v: '', s: '', f: '0,0,0,0', q: 'p' },
    { t: '2012-10-29 23:12', v: '4.30', s: '0.03', f: '0,0,0,0', q: '' },
  ],
};

describe('GET /locations/:loc/historical', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    // Replace fetch so no test ever calls the real NOAA
    vi.stubGlobal('fetch', async (url) => {
      // Return proper fake readings for any request
      const firstReading = {
        t: '2012-10-29 23:00',
        v: '4.21',
        s: '0.02',
        f: '0,0,0,0',
        q: 'v'
      };
      const secondReading = {
        t: '2012-10-29 23:06',
        v: '',
        s: '',
        f: '0,0,0,0',
        q: 'p'
      };
      return {
        ok: true,
        json: async () => ({ data: [firstReading, secondReading] })
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns readings for a single station by ID (Nawiliwili)', async () => {
    const res = await request(app).get('/stations/1611400/historical?start=2012-10-29&end=2012-10-30');
    expect(res.status).toBe(200);
    expect(res.body.readings).toHaveLength(2);
    expect(res.body.readings[0].t).toBe('2012-10-29T23:00:00.000Z');
    expect(res.body.readings[0].v).toBe(4.21);
  });

  test('returns readings for every NYC station', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.status).toBe(200);
    expect(res.body.stations).toHaveLength(3);
    expect(res.body.stations.map((s) => s.station).sort()).toEqual(['8516945', '8518750', '8531680']);
  });

  test('timestamps are exact UTC', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.body.stations[0].readings[0].t).toBe('2012-10-29T23:00:00.000Z');
  });

  test('keeps the quality flag and turns an empty value into null', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    const [first, second] = res.body.stations[0].readings;
    expect(first.q).toBe('v');
    expect(second.v).toBeNull();
  });

  test('one failing station does not break the others', async () => {
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('station=8531680')) throw new Error('boom');
      return { ok: true, json: async () => fakeNoaa };
    });
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.status).toBe(200);
    expect(res.body.stations.find((s) => s.station === '8531680').error).toBeDefined();
    expect(res.body.stations.find((s) => s.station === '8518750').readings).toBeDefined();
  });

  test('404 for an unknown station ID', async () => {
    const res = await request(app).get('/stations/0000000/historical?start=2012-10-29&end=2012-10-30');
    expect(res.status).toBe(404);
  });

  test('404 for an unknown location', async () => {
    const res = await request(app).get('/locations/atlantis/historical?start=2012-10-29&end=2012-10-30');
    expect(res.status).toBe(404);
  });

  test('400 for missing start date', async () => {
    const res = await request(app).get('/locations/nyc/historical?end=2012-10-30');
    expect(res.status).toBe(400);
  });

  test('400 for missing end date', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29');
    expect(res.status).toBe(400);
  });

  test('400 for start after end', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-11-01&end=2012-10-30');
    expect(res.status).toBe(400);
  });

  test('400 for future dates', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2030-12-31&end=2031-01-15');
    expect(res.status).toBe(400);
  });

  test('400 for invalid date format', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=banana&end=2012-10-30');
    expect(res.status).toBe(400);
  });


  test('400 for impossible date (month 13)', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-13-45&end=2012-10-30');
    expect(res.status).toBe(400);
  });

  test('includes station name and location info', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    const firstStation = res.body.stations.find((s) => s.station === '8516945');
    expect(firstStation.name).toBe('Kings Point');
  });

  test('includes start and end dates in response', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.body.start).toBe('2012-10-29');
    expect(res.body.end).toBe('2012-10-30');
  });

  test('200 for date range of exactly 31 days (boundary case)', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-01&end=2012-11-01');
    // Oct has 31 days, so Nov 1 is exactly 31 days after Oct 1 - should be allowed
    expect(res.status).toBe(200);
  });


  test('parsing of invalid numeric value results in null', async () => {
    // This tests parseValue with an invalid format (e.g., "abc")
    const fakeBadNoaa = {
      data: [{ t: '2012-10-29 23:00', v: 'abc', s: '0.02' }],
    };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => fakeBadNoaa }));
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.body.stations[0].readings[0].v).toBeNull();
  });

  test('parsing of NaN value results in null', async () => {
    const fakeNaNNoaa = {
      data: [{ t: '2012-10-29 23:00', v: 'NaN', s: '0.02' }],
    };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => fakeNaNNoaa }));
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.body.stations[0].readings[0].v).toBeNull();
  });

  test('includes all reading fields (t, v, s, f, q)', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    const firstReading = res.body.stations[0].readings[0];
    expect(firstReading.t).toBeDefined();
    expect(firstReading.v).toBeDefined();
    expect(firstReading.s).toBeDefined();
    expect(firstReading.f).toBeDefined();
    expect(firstReading.q).toBeDefined();
  });

  test('multiple stations return separate reading arrays', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    res.body.stations.forEach((s, i) => {
      expect(s.readings).toBeDefined();
      expect(Array.isArray(s.readings)).toBe(true);
    });
  });

  test('returns error message for failing station', async () => {
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).includes('station=8531680')) {
        return { ok: false, statusText: 'Bad Gateway', json: async () => ({ error: { message: 'Internal Server Error' } }) };
      }
      return { ok: true, json: async () => fakeNoaa };
    });
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.status).toBe(200);
    const failingStation = res.body.stations.find((s) => s.station === '8531680');
    expect(failingStation.error).toContain('Internal Server Error');
  });
});

describe('GET /locations/:loc/historical (v2)', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => fakeNoaa }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('handles empty time value gracefully', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    // Empty string should be parsed as null by parseValue
    expect(res.body.stations[0].readings.some(r => r.v === null)).toBe(true);
  });

  test('handles empty quality flag gracefully', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.body.stations[0].readings.some(r => r.q === null)).toBe(true);
  });

  test('handles empty span array gracefully', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    // Empty string in NOAA data gets parsed to null
    expect(res.body.stations[0].readings.some(r => r.s === null)).toBe(true);
  });

  test('location field matches request parameter', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.body.location).toBe('nyc');
  });

  test('case-insensitive location matching', async () => {
    const res1 = await request(app).get('/locations/NYC/historical?start=2012-10-29&end=2012-10-30');
    const res2 = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res1.body.stations.length).toBe(3);
    expect(res2.body.stations.length).toBe(3);
  });

  test('station array order matches stations.js order', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.body.stations.map((s) => s.station)).toEqual([
      '8518750', // The Battery
      '8531680',  // Sandy Hook
      '8516945' // Kings Point
    ]);
  });
});

describe('historical ranges longer than NOAA\'s 31-day limit', () => {
  let app;
  let calls;

  // Each NOAA request returns one reading stamped with its begin_date, so we can
  // see exactly which windows were requested.
  const row = (begin) => ({ t: `${begin.slice(0, 4)}-${begin.slice(4, 6)}-${begin.slice(6)} 00:00`, v: '1.00', s: '0.01', f: '0,0,0,0', q: 'v' });
  const stub = (handler) => vi.stubGlobal('fetch', async (url) => {
    const params = new URL(url).searchParams;
    calls.push({ station: params.get('station'), begin: params.get('begin_date'), end: params.get('end_date') });
    return handler(params);
  });
  const ok = (params) => ({ ok: true, json: async () => ({ data: [row(params.get('begin_date'))] }) });
  const noData = { ok: true, json: async () => ({ error: { message: 'No data was found. This product may not be offered at this station at the requested time.' } }) };

  beforeEach(() => {
    app = buildApp();
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('splitDateRange makes consecutive, non-overlapping 31-day chunks', () => {
    expect(splitDateRange('2012-10-01', '2012-10-31')).toEqual([['2012-10-01', '2012-10-31']]);
    expect(splitDateRange('2012-10-01', '2012-11-15')).toEqual([
      ['2012-10-01', '2012-10-31'],
      ['2012-11-01', '2012-11-15'],
    ]);
    expect(splitDateRange('2012-01-01', '2012-12-31')).toHaveLength(12);
    expect(splitDateRange('2012-10-29', '2012-10-29')).toEqual([['2012-10-29', '2012-10-29']]);
  });

  test('pages a 46-day range into two NOAA requests per station and joins them in order', async () => {
    stub(ok);
    const res = await request(app).get('/stations/8518750/historical?start=2012-10-01&end=2012-11-15');
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { station: '8518750', begin: '20121001', end: '20121031' },
      { station: '8518750', begin: '20121101', end: '20121115' },
    ]);
    expect(res.body.readings.map((r) => r.t)).toEqual(['2012-10-01T00:00:00.000Z', '2012-11-01T00:00:00.000Z']);
  });

  test('pages every station in a location', async () => {
    stub(ok);
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-01&end=2012-11-15');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(6);
    res.body.stations.forEach((s) => expect(s.readings).toHaveLength(2));
  });

  test('allows a full leap year (366 days)', async () => {
    stub(ok);
    const res = await request(app).get('/stations/8518750/historical?start=2012-01-01&end=2012-12-31');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(12);
  });

  test('400 for ranges over 366 days', async () => {
    stub(ok);
    const res = await request(app).get('/stations/8518750/historical?start=2012-01-01&end=2013-01-01');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum at 6min resolution is 366/);
    expect(calls).toHaveLength(0);
  });

  test('a chunk with no data (gauge outage) is skipped, not fatal', async () => {
    stub((params) => (params.get('begin_date') === '20121001' ? noData : ok(params)));
    const res = await request(app).get('/stations/8531680/historical?start=2012-10-01&end=2012-11-15');
    expect(res.status).toBe(200);
    expect(res.body.readings.map((r) => r.t)).toEqual(['2012-11-01T00:00:00.000Z']);
  });

  test('no data in any chunk is reported as an error for that station', async () => {
    stub((params) => (params.get('station') === '8531680' ? noData : ok(params)));
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-01&end=2012-11-15');
    expect(res.status).toBe(200);
    expect(res.body.stations.find((s) => s.station === '8531680').error).toMatch(/No data was found/);
    expect(res.body.stations.find((s) => s.station === '8518750').readings).toHaveLength(2);
  });

  test('a hard NOAA error in any chunk fails the station instead of returning partial data', async () => {
    stub((params) => (params.get('begin_date') === '20121101'
      ? { ok: false, statusText: 'Bad Gateway', json: async () => { throw new Error('not json'); } }
      : ok(params)));
    const res = await request(app).get('/stations/8518750/historical?start=2012-10-01&end=2012-11-15');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('NOAA API error: Bad Gateway');
  });

  test('400 explains which date rule failed', async () => {
    const future = await request(app).get('/stations/8518750/historical?start=2999-01-01&end=2999-01-02');
    expect(future.body.error).toMatch(/future/);
    const order = await request(app).get('/stations/8518750/historical?start=2012-11-01&end=2012-10-01');
    expect(order.body.error).toMatch(/before end/);
    const missing = await request(app).get('/stations/8518750/historical?start=2012-11-01');
    expect(missing.body.error).toMatch(/required/);
  });

  test('400 for a date that rolls over (Feb 30)', async () => {
    const res = await request(app).get('/stations/8518750/historical?start=2012-02-30&end=2012-03-02');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid date/);
  });

  test('response records datum, units, time zone and when the data was retrieved', async () => {
    stub(ok);
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-29&end=2012-10-30');
    expect(res.body).toMatchObject({ datum: 'MSL', units: 'english', timeZone: 'GMT' });
    expect(res.body.stations.every((s) => s.datum === 'MSL')).toBe(true);
    expect(Number.isNaN(Date.parse(res.body.retrievedAt))).toBe(false);
  });

  test('?datum=NAVD88 is sent to NOAA for every chunk and stamped on every reading', async () => {
    const datums = [];
    stub((params) => {
      datums.push(params.get('datum'));
      return ok(params);
    });
    const res = await request(app).get('/stations/8518750/historical?start=2012-09-01&end=2012-10-30&datum=NAVD88');
    expect(res.status).toBe(200);
    expect(datums.length).toBeGreaterThan(1);
    expect(datums.every((d) => d === 'NAVD')).toBe(true); // NOAA's data API spelling
    expect(res.body.datum).toBe('NAVD88');
    expect(res.body.readings.every((r) => r.datum === 'NAVD88')).toBe(true);
  });
});
