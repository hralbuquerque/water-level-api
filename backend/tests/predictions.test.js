import { test, describe, afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { PREDICTION_INTERVALS, fetchPredictions, parsePredictions, predictionsError } from '../src/noaa.js';

afterEach(() => vi.unstubAllGlobals());

/**
 * Stub fetch. `body` is a NOAA response, or a function of the request's search
 * params returning one. Records every requested URL.
 */
function stubNoaa(body) {
  const urls = [];
  vi.stubGlobal('fetch', async (url) => {
    const u = new URL(url);
    urls.push(u);
    const json = typeof body === 'function' ? body(u.searchParams) : body;
    return { ok: true, statusText: 'OK', json: async () => json };
  });
  return urls;
}

// NOAA's predictions product returns rows under `predictions`, not `data`
const sixMin = { predictions: [{ t: '2026-11-17 00:00', v: '-1.554' }, { t: '2026-11-17 00:06', v: '-1.565' }] };
const hilo = { predictions: [{ t: '2026-11-17 00:28', v: '-1.586', type: 'L' }, { t: '2026-11-17 06:38', v: '1.194', type: 'H' }] };

describe('fetchPredictions', () => {
  test('asks NOAA for predictions at the interval, datum and dates given', async () => {
    const urls = stubNoaa(sixMin);
    await fetchPredictions('8518750', '2026-11-17', '2026-11-18', '6min');

    expect(urls).toHaveLength(1);
    const p = urls[0].searchParams;
    expect(p.get('product')).toBe('predictions');
    expect(p.get('interval')).toBe('6');
    expect(p.get('datum')).toBe('MSL');
    expect(p.get('begin_date')).toBe('20261117');
    expect(p.get('end_date')).toBe('20261118');
  });

  test('parses the `predictions` field into { t, v } rows', async () => {
    stubNoaa(sixMin);
    expect(await fetchPredictions('8518750', '2026-11-17', '2026-11-17')).toEqual([
      { station: '8518750', datum: 'MSL', units: 'english', t: '2026-11-17T00:00:00.000Z', v: -1.554 },
      { station: '8518750', datum: 'MSL', units: 'english', t: '2026-11-17T00:06:00.000Z', v: -1.565 },
    ]);
  });

  test('hilo uses NOAA\'s "hilo" interval and labels each row high or low', async () => {
    const urls = stubNoaa(hilo);
    const rows = await fetchPredictions('8518750', '2026-11-17', '2026-11-17', 'hilo');
    expect(urls[0].searchParams.get('interval')).toBe('hilo');
    expect(rows.map((r) => r.type)).toEqual(['low', 'high']);
  });

  test('NAVD88 is sent to NOAA as NAVD', async () => {
    const urls = stubNoaa(sixMin);
    const rows = await fetchPredictions('8518750', '2026-11-17', '2026-11-17', '6min', 'NAVD88');
    expect(urls[0].searchParams.get('datum')).toBe('NAVD');
    expect(rows[0].datum).toBe('NAVD88');
  });

  test('splits long ranges into chunks and keeps requested times on the ends', async () => {
    const urls = stubNoaa(sixMin);
    await fetchPredictions('8518750', '2026-01-01T06:00', '2026-06-30T18:00', '6min');
    expect(urls.length).toBe(2); // 181 days at 92 days per request
    expect(urls[0].searchParams.get('begin_date')).toBe('20260101 06:00');
    expect(urls.at(-1).searchParams.get('end_date')).toBe('20260630 18:00');
  });

  test('throws when NOAA has no predictions for the whole range', async () => {
    stubNoaa({ error: { message: 'No Predictions data was found. Please make sure the Datum input is valid.' } });
    await expect(fetchPredictions('8518750', '2026-11-17', '2026-11-17')).rejects.toThrow(/No predictions were found/);
  });

  test('refuses stations without predictions, without calling NOAA', async () => {
    const urls = stubNoaa(sixMin);
    await expect(fetchPredictions('8776604', '2026-11-17', '2026-11-17')).rejects.toThrow(/has no tide predictions/); // Baffin Bay
    expect(urls).toHaveLength(0);
  });

  test('subordinate stations only allow hilo', () => {
    const sub = { id: '1', predictions: 'subordinate' };
    expect(predictionsError(sub, '6min')).toMatch(/only interval=hilo/);
    expect(predictionsError(sub, 'hilo')).toBeNull();
    expect(predictionsError({ id: '2', predictions: 'harmonic' }, '1min')).toBeNull();
  });

  test('every interval stays within NOAA\'s 3655-day request limit', () => {
    for (const config of Object.values(PREDICTION_INTERVALS)) {
      expect(config.chunkDays).toBeLessThanOrEqual(3655);
      expect(typeof config.maxDays).toBe('number');
    }
  });

  test('parsePredictions rejects a non-array', () => {
    expect(() => parsePredictions({})).toThrow(/non-array/);
  });
});

describe('prediction routes', () => {
  const app = buildApp();

  test('GET /stations/:id/predictions returns predictions with their basis', async () => {
    stubNoaa(sixMin);
    const res = await request(app).get('/stations/8518750/predictions?start=2026-11-17&end=2026-11-18');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      station: '8518750',
      name: 'The Battery',
      kind: 'astronomical tide prediction',
      interval: '6min',
      datum: 'MSL',
      units: 'english',
      timeZone: 'GMT',
    });
    expect(res.body.resolution).toBeUndefined();
    expect(res.body.predictions[0]).toMatchObject({ t: '2026-11-17T00:00:00.000Z', v: -1.554 });
  });

  test('future dates are allowed', async () => {
    stubNoaa(sixMin);
    const res = await request(app).get('/stations/8518750/predictions?start=2030-01-01&end=2030-01-02');
    expect(res.status).toBe(200);
  });

  test('400s for a bad interval, a too-long range, a missing date and an unavailable datum', async () => {
    const urls = stubNoaa(sixMin);
    const bad = await request(app).get('/stations/8518750/predictions?start=2026-11-17&end=2026-11-18&interval=2min');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/interval must be one of/);

    const long = await request(app).get('/stations/8518750/predictions?start=2026-01-01&end=2027-06-01&interval=6min');
    expect(long.status).toBe(400);
    expect(long.body.error).toMatch(/maximum at the 6min interval is 366/);

    const missing = await request(app).get('/stations/8518750/predictions?start=2026-11-17');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/required/);

    const navd = await request(app).get('/stations/1612340/predictions?start=2026-11-17&end=2026-11-18&datum=NAVD88');
    expect(navd.status).toBe(400);
    expect(navd.body.error).toMatch(/has no NAVD88 datum/);

    expect(urls).toHaveLength(0);
  });

  test('404s for a station without predictions or one we don\'t serve', async () => {
    const none = await request(app).get('/stations/8776604/predictions?start=2026-11-17&end=2026-11-18');
    expect(none.status).toBe(404);
    expect(none.body.error).toMatch(/has no tide predictions/);

    const unsupported = await request(app).get('/stations/9063020/predictions?start=2026-11-17&end=2026-11-18');
    expect(unsupported.status).toBe(404);
    expect(unsupported.body.error).toMatch(/no MSL or NAVD88 datum/);
  });

  test('GET /locations/:loc/predictions returns every gauge, hilo with types', async () => {
    const urls = stubNoaa(hilo);
    const res = await request(app).get('/locations/nyc/predictions?start=2026-11-17&end=2026-11-17&interval=hilo&datum=NAVD88');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ location: 'nyc', interval: 'hilo', datum: 'NAVD88' });
    expect(res.body.stations).toHaveLength(3);
    expect(res.body.stations.every((s) => s.datum === 'NAVD88' && s.predictions[1].type === 'high')).toBe(true);
    expect(urls.every((u) => u.searchParams.get('datum') === 'NAVD')).toBe(true);
  });

  test('one gauge failing gives that gauge an error, not the whole location', async () => {
    stubNoaa((p) => (p.get('station') === '8531680' ? { error: { message: 'Station is offline' } } : sixMin));
    const res = await request(app).get('/locations/nyc/predictions?start=2026-11-17&end=2026-11-17');
    expect(res.status).toBe(200);
    const sandyHook = res.body.stations.find((s) => s.station === '8531680');
    expect(sandyHook.error).toMatch(/Station is offline/);
    expect(res.body.stations.filter((s) => s.predictions)).toHaveLength(2);
  });
});
