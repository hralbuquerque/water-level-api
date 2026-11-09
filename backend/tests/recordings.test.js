import { test, describe, beforeEach, afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';

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

  test('400 for date range over 31 days', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-01&end=2012-11-15');
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

  test('400 for date range of 32 days', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2012-10-01&end=2012-11-02');
    expect(res.status).toBe(400);
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
