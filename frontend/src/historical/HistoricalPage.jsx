/**
 * Historical readings page (#/historical).
 *
 * Flow: the form (location/gauge, dates, resolution, optional trigger) is mirrored
 * into the URL -> "Get readings" calls the backend -> the response becomes one
 * "series" per gauge -> summary cards, a chart or table, and a CSV export.
 *
 * Components in this file
 * Layout follows the company's "Build a bond" page: a back link + title header,
 * then numbered section cards (01 Request, 02 Readings, 03 Readings table).
 *
 * Components in this file
 *   HistoricalPage  header, sections, form, request lifecycle (loading / cancel / errors), URL state
 *   Results         section 02's content for one response
 *   Summary         the per-gauge card: peak, status mix, coverage, trigger hits
 *   ReadingsTable   section 03, paged in the browser
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchDirectory, fetchHistorical } from '../api.js';
import { ActionButton } from '../theme/Primitives.jsx';
import Section, { SubLabel } from '../components/Section.jsx';
import ReadingsChart from './ReadingsChart.jsx';
import TargetPicker from './TargetPicker.jsx';
import {
  DAY_MS,
  EARLIEST,
  RESOLUTIONS,
  addDays,
  formatDate,
  formatDateTime,
  formatDuration,
  rangeProblem,
  resolveResolution,
  todayUtc,
} from './time.js';
import './historical.css';

const SERIES_SLOTS = 8; // number of --series-N colors defined in historical.css
const TABLE_PAGE = 500; // table rows per page; a year of data can be ~260k rows

// Quick date ranges. `range` receives today's UTC date and returns [start, end].
const PRESETS = [
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
  { id: '6min', label: '6-minute (up to 1 year)' },
  { id: 'hourly', label: 'Hourly, verified (up to 10 years)' },
  { id: 'daily', label: 'Daily max, verified (any range)' },
];

// What a fresh visit shows: NYC during Hurricane Sandy, the project's proof point
const DEFAULT_FORM = { target: 'location:nyc', start: '2012-10-22', end: '2012-11-05', resolution: 'auto', trigger: '' };

// ---- URL state: #/historical?target=location:nyc&start=...&end=...&resolution=auto&trigger=10
// Keeping the form in the URL means any view can be bookmarked or shared as a link.

/** The form encoded in the current URL, or null if the URL doesn't hold a complete one. */
function readFormFromHash() {
  const query = window.location.hash.split('?')[1];
  if (!query) return null;
  const p = new URLSearchParams(query);
  if (!p.get('target') || !p.get('start') || !p.get('end')) return null;
  return {
    target: p.get('target'),
    start: p.get('start'),
    end: p.get('end'),
    resolution: RESOLUTION_OPTIONS.some((o) => o.id === p.get('resolution')) ? p.get('resolution') : 'auto',
    trigger: p.get('trigger') ?? '',
  };
}

/**
 * Record a submitted form in the URL. replaceState (rather than setting
 * location.hash) avoids a "hashchange" event and doesn't add a history entry
 * for every search.
 */
function writeFormToHash(form) {
  const p = new URLSearchParams({ target: form.target, start: form.start, end: form.end, resolution: form.resolution });
  if (form.trigger !== '') p.set('trigger', form.trigger);
  window.history.replaceState(null, '', `#/historical?${p}`);
}

// "location:nyc" -> { type: 'location', id: 'nyc' }; "station:8518750" -> { type: 'station', ... }
const parseTarget = (key) => {
  const [type, ...rest] = key.split(':');
  return { type, id: rest.join(':') };
};

// Which preset chip a date range corresponds to, so a shared link highlights the right one
const presetFor = (start, end) =>
  PRESETS.find((p) => {
    const [s, e] = p.range(todayUtc());
    return s === start && e === end;
  })?.id ?? 'custom';

/**
 * The oldest `established` date among the target's gauges (YYYY-MM-DD), or null if
 * unknown. Used to give the From field a sensible date when leaving "All history".
 */
function establishedFor(targetKey, directory) {
  const { type, id } = parseTarget(targetKey);
  const gauges =
    type === 'location'
      ? directory.locations.find((l) => l.id === id)?.stations ?? []
      : directory.stations.filter((s) => s.id === id);
  const dates = gauges.map((s) => s.established).filter(Boolean).sort();
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
  for (const r of series.readings) {
    if (r.q === 'v') verified++;
    if (r.v === null) continue;
    withValue++;
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
    count: n,
    missing: n - withValue,
    verifiedShare: n ? verified / n : 0,
    startsLate: first && first > start ? first : null,
    endsEarly: last && last < end ? last : null,
    above,
    aboveLabel: resolution === 'daily' ? `${above.toLocaleString()} ${above === 1 ? 'day' : 'days'}` : formatDuration(above * stepMs),
    firstAbove,
  };
}

/**
 * Every reading as CSV, one row per reading per gauge. Each row repeats the
 * resolution, datum, units and retrieval time so a row copied out on its own is
 * still a complete record for settlement.
 */
