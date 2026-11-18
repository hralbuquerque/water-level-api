/**
 * Historical readings page (#/historical).
 *
 * Flow: the form (location/gauge, dates, resolution, datum, predictions, optional trigger) is mirrored
 * into the URL -> "Get readings" calls the backend -> the response becomes one
 * "series" per gauge -> summary cards, a chart or table, and a CSV export. With
 * predictions on, the matching tide predictions are fetched next and drawn alongside.
 *
 * Components in this file
 * Layout follows the company's "Build a bond" page: a back link + title header,
 * then numbered section cards (01 Request, 02 Readings, 03 Readings table).
 *
 * Components in this file
 *   ReadingsPage  header, sections, form, request lifecycle (loading / cancel / errors), URL state
 *   Results         section 02's content for one response
 *   Summary         the per-gauge card: peak, status mix, coverage, trigger hits
 *   ReadingsTable   section 03, paged in the browser
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchDirectory, fetchHistorical, fetchPredictions } from '../api.js';
import { ActionButton } from '../theme/Primitives.jsx';
import Section, { SubLabel } from '../components/Section.jsx';
import ReadingsChart from './ReadingsChart.jsx';
import TargetPicker from './TargetPicker.jsx';
import { formatResidual, maxResidual, predictionRequestFor, toPredictionSeries } from './predictions.js';
import {
  EARLIEST,
  RESOLUTIONS,
  addDays,
  boundMs,
  formatBound,
  formatDate,
  formatDateTime,
  formatDuration,
  latestWindow,
  rangeBounds,
  rangeProblem,
  resolveResolution,
  timeProblem,
  todayUtc,
} from './time.js';
import './readings.css';

const SERIES_SLOTS = 8; // number of --series-N colors defined in readings.css
// Resolution the "Latest" preset always uses
const LATEST_RESOLUTION = '1min';
const TABLE_PAGE = 500; // table rows per page; a year of data can be ~260k rows

// Quick date ranges. `range` receives today's UTC date and returns [start, end].
// "Latest" has no `range`: it is the last hour of 1-minute data up to the moment
// it runs (latestWindow in time.js), so its dates and times are filled in then.
const PRESETS = [
  { id: 'latest', label: 'Latest', latest: true },
  { id: '7d', label: 'Last 7 days', range: (t) => [addDays(t, -6), t] },
  { id: '30d', label: 'Last 30 days', range: (t) => [addDays(t, -29), t] },
  { id: '1y', label: 'Last 12 months', range: (t) => [addDays(t, -364), t] },
  { id: '10y', label: 'Last 10 years', range: (t) => [addDays(t, -3652), t] },
  // TODO: Start at date where the data starts for each station
  // Back to each gauge's first reading, however old (see EARLIEST in time.js)
  { id: 'all', label: 'All history', range: (t) => [EARLIEST, t] },
  { id: 'sandy', label: 'Hurricane Sandy, 2012', range: () => ['2012-10-22', '2012-11-05'] }, //IDK if i want this
];

const RESOLUTION_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: '1min', label: '1-minute, preliminary (up to 31 days)' },
  { id: '6min', label: '6-minute (up to 1 year)' },
  { id: 'hourly', label: 'Hourly, verified (up to 10 years)' },
  { id: 'daily', label: 'Daily max, verified (any range)' },
];

// Times of day used while the time inputs are off: whole days
const DAY_START = '00:00';
const DAY_END = '23:59';

// What a fresh visit shows: NYC during Hurricane Sandy, the project's proof point.
// `latest` is true while the "Latest" chip is selected; `useTime` is the "Time range"
// checkbox. The time inputs only apply when one of them is on (see timesOn).
const DEFAULT_FORM = {
  target: 'location:nyc',
  start: '2012-10-22',
  end: '2012-11-05',
  startTime: DAY_START,
  endTime: DAY_END,
  useTime: false,
  resolution: 'auto',
  datum: '', // '' = each gauge's default (MSL); or 'MSL' / 'NAVD88' when chosen
  predictions: true, // also fetch NOAA tide predictions and compare them with the readings
  trigger: '',
  // The datum the trigger level is stated on. A level only means something on a
  // datum, so it's kept with the number and the line is drawn only on that datum.
  triggerDatum: 'MSL',
  latest: false,
};

// Datums the API serves, in preference order, with labels for the picker
const DATUM_OPTIONS = [
  { id: 'MSL', label: 'MSL (mean sea level)' },
  { id: 'NAVD88', label: 'NAVD88 (North American Vertical Datum of 1988)' },
];

/** Whether the form's time inputs are active (and sent to the API). */
const timesOn = (form) => form.latest || form.useTime;

// ---- URL state: #/historical?target=location:nyc&start=...&end=...&resolution=auto&datum=NAVD88&trigger=10&triggerDatum=NAVD88
// With a time range, start/end carry the time too (start=2026-11-11T21:00); "Latest"
// is stored as latest=1 and always means the last hour when the link is opened.
// Keeping the form in the URL means any view can be bookmarked or shared as a link.

/** The form encoded in the current URL, or null if the URL doesn't hold a complete one. */
function readFormFromHash() {
  const query = window.location.hash.split('?')[1];
  if (!query) return null;
  const p = new URLSearchParams(query);
  if (!p.get('target') || !p.get('start') || !p.get('end')) return null;
  const latest = p.get('latest') === '1';
  const [start, startTime] = p.get('start').split('T');
  const [end, endTime] = p.get('end').split('T');
  return {
    target: p.get('target'),
    start,
    end,
    startTime: startTime ?? DAY_START,
    endTime: endTime ?? DAY_END,
    useTime: Boolean(startTime || endTime),
    resolution: RESOLUTION_OPTIONS.some((o) => o.id === p.get('resolution')) ? p.get('resolution') : 'auto',
    datum: DATUM_OPTIONS.some((o) => o.id === p.get('datum')) ? p.get('datum') : '',
    predictions: p.get('predictions') !== '0',
    trigger: p.get('trigger') ?? '',
    // Older links have no triggerDatum: their trigger was on the link's datum
    triggerDatum: DATUM_OPTIONS.find((o) => o.id === (p.get('triggerDatum') ?? p.get('datum')))?.id ?? 'MSL',
    latest,
    // A "Latest" link means the last hour now, whenever it was saved
    ...(latest && { ...latestWindow(), useTime: false, resolution: LATEST_RESOLUTION }),
  };
}

