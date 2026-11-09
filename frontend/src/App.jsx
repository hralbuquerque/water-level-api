import { useEffect, useMemo, useState } from "react";
import "./global.css";

const STATIONS = [
  { id: "8518750", name: "The Battery" },
  { id: "8516945", name: "Kings Point" },
  { id: "8531680", name: "Sandy Hook" },
];

const CONTACT_HREF = "mailto:hello@example.com"; // TODO: your real contact link

const ENDPOINTS = [
  { route: "/locations/nyc/historical", does: "Readings for a location over any date range, paged for you" },
  { route: "/locations/nyc/latest", does: "The most recent reading, with NOAA forecasts alongside" },
  { route: "/locations/nyc/risk", does: "How often an area reaches risky water levels" },
  { route: "/locations/nyc/forecast", does: "Forecasted readings for the location" },
];

const HOW = [
  { title: "Pick a place", body: "Ask for a city and we resolve it to its tide gauges. Station IDs stay available if you want them." },
  { title: "Set a trigger", body: "Choose a water level and a gauge or set of gauges. Check it against years of history first." },
  { title: "Settle on the record", body: "When a gauge crosses the line, the reading, gauge and time are on file." },
];

function useGauge(stationId) {
  const [state, setState] = useState({ status: "loading", rows: [] });
  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: "loading", rows: [] });
    const url =
      "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter" +
      `?product=water_level&range=24&station=${stationId}&datum=MLLW` +
      "&units=english&time_zone=gmt&format=json&application=rhodex";
    fetch(url, { signal: ctl.signal })
      .then((r) => r.json())
      .then((j) => {
        if (!j.data?.length) throw new Error(j.error?.message || "No data");
        const rows = j.data
          .filter((d) => d.v !== "")
          .map((d) => ({ t: d.t, v: parseFloat(d.v), q: d.q }));
        setState({ status: "ok", rows });
      })
      .catch((e) => e.name !== "AbortError" && setState({ status: "error", rows: [], message: e.message }));
    return () => ctl.abort();
  }, [stationId]);
  return state;
}