function toCsv(result) {
  const { data, series } = result;
  const cols = ['station', 'name', 'time_utc', 'value_ft', 'quality', 'flags', 'sigma', 'daily_min_time_utc', 'daily_min_ft', 'pct_complete', 'source', 'resolution', 'datum', 'units', 'retrieved_at'];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const s of series) {
    for (const r of s.readings) {
      lines.push(
        [s.id, s.name, r.t, r.v, r.q, r.f, r.s, r.tMin, r.vMin, r.complete, r.source, data.resolution, data.datum, data.units, data.retrievedAt]
          .map(esc)
          .join(','),
      );
    }
  }
  return lines.join('\n');
}

/** Trigger a browser download of the CSV via a temporary object URL. */
function downloadCsv(result) {
  const blob = new Blob([toCsv(result)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const target = parseTarget(result.form.target);
  a.href = url;
  a.download = `water-levels_${target.id}_${result.data.start}_${result.data.end}_${result.data.resolution}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Page

export default function HistoricalPage() {
  // The form to start from: a shared link's settings, or the default. Read once.
  const initial = useRef(readFormFromHash() ?? DEFAULT_FORM).current;
  const [form, setForm] = useState(initial); // what the inputs show (not yet submitted)
  const [preset, setPreset] = useState(() => presetFor(initial.start, initial.end)); // highlighted chip, or 'custom'
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
    const problem = rangeProblem(f.start, f.end, f.resolution);
    if (problem) {
      setRequest({ status: 'error', message: problem });
      return;
    }
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    writeFormToHash(f);
    setRequest({ status: 'loading', resolution: resolveResolution(f.start, f.end, f.resolution) });
    fetchHistorical(parseTarget(f.target), f, { signal: ctl.signal })
      .then((data) => {
        setResult({ form: f, data, series: toSeries(data) });
        setRequest({ status: 'idle' });
        setTablePage(0);
      })
      .catch((e) => {
        if (e.name === 'AbortError') return;
        setRequest({ status: 'error', message: e.message });
      });
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
    if (p) {
      const [start, end] = p.range(todayUtc());
      update({ start, end });
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
  const trigger = parseTrigger(form.trigger);

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
        <h1 className="page-title">Historical readings</h1>
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
                onChange={(target) => update({ target })}
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
                        update({ start: establishedFor(form.target, directory) ?? '1900-01-01' });
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
                        update({ start: e.target.value });
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
                      update({ end: e.target.value });
                    }}
                  />
                </label>
              </div>
            </fieldset>
          </div>

          <div className="sec-col">
            <SubLabel as="label" htmlFor="hx-resolution">Resolution</SubLabel>
            <select id="hx-resolution" className="hx-input" value={form.resolution} onChange={(e) => update({ resolution: e.target.value })}>
              {RESOLUTION_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === 'auto' && !formProblem ? `Auto (${RESOLUTIONS[resolved].label.toLowerCase()})` : o.label}
                </option>
              ))}
            </select>

            <SubLabel as="label" htmlFor="hx-trigger">Trigger level (optional)</SubLabel>
            <div className="hx-suffix">
              <input
                id="hx-trigger"
                className="hx-input hl"
                type="number"
                inputMode="decimal"
                step="0.1"
                placeholder="e.g. 10"
                value={form.trigger}
                onChange={(e) => update({ trigger: e.target.value })}
              />
              <span>ft</span>
            </div>

            {/* Live hints about the form, shown before submitting */}
            {formProblem && !loading && request.status !== 'error' && <p className="hx-hint">{formProblem}</p>}
            {resolved !== '6min' && !formProblem && (
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
          <Results result={result} trigger={trigger} directory={directory} onEdit={editRequest} />
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
            trigger={trigger}
            page={tablePage}
            setPage={setTablePage}
          />
        </Section>
      )}
    </main>
  );
}

/**
 * Section 02's content for one response. `trigger` comes from the live form
 * (not the submitted one), so changing it updates the cards and chart instantly
 * without refetching.
 */
function Results({ result, trigger, directory, onEdit }) {
  const { form, data, series } = result;
  const resolution = data.resolution;
  const config = RESOLUTIONS[resolution];
  const ok = series.filter((s) => !s.error); // gauges with readings; failed ones only get a card
  // The range as the API reports it. Same as requested for fixed dates; for "All
  // history" `start` is the oldest reading found across the gauges.
  const { start, end } = data;
  // The chart's x range is that range (end date inclusive, so + 1 day), not each
  // gauge's own data, so a gauge with a shorter record shows empty space before it
  const domain = useMemo(
    () => [Date.parse(`${start}T00:00:00Z`), Date.parse(`${end}T00:00:00Z`) + DAY_MS],
    [start, end],
  );
  const summaries = useMemo(
    () => series.map((s) => (s.error ? null : summarize(s, { resolution, start, end, trigger }))),
    [series, resolution, start, end, trigger],
  );
  const totalReadings = ok.reduce((n, s) => n + s.readings.length, 0);
  const valueLabel = resolution === 'daily' ? 'Daily maximum water level' : `${config.label} water level`;

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
              {targetName} · {formatDate(start)} to {formatDate(end)}
              {form.start === EARLIEST && ' (full record)'} · {config.label.toLowerCase()}
              {trigger !== null && ` · trigger ${trigger.toFixed(2)} ft`}
            </p>
            <button type="button" className="sec-link" onClick={onEdit}>Edit</button>
          </div>
        </div>
        <div className="sec-col">
          <SubLabel>Highest reading</SubLabel>
          {top ? (
            <p className="hx-headline">
              <strong className="hl-text">{top.peak.v.toFixed(2)} ft</strong> at {top.name}, {formatDateTime(top.peak.t)}.
            </p>
          ) : (
            <p className="hx-muted">No readings with a value in this range.</p>
          )}
          <p className="hx-muted hx-small">
            {totalReadings.toLocaleString()} readings from {ok.length} of {series.length} {series.length === 1 ? 'gauge' : 'gauges'}.
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
              <Summary summary={summaries[i]} resolution={resolution} trigger={trigger} />
            )}
          </li>
        ))}
      </ul>

      {ok.length > 0 && (
        <>
          <SubLabel>Historical · {valueLabel.toLowerCase()}, ft above MLLW</SubLabel>
          {ok.length > 1 && (
            <ul className="hx-legend" aria-label="Legend">
              {ok.map((s) => (
                <li key={s.id}>
                  <span className="hx-key" style={{ background: s.color }} aria-hidden="true" />
                  {s.name}
                </li>
              ))}
            </ul>
          )}
          <ReadingsChart series={ok} domain={domain} trigger={trigger} stepMs={config.stepMs} valueLabel={valueLabel} showReadingTime={resolution === 'daily'} />
        </>
      )}

      {/* Headline sentence with the key number in bold, like "Events above your level: 10 in 10 years." */}
      {trigger !== null && ok.length > 0 && (
        <p className="hx-headline">
          At or above your level ({trigger.toFixed(2)} ft):{' '}
          {ok
            .map((s) => ({ s, sm: summaries[series.indexOf(s)] }))
            .map(({ s, sm }, i, all) => (
              <span key={s.id}>
                {s.name} {sm.above ? <strong className="hl-text">{sm.aboveLabel}</strong> : 'never'}
                {i < all.length - 1 ? ', ' : '.'}
              </span>
            ))}
        </p>
      )}
      <p className="sec-source">
        Source: NOAA CO-OPS Data API · {config.label.toLowerCase()} data, ft above MLLW, UTC · retrieved {formatDateTime(data.retrievedAt)}
      </p>

      {/* Centered secondary action, like "+ Add layer" */}
      <div className="sec-foot">
        <ActionButton type="button" tone="ghost" size="px-6 py-2.5 text-sm" disabled={!totalReadings} onClick={() => downloadCsv(result)}>
          + Download CSV
        </ActionButton>
      </div>
    </div>
  );
}

/** One gauge's card contents (the gauge name is rendered by Results). */
function Summary({ summary, resolution, trigger }) {
  const { peak, count, missing, verifiedShare, startsLate, endsEarly, above, aboveLabel, firstAbove } = summary;
  const quality =
    verifiedShare === 1 ? 'All verified' : verifiedShare === 0 ? 'All preliminary' : `${Math.round(verifiedShare * 100)}% verified, rest preliminary`;
  return (
    <>
      <p className="hx-card-value hl-text">
        {peak ? `${peak.v.toFixed(2)} ft` : 'No values'}
        <span className="hx-muted"> {resolution === 'daily' ? 'highest daily max' : 'peak'}</span>
      </p>
      {peak && <p className="hx-muted">{formatDateTime(peak.t)}</p>}
      <dl className="hx-facts">
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
        {(startsLate || endsEarly) && (
          <div>
            <dt>Coverage</dt>
            <dd>
              {startsLate && `Starts ${formatDate(startsLate)}. `}
              {endsEarly && `Ends ${formatDate(endsEarly)}${resolution !== '6min' ? ' (verified data lags real time)' : ''}.`}
            </dd>
          </div>
        )}
        {trigger !== null && (
          <div>
            <dt>At or above {trigger.toFixed(2)} ft</dt>
            <dd className={above ? 'hx-hit' : undefined}>
              {above ? (
                <>
                  <span aria-hidden="true">▲ </span>
                  {aboveLabel}, first {formatDateTime(firstAbove.t)}
                </>
              ) : (
                'Never reached'
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
function ReadingsTable({ series, resolution, trigger, page, setPage }) {
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
            <th scope="col">Status</th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {slice.map(({ s, r }) => (
            <tr key={`${s.id}-${r.t}`} className={trigger !== null && r.v !== null && r.v >= trigger ? 'hx-row-hit' : undefined}>
              <td>{formatDateTime(r.t).replace(' UTC', '')}</td>
              <td>{s.name}</td>
              <td className="num">{r.v === null ? '–' : r.v.toFixed(3)}</td>
              {daily && <td className="num">{r.vMin == null ? '–' : r.vMin.toFixed(3)}</td>}
              <td>{r.q === 'v' ? 'Verified' : r.q === 'p' ? 'Preliminary' : '–'}</td>
              <td className="hx-muted">{r.f ?? ''}</td>
            </tr>
          ))}
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