/**
 * Record a submitted form in the URL. replaceState (rather than setting
 * location.hash) avoids a "hashchange" event and doesn't add a history entry
 * for every search.
 */
function writeFormToHash(form) {
  const [start, end] = rangeBounds(form, timesOn(form));
  const p = new URLSearchParams({ target: form.target, start, end, resolution: form.resolution });
  if (form.datum) p.set('datum', form.datum);
  if (!form.predictions) p.set('predictions', '0'); // on by default, so only "off" is recorded
  if (form.trigger !== '') {
    p.set('trigger', form.trigger);
    p.set('triggerDatum', form.triggerDatum);
  }
  if (form.latest) p.set('latest', '1');
  window.history.replaceState(null, '', `#/historical?${p}`);
}

// "location:nyc" -> { type: 'location', id: 'nyc' }; "station:8518750" -> { type: 'station', ... }
const parseTarget = (key) => {
  const [type, ...rest] = key.split(':');
  return { type, id: rest.join(':') };
};

// Which preset chip a form corresponds to, so a shared link highlights the right one.
// "Latest" matches by its flag; the others by their whole-day dates, without times.
const presetFor = ({ start, end, latest, useTime }) =>
  PRESETS.find((p) => {
    if (p.latest) return latest;
    if (latest || useTime) return false;
    const [s, e] = p.range(todayUtc());
    return s === start && e === end;
  })?.id ?? 'custom';

/** The target's gauges as listed in the directory (each with `established`, `datums`, ...). */
function gaugesFor(targetKey, directory) {
  const { type, id } = parseTarget(targetKey);
  return type === 'location'
    ? directory.locations.find((l) => l.id === id)?.stations ?? []
    : directory.stations.filter((s) => s.id === id);
}

/**
 * The datums every gauge in the target offers, in preference order: ['MSL', 'NAVD88']
 * when they all have NAVD88 too, otherwise ['MSL']. Empty until the directory loads.
 */
function datumsFor(targetKey, directory) {
  const gauges = gaugesFor(targetKey, directory);
  if (!gauges.length) return [];
  return DATUM_OPTIONS.map((o) => o.id).filter((d) => gauges.every((g) => g.datums?.includes(d)));
}

/**
 * The oldest `established` date among the target's gauges (YYYY-MM-DD), or null if
 * unknown. Used to give the From field a sensible date when leaving "All history".
 */
function establishedFor(targetKey, directory) {
  const dates = gaugesFor(targetKey, directory).map((s) => s.established).filter(Boolean).sort();
  return dates[0] ?? null;
}

