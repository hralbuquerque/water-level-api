import { test, describe, afterEach, expect, vi } from 'vitest';
import { fetchLatest } from '../src/noaa.js';

afterEach(() => vi.unstubAllGlobals());

/** Stub fetch with a fixed NOAA body and record every requested URL. */
function stubNoaa(body, ok = true) {
  const urls = [];
  vi.stubGlobal('fetch', async (url) => {
    urls.push(new URL(url));
    return { ok, statusText: ok ? 'OK' : 'Bad Gateway', json: async () => body };
  });
  return urls;
}

describe('fetchLatest', () => {
  test('asks NOAA for the latest 1-minute water level', async () => {
    const urls = stubNoaa({ data: [{ t: '2026-11-11 22:24', v: '2.385', s: '0.285', f: '1,0,0,0', q: 'p' }] });
    await fetchLatest('8518750');

    expect(urls).toHaveLength(1);
    const url = urls[0];
    expect(url.origin + url.pathname).toBe('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter');
    expect(url.searchParams.get('station')).toBe('8518750');
    expect(url.searchParams.get('product')).toBe('one_minute_water_level');
    expect(url.searchParams.get('date')).toBe('latest');
    expect(url.searchParams.get('datum')).toBe('MSL');
    expect(url.searchParams.get('time_zone')).toBe('gmt');
    expect(url.searchParams.has('begin_date')).toBe(false);
  });

  test('returns one parsed reading', async () => {
    stubNoaa({ data: [{ t: '2026-11-11 22:24', v: '2.385', s: '0.285', f: '1,0,0,0', q: 'p' }] });
    expect(await fetchLatest(8518750)).toEqual({
      station: '8518750',
      datum: 'MSL',
      units: 'english',
      t: '2026-11-11T22:24:00.000Z',
      v: 2.385,
      s: 0.285,
      f: '1,0,0,0',
      q: 'p',
    });
  });

  test('returns null when the gauge has reported nothing recently', async () => {
    stubNoaa({ error: { message: 'No data was found. This product may not be offered at this station at the requested time.' } });
    expect(await fetchLatest('8518750')).toBeNull();
  });

  test('1-minute rows carry only t and v, and are marked preliminary', async () => {
    stubNoaa({ data: [{ t: '2026-11-11 23:45', v: '3.743' }] });
    expect(await fetchLatest('8518750')).toMatchObject({ t: '2026-11-11T23:45:00.000Z', v: 3.743, s: null, f: null, q: 'p' });
  });

  test('returns null for an empty data list', async () => {
    stubNoaa({ data: [] });
    expect(await fetchLatest('8518750')).toBeNull();
  });

  test('refuses a station with neither MSL nor NAVD88, without calling NOAA', async () => {
    const urls = stubNoaa({ data: [] });
    await expect(fetchLatest('9063020')).rejects.toThrow('has no MSL or NAVD88 datum');
    expect(urls).toHaveLength(0);
  });

  test('throws on other NOAA errors', async () => {
    stubNoaa({ error: { message: 'Station ID is invalid' } });
    await expect(fetchLatest('8518750')).rejects.toThrow('NOAA API error: Station ID is invalid');
    stubNoaa(null, false);
    await expect(fetchLatest('8518750')).rejects.toThrow('NOAA API error: Bad Gateway');
  });
});

describe('latest routes', async () => {
  const { default: request } = await import('supertest');
  const { buildApp } = await import('../src/app.js');
  const app = buildApp();
  const row = { t: '2026-11-11 22:24', v: '2.385', s: '0.285', f: '1,0,0,0', q: 'p' };

  test('GET /stations/:id/latest returns the reading', async () => {
    stubNoaa({ data: [row] });
    const res = await request(app).get('/stations/8518750/latest');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ station: '8518750', name: 'The Battery', resolution: '1min', datum: 'MSL' });
    expect(res.body.reading).toMatchObject({ t: '2026-11-11T22:24:00.000Z', v: 2.385, q: 'p' });
  });

  test('GET /stations/:id/latest returns 404 explaining a station without MSL or NAVD88', async () => {
    const res = await request(app).get('/stations/9063020/latest');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no MSL or NAVD88 datum/);
  });

  test('?datum=NAVD88 reads a station on NAVD88 instead of its MSL default', async () => {
    const urls = stubNoaa({ data: [row] });
    const res = await request(app).get('/stations/8518750/latest?datum=NAVD88');
    expect(res.status).toBe(200);
    expect(urls[0].searchParams.get('datum')).toBe('NAVD'); // NOAA's data API spelling
    expect(res.body.datum).toBe('NAVD88');
    expect(res.body.reading.datum).toBe('NAVD88');
  });

  test('?datum= rejects unknown datums and ones the station lacks, without calling NOAA', async () => {
    const urls = stubNoaa({ data: [row] });
    const bad = await request(app).get('/stations/8518750/latest?datum=MLLW');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/datum must be one of: MSL, NAVD88/);
    const lacking = await request(app).get('/stations/1612340/latest?datum=NAVD88'); // Honolulu: MSL only
    expect(lacking.status).toBe(400);
    expect(lacking.body.error).toMatch(/has no NAVD88 datum/);
    expect(urls).toHaveLength(0);
  });

  test('GET /locations/:loc/latest?datum=NAVD88 applies it to every gauge', async () => {
    const urls = stubNoaa({ data: [row] });
    const res = await request(app).get('/locations/nyc/latest?datum=NAVD88');
    expect(res.status).toBe(200);
    expect(res.body.datum).toBe('NAVD88');
    expect(res.body.stations.every((s) => s.datum === 'NAVD88')).toBe(true);
    expect(urls.every((u) => u.searchParams.get('datum') === 'NAVD')).toBe(true);
  });

  test('GET /stations/:id/latest gives reading: null for a quiet gauge', async () => {
    stubNoaa({ error: { message: 'No data was found.' } });
    const res = await request(app).get('/stations/8518750/latest');
    expect(res.status).toBe(200);
    expect(res.body.reading).toBeNull();
  });

  test('GET /stations/:id/latest returns 404 for an unknown station and 502 on NOAA errors', async () => {
    expect((await request(app).get('/stations/0000000/latest')).status).toBe(404);
    stubNoaa({ error: { message: 'Station ID is invalid' } });
    const res = await request(app).get('/stations/8518750/latest');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Station ID is invalid/);
  });

  test('GET /locations/:loc/latest returns every gauge, keeping per-gauge errors', async () => {
    vi.stubGlobal('fetch', async (url) => {
      const station = new URL(url).searchParams.get('station');
      const body = station === '8531680' ? { error: { message: 'Station ID is invalid' } } : { data: [row] };
      return { ok: true, json: async () => body };
    });
    const res = await request(app).get('/locations/nyc/latest');
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('nyc');
    expect(res.body.stations.map((s) => s.station)).toEqual(['8518750', '8531680', '8516945']);
    expect(res.body.stations[0].reading.v).toBe(2.385);
    expect(res.body.stations[1].error).toMatch(/Station ID is invalid/);
    expect((await request(app).get('/locations/atlantis/latest')).status).toBe(404);
  });
});
