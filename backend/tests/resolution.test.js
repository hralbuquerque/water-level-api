import { test, describe, beforeEach, afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { pickResolution, probeStartFor } from '../src/noaa.js';

// Real NOAA response shapes, trimmed
const hourly = { data: [{ t: '2012-10-29 23:00', v: '11.200', s: '0.300', f: '0,0' }] };
const daily = {
  data: [
    { dailyMax6Min: [{ date6Min: '2012-10-30', time6Min: '01:24', value6Min: 14.055, pcComplete6Min: 100, flag6Min: '0' }] },
    { dailyMin6Min: [{ date6Min: '2012-10-30', time6Min: '08:12', value6Min: 2.1, pcComplete6Min: 100, flag6Min: '0' }] },
  ],
};
const dailyHourly = {
  data: [
    { dailyMaxHourly: [
      { dateHourly: '1938-09-21', timeHourly: '20:00', valueHourly: 9.1, pcCompleteHourly: 100, flagHourly: '0' },
      { dateHourly: '2012-10-30', timeHourly: '01:00', valueHourly: 13.986, pcCompleteHourly: 100, flagHourly: '0' },
    ] },
    { dailyMinHourly: [] },
  ],
};
const sixMin = { data: [{ t: '2012-10-29 23:00', v: '4.21', s: '0.02', f: '0,0,0,0', q: 'v' }] };

describe('resolutions', () => {
  let app;
  let calls;

  beforeEach(() => {
    app = buildApp();
    calls = [];
    vi.stubGlobal('fetch', async (url) => {
      const params = new URL(url).searchParams;
      calls.push(Object.fromEntries(params));
      const product = params.get('product') === 'daily_max_min' && !params.get('interval') ? 'daily_hourly' : params.get('product');
      let body = { water_level: sixMin, hourly_height: hourly, daily_max_min: daily, daily_hourly: dailyHourly }[product];
      if (params.get('product') === 'daily_max_min') {
        // Like NOAA, only return days inside the requested window
        const [from, to] = [params.get('begin_date'), params.get('end_date')];
        const inWindow = (row) => {
          const day = (row.date6Min ?? row.dateHourly).replaceAll('-', '');
          return day >= from && day <= to;
        };
        body = { data: body.data.map((block) => Object.fromEntries(Object.entries(block).map(([k, rows]) => [k, rows.filter(inWindow)]))) };
      }
      return { ok: true, json: async () => body };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('pickResolution steps down as ranges grow', () => {
    expect(pickResolution('2012-10-01', '2012-12-31')).toBe('6min'); // 92 days
    expect(pickResolution('2012-10-01', '2013-01-01')).toBe('hourly'); // 93 days
    expect(pickResolution('2010-01-01', '2012-12-31')).toBe('hourly'); // 1,096 days
    expect(pickResolution('2000-01-01', '2012-12-31')).toBe('daily');
    expect(pickResolution('2000-01-01', '2012-12-31', '6min')).toBe('6min');
    expect(pickResolution('2000-01-01', '2012-12-31', 'weekly')).toBeNull();
  });

  test('defaults to 6-minute data so API callers get full detail', async () => {
    const res = await request(app).get('/stations/8518750/historical?start=2012-10-29&end=2012-10-29');
    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe('6min');
    expect(calls[0].product).toBe('water_level');
  });

  test('hourly pages by year and marks readings verified', async () => {
    const res = await request(app).get('/stations/8518750/historical?start=2010-01-01&end=2012-12-31&resolution=hourly');
    expect(res.status).toBe(200);
    expect(calls.map((c) => [c.product, c.begin_date, c.end_date])).toEqual([
      ['hourly_height', '20100101', '20101231'],
      ['hourly_height', '20110101', '20111231'],
      ['hourly_height', '20120101', '20121230'],
      ['hourly_height', '20121231', '20121231'],
    ]);
    expect(res.body.readings[0]).toMatchObject({ t: '2012-10-29T23:00:00.000Z', v: 11.2, q: 'v' });
  });

  test('daily prefers 6-minute maxima, fills older days from hourly, and has no span cap', async () => {
    const res = await request(app).get('/stations/8518750/historical?start=1920-01-01&end=2012-12-31&resolution=daily');
    expect(res.status).toBe(200);
    expect(calls.every((c) => c.product === 'daily_max_min')).toBe(true);
    expect(calls).toHaveLength(20); // 93 years in 10-year pages, 6-minute and hourly for each
    expect(res.body.readings).toHaveLength(2);
    expect(res.body.readings[0]).toMatchObject({ t: '1938-09-21T20:00:00.000Z', v: 9.1, vMin: null, source: 'hourly' });
    expect(res.body.readings[1]).toMatchObject({
      t: '2012-10-30T01:24:00.000Z',
      v: 14.055,
      tMin: '2012-10-30T08:12:00.000Z',
      vMin: 2.1,
      complete: 100,
      q: 'v',
      source: '6min',
    });
  });

  test('auto picks daily for a long range and reports it', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=2000-01-01&end=2012-12-31&resolution=auto');
    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe('daily');
    expect(res.body.stations).toHaveLength(3);
  });

  test('400 when a range is too long for the chosen resolution', async () => {
    const res = await request(app).get('/stations/8518750/historical?start=2000-01-01&end=2012-12-31&resolution=hourly');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum at hourly resolution is 3660/);
    expect(calls).toHaveLength(0);
  });

  test('400 for an unknown resolution', async () => {
    const res = await request(app).get('/stations/8518750/historical?start=2012-10-29&end=2012-10-30&resolution=weekly');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolution must be one of: auto, 6min, hourly, daily/);
  });

  test('date errors win over resolution errors', async () => {
    const res = await request(app).get('/stations/8518750/historical?start=banana&end=2012-10-30&resolution=weekly');
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
  });
});

describe('directory endpoints', () => {
  test('GET /locations lists locations with their gauges in order', async () => {
    const res = await request(buildApp()).get('/locations');
    expect(res.status).toBe(200);
    const nyc = res.body.locations.find((l) => l.id === 'nyc');
    expect(nyc.name).toBe('New York City');
    expect(nyc.stations.map((s) => s.name)).toEqual(['The Battery', 'Sandy Hook', 'Kings Point']);
  });

  test('GET /stations lists every station with id, name, state, coordinates and established date', async () => {
    const res = await request(buildApp()).get('/stations');
    expect(res.status).toBe(200);
    expect(res.body.stations.length).toBeGreaterThan(250);
    expect(res.body.stations.find((s) => s.id === '8518750')).toEqual({
      id: '8518750', name: 'The Battery', state: 'NY', lat: 40.700554, lng: -74.01417, established: '1920-05-24',
    });
  });
});

describe('start=earliest (a station\'s whole record)', () => {
  let app;
  let calls;

  // Daily data: each 10-year request returns one day, dated at the start of its window,
  // except windows that end before `firstDataYear` (for that station), which have no data.
  const firstDataYear = { '8518750': 1920, '8531680': 1910, '8516945': 1998 };
  const noData = { ok: true, json: async () => ({ error: { message: 'No data was found.' } }) };

  beforeEach(() => {
    app = buildApp();
    calls = [];
    vi.stubGlobal('fetch', async (url) => {
      const p = new URL(url).searchParams;
      const [station, begin, end] = [p.get('station'), p.get('begin_date'), p.get('end_date')];
      calls.push({ station, begin, end, product: p.get('product') });
      if (Number(end.slice(0, 4)) < firstDataYear[station]) return noData;
      const day = `${Math.max(Number(begin.slice(0, 4)), firstDataYear[station])}-06-01`;
      const key = p.get('interval') === '6' ? '6Min' : 'Hourly';
      return {
        ok: true,
        json: async () => ({
          data: [{ [`dailyMax${key}`]: [{ [`date${key}`]: day, [`time${key}`]: '12:00', [`value${key}`]: 5, [`pcComplete${key}`]: 100, [`flag${key}`]: '0' }] }],
        }),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('probeStartFor starts ten years before the established date, or 1850 without one', () => {
    expect(probeStartFor('1920-05-24')).toBe('1910-05-24');
    expect(probeStartFor(null)).toBe('1850-01-01');
  });

  test('each gauge is searched from its own established date (minus the margin)', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=earliest&end=2012-12-31&resolution=auto');
    expect(res.status).toBe(200);
    const firstRequest = (station) => calls.filter((c) => c.station === station).map((c) => c.begin).sort()[0];
    expect(firstRequest('8518750')).toBe('19100524'); // Battery, established 1920-05-24
    expect(firstRequest('8531680')).toBe('19000107'); // Sandy Hook, established 1910-01-07
    expect(firstRequest('8516945')).toBe('19881027'); // Kings Point, established 1998-10-27
  });

  test('auto means daily, and `start` reports the oldest reading actually found', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=earliest&end=2012-12-31&resolution=auto');
    expect(res.body.resolution).toBe('daily');
    expect(calls.every((c) => c.product === 'daily_max_min')).toBe(true);
    expect(res.body.start).toBe('1910-06-01'); // Sandy Hook's first reading
    expect(res.body.end).toBe('2012-12-31');
    const first = (id) => res.body.stations.find((s) => s.station === id).readings[0].t.slice(0, 10);
    expect(first('8518750')).toBe('1920-06-01');
    expect(first('8516945')).toBe('1998-06-01');
  });

  test('works for a single station', async () => {
    const res = await request(app).get('/stations/8516945/historical?start=earliest&end=2012-12-31&resolution=auto');
    expect(res.status).toBe(200);
    expect(res.body.start).toBe('1998-06-01');
  });

  test('a station established after `end` reports no data instead of a date error', async () => {
    const res = await request(app).get('/locations/nyc/historical?start=earliest&end=1950-12-31&resolution=auto');
    expect(res.status).toBe(200);
    expect(res.body.stations.find((s) => s.station === '8516945').error).toMatch(/No data was found/);
    expect(res.body.stations.find((s) => s.station === '8518750').readings.length).toBeGreaterThan(0);
  });

  test('400 when an explicit resolution cannot cover the whole record', async () => {
    const res = await request(app).get('/stations/8518750/historical?start=earliest&end=2012-12-31&resolution=6min');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/full record needs resolution=daily or auto/);
    expect(calls).toHaveLength(0);
  });
});
