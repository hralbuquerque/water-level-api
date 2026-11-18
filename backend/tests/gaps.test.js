import { test, describe, afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { findGaps } from '../src/noaa.js';

afterEach(() => vi.unstubAllGlobals());

const row = (t, v = 1) => ({ t, v });

describe('findGaps', () => {
  test('no gaps when every expected reading is there', () => {
    const readings = [row('2012-10-29T00:00:00.000Z'), row('2012-10-29T00:06:00.000Z'), row('2012-10-29T00:12:00.000Z')];
    expect(findGaps(readings, '2012-10-29T00:00', '2012-10-29T00:12', '6min')).toEqual({ expected: 3, missing: 0, gaps: [] });
  });

  test('rows absent within a chunk and null values are both gaps, merged when contiguous', () => {
    const readings = [
      row('2012-10-29T00:00:00.000Z'),
      row('2012-10-29T00:06:00.000Z', null),
      // 00:12 absent
      row('2012-10-29T00:18:00.000Z'),
    ];
    expect(findGaps(readings, '2012-10-29T00:00', '2012-10-29T00:18', '6min')).toEqual({
      expected: 4,
      missing: 2,
      gaps: [{ start: '2012-10-29T00:06:00.000Z', end: '2012-10-29T00:12:00.000Z', missing: 2 }],
    });
  });

  test('a missing stretch at the start or end of the range counts', () => {
    const { gaps } = findGaps([row('2012-10-29T12:00:00.000Z')], '2012-10-29', '2012-10-29', 'hourly');
    expect(gaps).toEqual([
      { start: '2012-10-29T00:00:00.000Z', end: '2012-10-29T11:00:00.000Z', missing: 12 },
      { start: '2012-10-29T13:00:00.000Z', end: '2012-10-29T23:00:00.000Z', missing: 11 },
    ]);
  });

  test('never expects readings after now', () => {
    const now = Date.parse('2012-10-29T01:00:00Z');
    const r = findGaps([row('2012-10-29T00:00:00.000Z'), row('2012-10-29T01:00:00.000Z')], '2012-10-29', '2012-10-29', 'hourly', { now });
    expect(r).toEqual({ expected: 2, missing: 0, gaps: [] });
  });

  test('daily is counted by date', () => {
    const readings = [row('2012-10-28T22:00:00.000Z'), row('2012-10-30T01:24:00.000Z')];
    expect(findGaps(readings, '2012-10-28', '2012-10-30', 'daily').gaps).toEqual([{ start: '2012-10-29', end: '2012-10-29', missing: 1 }]);
  });

  test('start=earliest only counts from the first reading', () => {
    const r = findGaps([row('2000-01-01T00:00:00.000Z')], '1990-01-01', '2000-01-01', 'daily', { fromFirstReading: true });
    expect(r).toEqual({ expected: 1, missing: 0, gaps: [] });
  });
});

describe('historical responses report gaps', () => {
  test('an empty chunk in the middle of a range (a gauge outage) shows up in coverage', async () => {
    // Hourly, 3 days at 1 day per... hourly pages by year, so use 6min over 63 days: 3 chunks of 31
    // Like NOAA: every 6-minute reading in the requested chunk, except one chunk (Feb 1 – Mar 2) that is an outage
    const toIso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    vi.stubGlobal('fetch', async (url) => {
      const p = new URL(url).searchParams;
      if (p.get('begin_date') === '20120201') return { ok: true, json: async () => ({ error: { message: 'No data was found.' } }) };
      const data = [];
      const last = Date.parse(`${toIso(p.get('end_date'))}T23:54:00Z`);
      for (let t = Date.parse(`${toIso(p.get('begin_date'))}T00:00:00Z`); t <= last; t += 360_000) {
        data.push({ t: new Date(t).toISOString().slice(0, 16).replace('T', ' '), v: '1.0', s: '0', f: '0,0,0,0', q: 'v' });
      }
      return { ok: true, json: async () => ({ data }) };
    });
    const res = await request(buildApp()).get('/stations/8518750/historical?start=2012-01-01&end=2012-03-04');
    expect(res.status).toBe(200);
    const { coverage } = res.body;
    // The whole of the second chunk (Feb 1 – Mar 2) is missing
    const outage = coverage.gaps.find((g) => g.start === '2012-02-01T00:00:00.000Z');
    expect(outage).toBeDefined();
    expect(outage.end).toBe('2012-03-02T23:54:00.000Z');
    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.missing).toBe(31 * 240);
    expect(coverage.expected).toBe(64 * 240);
  });

  test('location responses carry coverage for each gauge', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [{ t: '2012-10-29 23:00', v: '4.21', s: '0.02', f: '0,0,0,0', q: 'v' }] }) }));
    const res = await request(buildApp()).get('/locations/nyc/historical?start=2012-10-29T23:00&end=2012-10-29T23:06');
    expect(res.status).toBe(200);
    for (const s of res.body.stations) {
      expect(s.coverage).toEqual({ expected: 2, missing: 1, gaps: [{ start: '2012-10-29T23:06:00.000Z', end: '2012-10-29T23:06:00.000Z', missing: 1 }] });
    }
  });
});