// The trigger input as a number, or null when empty or not a number
const parseTrigger = (raw) => {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// ---- Shaping API responses

/** Normalise location and station responses into one list of gauges, colors fixed by gauge order */
function toSeries(data) {
  const gauges = data.stations ?? [{ station: data.station, name: data.name, readings: data.readings }];
  return gauges.map((g, i) => {
    const readings = g.readings ?? [];
    return {
      id: g.station,
      name: g.name,
      error: g.error ?? null,
      coverage: g.coverage ?? null, // where readings are missing (see findGaps in the API)
      color: `var(--series-${(i % SERIES_SLOTS) + 1})`,
      readings,
      times: readings.map((r) => Date.parse(r.t)),
      values: readings.map((r) => r.v),
    };
  });
}

/**
 * Figures for one gauge's summary card, in a single pass over its readings:
 * peak, verified share, readings without a value, coverage gaps at either end
 * of the range, and time spent at or above the trigger.
 */
function summarize(series, { resolution, start, end, trigger }) {
  const { stepMs } = RESOLUTIONS[resolution];
  let peak = null;
  let withValue = 0;
  let verified = 0;
  let above = 0;
  let firstAbove = null;
  let latest = null; // most recent reading with a value
  for (const r of series.readings) {
    if (r.q === 'v') verified++;
    if (r.v === null) continue;
    withValue++;
    latest = r;
    if (!peak || r.v > peak.v) peak = r;
    if (trigger !== null && r.v >= trigger) {
      above++;
      firstAbove ??= r;
    }
  }
  // Coverage: does the data start after `start` or stop before `end`? (gauge not built yet, destroyed in a storm, or verified data not published yet)
  const n = series.readings.length;
  const first = n ? series.readings[0].t.slice(0, 10) : null;
  const last = n ? series.readings[n - 1].t.slice(0, 10) : null;
  return {
    peak,
    latest,
    count: n,
    missing: n - withValue,
    verifiedShare: n ? verified / n : 0,
    startsLate: first && first > start.slice(0, 10) ? first : null, // dates only, so a time range doesn't count
    endsEarly: last && last < end.slice(0, 10) ? last : null,
    above,
    aboveLabel: resolution === 'daily' ? `${above.toLocaleString()} ${above === 1 ? 'day' : 'days'}` : formatDuration(above * stepMs),
    firstAbove,
    gaps: describeGaps(series.coverage, resolution),
  };
}

/** "3 days" for daily data, "2 h 30 min" otherwise: how long `n` missing readings span. */
const missingSpan = (n, resolution) =>
  resolution === 'daily' ? `${n.toLocaleString()} ${n === 1 ? 'day' : 'days'}` : formatDuration(n * RESOLUTIONS[resolution].stepMs);

/**
 * The API's coverage report as card text: how much is missing and the longest
 * gap. Null when nothing is missing (or the API didn't report coverage).
 */
function describeGaps(coverage, resolution) {
  if (!coverage?.missing) return null;
  const longest = coverage.gaps.reduce((a, b) => (b.missing > a.missing ? b : a));
  return {
    missing: missingSpan(coverage.missing, resolution),
    count: coverage.gaps.length,
    longest: { ...longest, span: missingSpan(longest.missing, resolution) },
  };
}

/**
 * Every reading as CSV, one row per reading per gauge. Each row repeats the
 * resolution, datum, units and retrieval time so a row copied out on its own is
 * still a complete record for settlement.
 */
function toCsv(result, predictions) {
  const { data, series } = result;
  // predicted_ft is NOAA's astronomical tide at the reading's time (for daily data, the day's
  // highest predicted high tide); residual_ft is the reading minus it. Empty without predictions.
  const cols = ['station', 'name', 'time_utc', 'value_ft', 'predicted_ft', 'residual_ft', 'quality', 'flags', 'sigma', 'daily_min_time_utc', 'daily_min_ft', 'pct_complete', 'source', 'resolution', 'datum', 'units', 'retrieved_at'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const s of series) {
    const pred = predictions?.get(s.id);
    for (const r of s.readings) {
      const p = pred && !pred.error ? pred.valueFor(r) : null;
      const residual = p !== null && r.v !== null ? Number((r.v - p).toFixed(3)) : null;
      lines.push(
        [s.id, s.name, r.t, r.v, p, residual, r.q, r.f, r.s, r.tMin, r.vMin, r.complete, r.source, data.resolution, r.datum ?? data.datum, data.units, data.retrievedAt]
          .map(esc)
          .join(','),
      );
    }
  }
  return lines.join('\n');
}

/** Trigger a browser download of the CSV via a temporary object URL. */
function downloadCsv(result, predictions) {
  const blob = new Blob([toCsv(result, predictions)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const target = parseTarget(result.form.target);
  a.href = url;
  const fileSafe = (bound) => bound.replace(':', ''); // "2026-11-11T21:00" -> "2026-11-11T2100"
  a.download = `water-levels_${target.id}_${fileSafe(result.data.start)}_${fileSafe(result.data.end)}_${result.data.resolution}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Page

export default function ReadingsPage() {
  // The form to start from: a shared link's settings, or the default. Read once.
  const initial = useRef(readFormFromHash() ?? DEFAULT_FORM).current;
  const [form, setForm] = useState(initial); // what the inputs show (not yet submitted)
  const [preset, setPreset] = useState(() => presetFor(initial)); // highlighted chip, or 'custom'
  const [directory, setDirectory] = useState({ status: 'loading', locations: [], stations: [] });
  const [request, setRequest] = useState({ status: 'idle' }); // idle | loading | error
  // The last successful response, with the form that produced it. It stays on
  // screen (dimmed) while a new request loads, so the page doesn't jump.
  const [result, setResult] = useState(null);
  const [tablePage, setTablePage] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef(null); // AbortController of the request in flight, for Cancel and re-submits
  const [focusStart, setFocusStart] = useState(false); // focus the From date after leaving "All history"
  // Section 01 is controlled so the "Edit" link in section 02 can reopen it
  const [requestOpen, setRequestOpen] = useState(true);
  // "Highlight key fields": outlines the inputs and values a trigger depends on
  const [highlight, setHighlight] = useState(false);

  // Load the picker's options (locations + every station) once
  useEffect(() => {
    const ctl = new AbortController();
    fetchDirectory({ signal: ctl.signal })
      .then((d) => setDirectory({ status: 'ok', ...d }))
      .catch((e) => e.name !== 'AbortError' && setDirectory({ status: 'error', message: e.message, locations: [], stations: [] }));
    return () => ctl.abort();
  }, []);

  // Seconds counter while a request is running
  useEffect(() => {
    if (request.status !== 'loading') return undefined;
    const startedAt = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [request.status]);

  /**
   * Submit a form: check it locally, cancel any request still running, record the
   * form in the URL, then fetch. Responses from cancelled requests are ignored.
   */
  const run = (f) => {
    // "Latest" is always the hour up to the moment it runs, at 1-minute resolution
    if (f.latest) {
      f = { ...f, ...latestWindow(), resolution: LATEST_RESOLUTION };
      setForm(f); // show the window that was actually requested
    }
    const problem = rangeProblem(f.start, f.end, f.resolution) ?? (timesOn(f) ? timeProblem(f) : null);
    if (problem) {
      setRequest({ status: 'error', message: problem });
      return;
    }
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    writeFormToHash(f);
    setRequest({ status: 'loading', resolution: resolveResolution(f.start, f.end, f.resolution) });
    const [start, end] = rangeBounds(f, timesOn(f));
    fetchHistorical(parseTarget(f.target), { start, end, resolution: f.resolution, datum: f.datum }, { signal: ctl.signal })
      .then((data) => {
        setResult({ form: f, data, series: toSeries(data), predictions: f.predictions ? { status: 'loading' } : null });
        setRequest({ status: 'idle' });
        setTablePage(0);
        if (f.predictions) loadPredictions(f, data, ctl.signal);
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setRequest({ status: 'error', message: e.message });
      });
  };

  /**
   * Fetch the tide predictions matching a readings response (same gauges, range and
   * datum) and attach them to that result. The readings are already on screen, so a
   * failure here only adds a note. A newer search replaces the result and wins.
   */
  const loadPredictions = (f, data, signal) => {
    const attach = (predictions) => setResult((r) => (r && r.data === data ? { ...r, predictions } : r));
    const req = predictionRequestFor(data);
    if (req.error) {
      attach({ status: 'error', message: req.error });
      return;
    }
    fetchPredictions(parseTarget(f.target), { ...req, datum: f.datum }, { signal })
      .then((resp) => attach({ status: 'ok', byStation: toPredictionSeries(resp, data.resolution) }))
      .catch((e) => e.name !== 'AbortError' && attach({ status: 'error', message: e.message }));
  };

  // Run the initial request once (default view, or a shared link)
  useEffect(() => {
    run(initial);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));
  // Clicking a chip fills in its dates; editing a date by hand switches to 'custom'
  const choosePreset = (id) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id);
    if (p?.latest) {
      update({ ...latestWindow(), latest: true, useTime: false, resolution: LATEST_RESOLUTION });
    } else if (p) {
      const [start, end] = p.range(todayUtc());
      // Presets are whole days, so they switch the time range off
      update({ start, end, latest: false, useTime: false, startTime: DAY_START, endTime: DAY_END });
    }
  };

  // "Edit" on the request summary: reopen section 01 and bring it into view
  const editRequest = () => {
    setRequestOpen(true);
    requestAnimationFrame(() => document.getElementById('hx-request')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  // Derived from the current (unsubmitted) form, so hints update while typing
  const loading = request.status === 'loading';
  const resolved = resolveResolution(form.start, form.end, form.resolution);
  const formProblem = rangeProblem(form.start, form.end, form.resolution);
  const triggerLevel = parseTrigger(form.trigger);
  // The datum picker offers NAVD88 only when every gauge in the target has it
  const datumChoices = datumsFor(form.target, directory);
  const datumValue = datumChoices.includes(form.datum) ? form.datum : datumChoices[0] ?? 'MSL';
  const trigger = triggerLevel === null ? null : { level: triggerLevel, datum: form.triggerDatum };

  return (
    <main className="hx-main" data-highlight={highlight ? 'on' : 'off'}>
      {/* Page header, as on the "Build a bond" page: back link, title, one-line subtitle */}
      <header className="page-head">
        <div className="page-head-top">
          <a href="#/" className="page-back">← Rhodex.</a>
          <label className="page-highlight">
            <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />
            Highlight key fields
          </label>
        </div>
        <h1 className="page-title">Readings</h1>
        <p className="page-sub">Pick a place and a date range, read every gauge, check it against a trigger.</p>
      </header>

      {/* 01: the request form */}
      <Section
        as="form"
        id="hx-request"
        number={1}
        title="Request"
        collapsible
        open={requestOpen}
        onToggle={setRequestOpen}
        onSubmit={(e) => {
          e.preventDefault();
          run(form);
        }}
      >
        <div className="sec-cols">
          <div className="sec-col">
            <SubLabel as="label" htmlFor="hx-target">Location</SubLabel>
            {directory.status === 'error' ? (
              <p className="hx-error" role="alert">{directory.message}</p>
            ) : (
              <TargetPicker
                locations={directory.locations}
                stations={directory.stations}
                value={form.target}
                // Drop a datum choice the new target doesn't offer, so it falls back to the default
                onChange={(target) => update({ target, ...(!datumsFor(target, directory).includes(form.datum) && { datum: '' }) })}
                disabled={directory.status !== 'ok'}
              />
            )}

            <fieldset className="hx-fieldset">
              <SubLabel as="legend">Date range (UTC)</SubLabel>
              <div className="hx-presets" role="radiogroup" aria-label="Preset ranges">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={preset === p.id}
                    className="hx-chip"
                    onClick={() => choosePreset(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="hx-dates">
                <label>
                  <span>From</span>
                  {form.start === EARLIEST ? (
                    // "All history": there's no single date to show, since each gauge starts at
                    // its own first reading. Clicking switches to a real date to edit, starting
                    // from the target's oldest established date.
                    <input
                      type="text"
                      className="hx-input hl"
                      value="Earliest record"
                      readOnly
                      title="Each gauge starts at its first reading. Click to pick a date instead."
                      onFocus={() => {
                        setPreset('custom');
                        update({ start: establishedFor(form.target, directory) ?? '1900-01-01', latest: false, useTime: timesOn(form) });
                        setFocusStart(true);
                      }}
                    />
                  ) : (
                    <input
                      type="date"
                      className="hx-input hl"
                      value={form.start}
                      max={todayUtc()}
                      required
                      autoFocus={focusStart}
                      onBlur={() => setFocusStart(false)}
                      onChange={(e) => {
                        setPreset('custom');
                        update({ start: e.target.value, latest: false, useTime: timesOn(form) });
                      }}
                    />
                  )}
                </label>
                <label>
                  <span>To</span>
                  <input
                    type="date"
                    className="hx-input hl"
                    value={form.end}
                    max={todayUtc()}
                    required
                    onChange={(e) => {
                      setPreset('custom');
                      update({ end: e.target.value, latest: false, useTime: timesOn(form) });
                    }}
                  />
                </label>
              </div>
              {/* Times of day under the dates. Dimmed (disabled) unless "Latest" or the
                  "Time range" checkbox is on; otherwise each range is whole days. */}
              <label className="hx-check">
                <input
                  type="checkbox"
                  checked={timesOn(form)}
                  disabled={form.latest}
                  title={form.latest ? 'Latest always uses a time range' : undefined}
                  onChange={(e) => {
                    setPreset('custom');
                    update({ useTime: e.target.checked });
                  }}
                />
                Time range
              </label>
              <div className={`hx-dates hx-times${timesOn(form) ? '' : ' is-off'}`}>
                <label>
                  <span>From time (UTC)</span>
                  <input
                    type="time"
                    className="hx-input hl"
                    value={form.startTime}
                    disabled={!timesOn(form)}
                    required={timesOn(form)}
                    onChange={(e) => {
                      setPreset('custom');
                      update({ startTime: e.target.value, latest: false, useTime: true });
                    }}
                  />
                </label>
                <label>
                  <span>To time (UTC)</span>
                  <input
                    type="time"
                    className="hx-input hl"
                    value={form.endTime}
                    disabled={!timesOn(form)}
                    required={timesOn(form)}
                    onChange={(e) => {
                      setPreset('custom');
                      update({ endTime: e.target.value, latest: false, useTime: true });
                    }}
                  />
                </label>
              </div>
            </fieldset>
          </div>

          <div className="sec-col">
            <SubLabel as="label" htmlFor="hx-resolution">Resolution</SubLabel>
            <SelectBox><select id="hx-resolution" className="hx-input" value={form.latest ? LATEST_RESOLUTION : form.resolution} disabled={form.latest} onChange={(e) => update({ resolution: e.target.value })}>
              {RESOLUTION_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === 'auto' && !formProblem ? `Auto (${RESOLUTIONS[resolved].label.toLowerCase()})` : o.label}
                </option>
              ))}
            </select></SelectBox>

            <SubLabel as="label" htmlFor="hx-datum">Datum</SubLabel>
            <SelectBox><select
              id="hx-datum"
              className="hx-input"
              value={datumValue}
              disabled={datumChoices.length < 2}
              title={datumChoices.length === 1 ? `Only ${datumChoices[0]} is available for this ${parseTarget(form.target).type === 'location' ? 'location' : 'gauge'}` : undefined}
              onChange={(e) => update({ datum: e.target.value })}
            >
              {(datumChoices.length ? DATUM_OPTIONS.filter((o) => datumChoices.includes(o.id)) : DATUM_OPTIONS.slice(0, 1)).map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select></SelectBox>
            {datumChoices.length === 1 && (
              <p className="hx-hint">NAVD88 isn't available {parseTarget(form.target).type === 'location' ? 'at every gauge here' : 'at this gauge'}, so readings are on MSL.</p>
            )}

            <label className="hx-check">
              <input type="checkbox" checked={form.predictions} onChange={(e) => update({ predictions: e.target.checked })} />
              Compare with tide predictions
            </label>
            {form.predictions && (
              <p className="hx-hint">
                Adds NOAA's predicted tide (the tide alone, no storm surge) as a dotted line, and a surge panel under the chart: observed minus predicted, or how far weather pushed the water.
              </p>
            )}

            <SubLabel as="label" htmlFor="hx-trigger">Reference trigger level (optional)</SubLabel>
            <div className="hx-suffix">
              <input
                id="hx-trigger"
                className="hx-input hl"
                type="number"
                inputMode="decimal"
                step="0.1"
                placeholder="e.g. 10"
                value={form.trigger}
                // Typing a level states it on the datum currently picked
                onChange={(e) => update({ trigger: e.target.value, triggerDatum: datumValue })}
              />
              <span>ft {form.trigger !== '' ? form.triggerDatum : datumValue}</span>
            </div>
            {triggerLevel !== null && form.triggerDatum !== datumValue && (
              <p className="hx-hint">
                This level is stated on {form.triggerDatum}, so it won't be drawn on {datumValue} readings. Re-enter it to state it on {datumValue}.
              </p>
            )}

            {/* Live hints about the form, shown before submitting */}
            {formProblem && !loading && request.status !== 'error' && <p className="hx-hint">{formProblem}</p>}
            {form.latest && (
              <p className="hx-hint">Latest fetches the last hour of 1-minute readings, up to when you press Get readings. 1-minute data is preliminary.</p>
            )}
            {!form.latest && (resolved === 'hourly' || resolved === 'daily') && !formProblem && (
              <p className="hx-hint">
                {RESOLUTIONS[resolved].label} data is verified only and runs one to two months behind. Use 6-minute for recent days.
              </p>
            )}
          </div>
        </div>

        {/* Centered action at the foot of the section, like "+ Add layer" */}
        <div className="sec-foot">
          {loading ? (
            <ActionButton type="button" tone="ghost" size="px-6 py-2.5 text-sm" onClick={() => {
              abortRef.current?.abort();
              setRequest({ status: 'idle' });
            }}>
              Cancel
            </ActionButton>
          ) : (
            <ActionButton type="submit" tone="primary" size="px-6 py-2.5 text-sm" disabled={directory.status !== 'ok'}>
              Get readings
            </ActionButton>
          )}
        </div>
      </Section>

      {/* 02: results */}
      <Section number={2} title="Readings" className={result && loading ? 'is-stale' : ''} aria-busy={loading}>
        {/* aria-live announces loading and errors to screen readers */}
        <div className="hx-status" aria-live="polite">
          {loading && (
            <p>
              Fetching {RESOLUTIONS[request.resolution].label.toLowerCase()} data from NOAA… {elapsed > 0 && `${elapsed} s`}
              {elapsed >= 3 && <span className="hx-muted"> Long ranges are paged in many NOAA requests and can take up to a minute.</span>}
            </p>
          )}
          {request.status === 'error' && (
            <p className="hx-error" role="alert">
              {request.message}
            </p>
          )}
        </div>
        {result ? (
          <Results result={result} trigger={trigger} showPredictions={form.predictions} directory={directory} onEdit={editRequest} />
        ) : (
          !loading && request.status !== 'error' && <p className="hx-muted">No readings yet. Fill in the request above.</p>
        )}
      </Section>

      {/* 03: every reading, collapsed by default like "02 Disclosure" (and only built when opened) */}
      {result && (
        <Section number={3} title="Readings table" collapsible defaultOpen={false}>
          <ReadingsTable
            series={result.series.filter((s) => !s.error)}
            resolution={result.data.resolution}
            trigger={trigger && trigger.datum === result.data.datum ? trigger.level : null}
            predictions={form.predictions && result.predictions?.status === 'ok' ? result.predictions.byStation : null}
            page={tablePage}
            setPage={setTablePage}
          />
        </Section>
      )}
    </main>
  );
}

/**
 * A native <select> with the location picker's chevron instead of the browser's
 * arrow, so every dropdown on the form has its caret in the same place.
 */
function SelectBox({ children }) {
  return (
    <span className="hx-select">
      {children}
      <svg className="hx-select-caret" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/**
 * Section 02's content for one response. `trigger` comes from the live form
 * (not the submitted one), so changing it updates the cards and chart instantly
 * without refetching.
 */
function Results({ result, trigger: stated, showPredictions, directory, onEdit }) {
  const { form, data, series } = result;
  // A level stated on one datum isn't comparable with readings on another, so it
  // only applies when it matches the readings' datum (null: gauges' datums differ)
  const trigger = stated && stated.datum === data.datum ? stated.level : null;
  const triggerMismatch = stated && stated.datum !== data.datum;
  const triggerText = trigger !== null && `${trigger.toFixed(2)} ft above ${data.datum}`;
  // Predictions show while the live checkbox is on; turning it off hides them without refetching
  const predState = showPredictions ? result.predictions : null;
  const predictions = predState?.status === 'ok' ? predState.byStation : null;
  const latest = Boolean(form.latest); // the "Latest" preset: the last hour of 1-minute data
  const resolution = data.resolution;
  const config = RESOLUTIONS[resolution];
  const ok = series.filter((s) => !s.error); // gauges with readings; failed ones only get a card
  // The range as the API reports it. Same as requested for fixed dates; for "All
  // history" `start` is the oldest reading found across the gauges.
  const { start, end } = data;
  // The chart's x range is that range (a date-only end runs to the end of the day),
  // not each gauge's own data, so a gauge with a shorter record shows empty space before it
  const domain = useMemo(() => [boundMs(start), boundMs(end, true)], [start, end]);
  const summaries = useMemo(
    () => series.map((s) => (s.error ? null : summarize(s, { resolution, start, end, trigger }))),
    [series, resolution, start, end, trigger],
  );
  // Each gauge's largest rise above the predicted tide
  const residuals = useMemo(
    () => series.map((s) => (s.error ? null : maxResidual(s, predictions?.get(s.id)))),
    [series, predictions],
  );
  // Gauges whose predictions failed (e.g. NOAA publishes none for that station)
  const predErrors = predictions ? ok.map((s) => ({ s, p: predictions.get(s.id) })).filter(({ p }) => p?.error) : [];
  const totalReadings = ok.reduce((n, s) => n + s.readings.length, 0);
  const valueLabel = resolution === 'daily' ? 'Daily maximum water level' : `${config.label} water level`;
  // The API reports each station's datum (MSL, else NAVD88); a location's top-level
  // datum is null only if its gauges don't share one.
  const unitsLabel = data.datum ? `ft above ${data.datum}` : 'ft above each gauge\'s datum';
  // Line styles the chart will use, for the legend: dashed only appears when a gauge mixes both
  const mixedQuality = ok.some((s) => s.readings.some((r) => r.q === 'p') && s.readings.some((r) => r.q !== 'p'));

  // "New York City" for a location (name from the directory), "The Battery" for a station
  const targetName = data.location
    ? directory.locations.find((l) => l.id === data.location.toLowerCase())?.name ?? data.location
    : data.name;

  // The highest reading across all gauges, for the headline sentence
  const top = summaries.reduce((best, sm, i) => (sm?.peak && (!best || sm.peak.v > best.peak.v) ? { peak: sm.peak, name: series[i].name } : best), null);

  return (
    <div className="hx-results">
      <div className="sec-cols">
        <div className="sec-col">
          <SubLabel>Your request</SubLabel>
          {/* Mono summary box with "Edit", like "Layer 1 · Economic loss · $4B trigger …" */}
          <div className="sec-summary hl">
            <p>
              {targetName} ·{' '}
              {latest ? 'last hour' : `${formatBound(start)} to ${formatBound(end)}`}
              {form.start === EARLIEST && ' (full record)'} · {config.label.toLowerCase()}
              {trigger !== null && ` · reference trigger ${triggerText}`}
            </p>
            <button type="button" className="sec-link" onClick={onEdit}>Edit</button>
          </div>
        </div>
        <div className="sec-col">
          <SubLabel>{latest ? 'Highest in the last hour' : 'Highest reading'}</SubLabel>
          {top ? (
            <p className="hx-headline">
              <strong className="hl-text">{top.peak.v.toFixed(2)} ft</strong> at {top.name}, {formatDateTime(top.peak.t)}.
            </p>
          ) : (
            <p className="hx-muted">{latest ? 'No gauge has reported in the last hour.' : 'No readings with a value in this range.'}</p>
          )}
          <p className="hx-muted hx-small">
            {totalReadings.toLocaleString()} {totalReadings === 1 ? 'reading' : 'readings'} from {ok.length} of {series.length} {series.length === 1 ? 'gauge' : 'gauges'}.
          </p>
        </div>
      </div>

      <SubLabel>Gauges</SubLabel>
      <ul className="hx-cards">
        {series.map((s, i) => (
          <li key={s.id} className="hx-card">
            <div className="hx-card-name">
              {series.length > 1 && <span className="hx-key" style={{ background: s.color }} aria-hidden="true" />}
              <span>{s.name}</span>
              <span className="hx-muted">{s.id}</span>
            </div>
            {s.error ? (
              <p className="hx-error">{s.error}</p>
            ) : (
              <Summary summary={summaries[i]} residual={residuals[i]} resolution={resolution} trigger={trigger} datum={data.datum} latest={latest} />
            )}
          </li>
        ))}
      </ul>

      {ok.length > 0 && (
        <>
          <SubLabel>Historical · {valueLabel.toLowerCase()}, {unitsLabel}</SubLabel>
          {/* Legend: gauge colors, then the line styles (the same for every gauge) */}
          {(ok.length > 1 || predictions || mixedQuality || trigger !== null) && (
            <ul className="hx-legend" aria-label="Legend">
              {ok.length > 1 &&
                ok.map((s) => (
                  <li key={s.id}>
                    <span className="hx-key" style={{ background: s.color }} aria-hidden="true" />
                    {s.name}
                  </li>
                ))}
              <li className={ok.length > 1 ? 'hx-legend-styles' : undefined}>
                <span className="hx-key-style" aria-hidden="true" />
                {resolution === 'daily' ? 'Observed daily max' : 'Observed'}
              </li>
              {mixedQuality && (
                <li>
                  <span className="hx-key-style is-prelim" aria-hidden="true" />
                  Preliminary
                </li>
              )}
              {predictions && (
                <li>
                  <span className="hx-key-style is-pred" aria-hidden="true" />
                  {resolution === 'daily' ? 'Predicted daily high tide' : 'Predicted tide'}
                </li>
              )}
              {trigger !== null && (
                <li>
                  <span className="hx-key-style is-hit" aria-hidden="true" />
                  At or above reference trigger
                </li>
              )}
            </ul>
          )}
          {predState?.status === 'loading' && <p className="hx-pred-note">Loading tide predictions…</p>}
          {predState?.status === 'error' && <p className="hx-pred-note">Tide predictions unavailable: {predState.message}</p>}
          {showPredictions && !result.predictions && <p className="hx-pred-note">Press Get readings to add tide predictions.</p>}
          {predErrors.map(({ s, p }) => (
            <p key={s.id} className="hx-pred-note">No tide predictions for {s.name}: {p.error}</p>
          ))}
          <ReadingsChart
            series={ok}
            predictions={predictions}
            domain={domain}
            trigger={trigger}
            stepMs={config.stepMs}
            valueLabel={valueLabel}
            unitsLabel={unitsLabel}
            datum={data.datum}
            residualLabel={
              resolution === 'daily'
                ? 'Skew surge: daily max minus predicted high tide, ft'
                : 'Surge: observed minus predicted tide, ft'
            }
            showReadingTime={resolution === 'daily'}
          />
        </>
      )}

      {triggerMismatch && ok.length > 0 && (
        <p className="hx-pred-note">
          The reference trigger ({stated.level.toFixed(2)} ft) is stated on {stated.datum}, but these readings are on{' '}
          {data.datum ?? 'different datums'}, so it isn't drawn or checked. Re-enter it on this datum to compare.
        </p>
      )}
      {/* Headline sentence with the key number in bold, like "Events above your level: 10 in 10 years." */}
      {trigger !== null && ok.length > 0 && (
        <p className="hx-headline">
          {latest ? 'At or above the reference trigger in the last hour' : 'At or above the reference trigger'} ({triggerText}):{' '}
          {ok
            .map((s) => ({ s, sm: summaries[series.indexOf(s)] }))
            .map(({ s, sm }, i, all) => (
              <span key={s.id}>
                {s.name}{' '}
                {sm.above ? (
                  <strong className="hl-text">{sm.aboveLabel}</strong>
                ) : sm.gaps ? (
                  `not in the data available (${sm.gaps.missing} missing)`
                ) : (
                  'not reached'
                )}
                {i < all.length - 1 ? ', ' : '.'}
              </span>
            ))}
        </p>
      )}
      {trigger !== null && ok.length > 0 && (
        <p className="hx-muted hx-small">
          A reference level for exploring the data. Whether a bond triggers is decided under its terms by its calculation agent, not by this page.
        </p>
      )}
      <p className="sec-source">
        Source: NOAA CO-OPS Data API · {config.label.toLowerCase()} data, {unitsLabel}, UTC · retrieved {formatDateTime(data.retrievedAt)}
        {predictions && ` · predictions: NOAA astronomical tide${resolution === 'daily' ? ' (daily highest high)' : ''}`}
      </p>

      {/* Centered secondary action, like "+ Add layer" */}
      <div className="sec-foot">
        <ActionButton type="button" tone="ghost" size="px-6 py-2.5 text-sm" disabled={!totalReadings} onClick={() => downloadCsv(result, predictions)}>
          + Download CSV
        </ActionButton>
      </div>
    </div>
  );
}

// A gap bound: a date for daily data, a date and time otherwise
const formatGapBound = (t, resolution) => (resolution === 'daily' ? formatDate(t) : formatDateTime(t));

/** One gauge's card contents (the gauge name is rendered by Results). */
function Summary({ summary, residual, resolution, trigger, datum, latest = false }) {
  const { peak, latest: last, count, missing, verifiedShare, startsLate, endsEarly, above, aboveLabel, firstAbove, gaps } = summary;
  // "Latest" leads with the gauge's current level; other ranges lead with the peak
  const lead = latest ? last : peak;
  const quality =
    verifiedShare === 1 ? 'All verified' : verifiedShare === 0 ? 'All preliminary' : `${Math.round(verifiedShare * 100)}% verified, rest preliminary`;
  return (
    <>
      <p className="hx-card-value hl-text">
        {lead ? `${lead.v.toFixed(2)} ft` : latest ? 'No reading in the last hour' : 'No values'}
        {lead && <span className="hx-muted"> {latest ? 'latest' : resolution === 'daily' ? 'highest daily max' : 'peak'}</span>}
      </p>
      {lead && <p className="hx-muted">{formatDateTime(lead.t)}</p>}
      <dl className="hx-facts">
        {latest && peak && (
          <div>
            <dt>Peak</dt>
            <dd>{peak.v.toFixed(2)} ft at {peak.t.slice(11, 16)} UTC</dd>
          </div>
        )}
        {residual && (
          <div>
            <dt>{resolution === 'daily' ? 'Max above predicted high' : 'Max above tide'}</dt>
            <dd>
              <span className="hx-surge">{formatResidual(residual.v)}</span>
              <span className="hx-muted hx-block">
                {formatDateTime(residual.t)}: {residual.observed.toFixed(2)} observed vs {residual.predicted.toFixed(2)} predicted
              </span>
            </dd>
          </div>
        )}
        <div>
          <dt>Readings</dt>
          <dd>
            {count.toLocaleString()}
            {missing > 0 && ` (${missing.toLocaleString()} without a value)`}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{quality}</dd>
        </div>
        {(startsLate || endsEarly || gaps) && (
          <div>
            <dt>Coverage</dt>
            <dd>
              {startsLate && `Starts ${formatDate(startsLate)}. `}
              {endsEarly && `Ends ${formatDate(endsEarly)}${resolution === 'hourly' || resolution === 'daily' ? ' (verified data lags real time)' : ''}. `}
              {gaps && (
                <span className={startsLate || endsEarly ? 'hx-block' : undefined}>
                  {gaps.missing} missing in {gaps.count.toLocaleString()} {gaps.count === 1 ? 'gap' : 'gaps'}
                  {gaps.count > 1 && `; longest ${gaps.longest.span}`}, from {formatGapBound(gaps.longest.start, resolution)} to{' '}
                  {formatGapBound(gaps.longest.end, resolution)}.
                </span>
              )}
            </dd>
          </div>
        )}
        {trigger !== null && (
          <div>
            <dt>At or above {trigger.toFixed(2)} ft {datum}</dt>
            <dd className={above ? 'hx-hit' : undefined}>
              {above ? (
                <>
                  <span aria-hidden="true">▲ </span>
                  {aboveLabel}, first {formatDateTime(firstAbove.t)}
                </>
              ) : gaps ? (
                // Data is missing, so the level may have been reached while the gauge was silent
                `Not reached in the data available (${gaps.missing} missing)`
              ) : (
                'Not reached'
              )}
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

/**
 * Table view: every reading from every gauge, merged in time order, 500 rows per
 * page. Rows at or above the trigger are highlighted. Daily data adds a min column.
 */
function ReadingsTable({ series, resolution, trigger, predictions, page, setPage }) {
  const rows = useMemo(() => {
    const all = [];
    for (const s of series) for (const r of s.readings) all.push({ s, r });
    all.sort((a, b) => (a.r.t < b.r.t ? -1 : a.r.t > b.r.t ? 1 : 0));
    return all;
  }, [series]);
  const pages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE));
  const current = Math.min(page, pages - 1); // stay in range if a new result has fewer pages
  const slice = rows.slice(current * TABLE_PAGE, (current + 1) * TABLE_PAGE);
  const daily = resolution === 'daily';

  return (
    <div className="hx-table-wrap">
      <table className="hx-table">
        <thead>
          <tr>
            <th scope="col">Time (UTC)</th>
            <th scope="col">Gauge</th>
            <th scope="col" className="num">{daily ? 'Daily max (ft)' : 'Level (ft)'}</th>
            {daily && <th scope="col" className="num">Daily min (ft)</th>}
            {predictions && <th scope="col" className="num">{daily ? 'Predicted high (ft)' : 'Predicted (ft)'}</th>}
            {predictions && <th scope="col" className="num"><abbr title="Observed minus predicted tide: the surge">Obs − pred (ft)</abbr></th>}
            <th scope="col">Status</th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {slice.map(({ s, r }) => {
            const pred = predictions?.get(s.id);
            const p = pred && !pred.error ? pred.valueFor(r) : null;
            return (
            <tr key={`${s.id}-${r.t}`} className={trigger !== null && r.v !== null && r.v >= trigger ? 'hx-row-hit' : undefined}>
              <td>{formatDateTime(r.t).replace(' UTC', '')}</td>
              <td>{s.name}</td>
              <td className="num">{r.v === null ? '–' : r.v.toFixed(3)}</td>
              {daily && <td className="num">{r.vMin == null ? '–' : r.vMin.toFixed(3)}</td>}
              {predictions && <td className="num">{p === null ? '–' : p.toFixed(3)}</td>}
              {predictions && <td className="num">{p === null || r.v === null ? '–' : `${r.v - p >= 0 ? '+' : '−'}${Math.abs(r.v - p).toFixed(3)}`}</td>}
              <td>{r.q === 'v' ? 'Verified' : r.q === 'p' ? 'Preliminary' : '–'}</td>
              <td className="hx-muted">{r.f ?? ''}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
      <div className="hx-pager">
        <span className="hx-muted">
          Rows {(current * TABLE_PAGE + 1).toLocaleString()}–{Math.min(rows.length, (current + 1) * TABLE_PAGE).toLocaleString()} of{' '}
          {rows.length.toLocaleString()}
        </span>
        <ActionButton type="button" tone="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
          Previous
        </ActionButton>
        <ActionButton type="button" tone="ghost" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
          Next
        </ActionButton>
      </div>
    </div>
  );
}