function GaugePanel() {
  const [stationId, setStationId] = useState(STATIONS[0].id);
  const [trigger, setTrigger] = useState(7);
  const { status, rows, message } = useGauge(stationId);

  const view = useMemo(() => {
    if (!rows.length) return null;
    const W = 600, H = 170;
    const vals = rows.map((r) => r.v);
    const lo = Math.min(...vals, trigger) - 0.5;
    const hi = Math.max(...vals, trigger) + 0.5;
    const x = (i) => (i / (rows.length - 1)) * W;
    const y = (v) => H - ((v - lo) / (hi - lo)) * H;
    const path = rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.v).toFixed(1)}`).join(" ");
    return { W, H, path, ty: y(trigger), peak: Math.max(...vals) };
  }, [rows, trigger]);

  const latest = rows[rows.length - 1];
  const gap = latest ? trigger - latest.v : 0;
  const tone = !latest ? "" : gap <= 0 ? "hit" : gap < 1 ? "near" : "";

  return (
    <div className="hp-panel glass" aria-live="polite">
      <div className="hp-tabs" role="tablist" aria-label="Gauge">
        {STATIONS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={s.id === stationId}
            className="hp-tab"
            onClick={() => setStationId(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>

      {status === "loading" && <p className="hp-muted">Loading the last 24 hours from NOAA...</p>}
      {status === "error" && (
        <p className="hp-muted">
          NOAA didn't return data for this gauge ({message}). Check your connection and pick the gauge again.
        </p>
      )}

      {latest && view && (
        <>
          <div className="hp-reading">
            <span className="hp-num hp-big">{latest.v.toFixed(2)}</span>
            <span className="hp-unit label">ft above MLLW</span>
            <span className={`hp-badge label ${latest.q === "v" ? "is-verified" : ""}`}>
              {latest.q === "v" ? "Verified" : "Preliminary"}
            </span>
          </div>
          <p className="hp-muted">{latest.t} UTC · station {stationId}</p>

          <svg viewBox={`0 0 ${view.W} ${view.H}`} className="hp-chart" role="img"
               aria-label={`Water level over the last 24 hours, peak ${view.peak.toFixed(1)} feet`}>
            <line x1="0" x2={view.W} y1={view.ty} y2={view.ty} className={`hp-trigger ${tone}`} />
            <path d={view.path} className="hp-line" />
          </svg>

          <label className="hp-slider">
            <span>Trigger level</span>
            <input
              type="range" min="0" max="15" step="0.1" value={trigger}
              onChange={(e) => setTrigger(parseFloat(e.target.value))}
            />
            <span className="hp-num">{trigger.toFixed(1)} ft</span>
          </label>
          <p className={`hp-status ${tone}`}>
            {gap <= 0
              ? `Trigger exceeded by ${Math.abs(gap).toFixed(2)} ft.`
              : `${gap.toFixed(2)} ft below the trigger.`}{" "}
            <span className="hp-muted">Example trigger level.</span>
          </p>
        </>
      )}
    </div>
  );
}

export default function App() {
  return (
    <div className="rhodex-v2 hp-root">
      <header className="hp-nav">
        <span className="hp-brand">Rhodex <span className="hp-muted">Water-level API</span></span>
        <nav>
          <a href="#live">Live gauge</a>
          <a href="#how">How it works</a>
          <a href="#endpoints">Endpoints</a>
          <a href="#record">Data</a>
        </nav>
      </header>

      <main>
        <section className="hp-hero" id="live">
          <div className="hp-copy">
            <h1>Write a deal against any coastline we can measure.</h1>
            <p>
              One API on top of NOAA tide gauges. Ask for a city and get its gauges, their history,
              and the risk behind a trigger. When a gauge crosses the line, the payout follows the data.
            </p>
            <div className="hp-actions">
              <a className="hp-btn primary" href={CONTACT_HREF}>Request access</a>
              <a className="hp-btn glass" href="#endpoints">See the endpoints</a>
            </div>
          </div>
          <GaugePanel />
        </section>

        <section className="hp-section section-frame" id="how">
          <h2>From a city to a settled trigger</h2>
          <p className="hp-lead">Parametric deals pay on a measurement, not an assessed loss. We make the measurement easy to find and easy to audit.</p>
          <ol className="hp-steps">
            {HOW.map((c, i) => (
              <li key={c.title} className="plugs glass">
                <span className="hp-num">{i + 1}</span>
                <div><strong>{c.title}</strong><p>{c.body}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="hp-section section-frame" id="endpoints">
          <h2>One interface for every location</h2>
          <p className="hp-lead">A location resolves to its gauges, so New York City returns the New York gauges.</p>
          <ul className="hp-rows">
            {ENDPOINTS.map((e) => (
              <li key={e.route}>
                <code className="hp-code">GET {e.route}</code>
                <span>{e.does}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="hp-section section-frame hp-split" id="record">
          <div>
            <h2>Every settlement has a receipt</h2>
            <p className="hp-lead">
              If a deal triggers, you can see the exact reading, the gauge, the time, and whether
              NOAA had marked it preliminary or verified when it was used.
            </p>
          </div>
          <dl className="hp-record glass">
            <div><dt>gauge</dt><dd>8518750</dd></div>
            <div><dt>time</dt><dd>2026-11-03 12:00 UTC</dd></div>
            <div><dt>reading</dt><dd>7.42 ft MLLW</dd></div>
            <div><dt>status</dt><dd>preliminary</dd></div>
          </dl>
        </section>

        <section className="hp-section section-frame hp-cta">
          <h2>Build on the water-level API</h2>
          <p className="hp-lead">Tell us the coastline and the sponsor. We'll tell you which gauges can carry the deal.</p>
          <a className="hp-btn primary" href={CONTACT_HREF}>Request access</a>
        </section>
      </main>

      <footer className="hp-foot hp-muted">
        Data from NOAA CO-OPS. Preliminary readings are subject to change until verified.
      </footer>
    </div>
  );
}