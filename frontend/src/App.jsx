/**
 * App shell: the landing page, the shared site header, and a tiny hash router.
 *
 * Routes
 *   #/historical?...  -> ReadingsPage (search and chart NOAA readings via our API)
 *   anything else     -> Home (marketing page with a live NOAA gauge panel)
 *
 * Hash routing keeps this a static site (no server rewrites, no router library),
 * and lets the landing page keep its plain "#how" style section links.
 */
import { useEffect, useMemo, useState } from "react";
import "./global.css";
import ReadingsPage from "./historical/ReadingsPage.jsx";
import { ActionButton, Surface, Tag } from "./theme/Primitives.jsx";
import ThemeSwitcher from "./theme/ThemeSwitcher.jsx";
import Section from "./components/Section.jsx";
import { API_BASE } from "./api.js";

// Gauges shown as tabs in the landing page's live panel, in tab order.
const STATIONS = [
  { id: "8518750", name: "The Battery" },
  { id: "8516945", name: "Kings Point" },
  { id: "8531680", name: "Sandy Hook" },
];

const CONTACT_HREF = "mailto:hello@example.com"; // TODO: real contact link

// Rows in the landing page's "Endpoints" section. Entries with `href` exist and link
// to a live example (the readings page, or the raw JSON for /latest); the rest are
// planned (docs/plan.md).
const ENDPOINTS = [
  { route: "/locations/nyc/historical", does: "Readings for a location over any date range, paged for you", href: "#/historical" },
  { route: "/stations/8518750/historical", does: "The same for any single NOAA gauge, by station ID", href: "#/historical?target=station:8518750&start=2012-10-22&end=2012-11-05&resolution=auto" },
  { route: "/locations/nyc/latest", does: "The most recent reading from each gauge", href: `${API_BASE}/locations/nyc/latest` },
  { route: "/locations/nyc/risk", does: "How often an area reaches risky water levels" },
  { route: "/locations/nyc/forecast", does: "Forecasted readings for the location" },
];

// The three "How it works" steps on the landing page.
const HOW = [
  { title: "Pick a place", body: "Ask for a city and we resolve it to its tide gauges. Station IDs stay available if you want them." },
  { title: "Set a trigger", body: "Choose a water level and a gauge or set of gauges. Check it against years of history first." },
  { title: "Settle on the record", body: "When a gauge crosses the line, the reading, gauge and time are on file." },
];

/**
 * Fetch the last 24 hours of 6-minute readings for one gauge, straight from NOAA.
 * (The landing panel predates the backend, so it calls NOAA directly; the
 * historical page goes through our API instead.)
 *
 * Refetches when `stationId` changes and aborts the previous request, so a quick
 * tab switch can't let an older response overwrite a newer one.
 *
 * @returns {{ status: "loading"|"ok"|"error", rows: Array<{t, v, q}>, message?: string }}
 */
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
        // NOAA reports problems as a 200 with an `error` object, not an HTTP error
        if (!j.data?.length) throw new Error(j.error?.message || "No data");
        const rows = j.data
          .filter((d) => d.v !== "") // skip readings NOAA has no value for
          .map((d) => ({ t: d.t, v: parseFloat(d.v), q: d.q }));
        setState({ status: "ok", rows });
      })
      // An abort just means the user switched gauges; it is not an error to show
      .catch((e) => e.name !== "AbortError" && setState({ status: "error", rows: [], message: e.message }));
    return () => ctl.abort();
  }, [stationId]);
  return state;
}

/**
 * Landing-page demo: the latest reading for a NYC gauge, a 24-hour sparkline,
 * and a draggable example trigger level showing how far the water is from it.
 */
function GaugePanel() {
  const [stationId, setStationId] = useState(STATIONS[0].id);
  const [trigger, setTrigger] = useState(7);
  const { status, rows, message } = useGauge(stationId);

  // Chart geometry in a fixed 600x170 viewBox (the SVG scales to its container).
  // The y range always includes the trigger so its line stays on screen, plus
  // half a foot of padding above and below.
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

  // How far the latest reading is below the trigger: "hit" at or above it,
  // "near" within a foot. These classes color the trigger line and status text.
  const latest = rows[rows.length - 1];
  const gap = latest ? trigger - latest.v : 0;
  const tone = !latest ? "" : gap <= 0 ? "hit" : gap < 1 ? "near" : "";

  return (
    <Surface className="hp-panel" aria-live="polite">
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

      {status === "loading" && <p className="app-muted">Loading the last 24 hours from NOAA...</p>}
      {status === "error" && (
        <p className="app-muted">
          NOAA didn't return data for this gauge ({message}). Check your connection and pick the gauge again.
        </p>
      )}

      {latest && view && (
        <>
          <div className="hp-reading">
            <span className="app-num hp-big">{latest.v.toFixed(2)}</span>
            <span className="app-eyebrow">ft above MLLW</span>
            {/* Verified readings get the brand accent; preliminary stays neutral */}
            <Tag
              className={`hp-badge ${
                latest.q === "v"
                  ? "border-[var(--rhodex-accent)] text-[var(--rhodex-accent)]"
                  : "border-[var(--rhodex-text-dark-muted)] text-[var(--rhodex-text-dark-muted)]"
              }`}
            >
              {latest.q === "v" ? "Verified" : "Preliminary"}
            </Tag>
          </div>
          <p className="app-muted app-num" style={{ fontSize: "0.8rem" }}>{latest.t} UTC · station {stationId}</p>

          <svg viewBox={`0 0 ${view.W} ${view.H}`} className="hp-chart" role="img"
               aria-label={`Water level over the last 24 hours, peak ${view.peak.toFixed(1)} feet`}>
            <line x1="0" x2={view.W} y1={view.ty} y2={view.ty} className={`hp-trigger ${tone}`} />
            <path d={view.path} className="hp-line" />
          </svg>

          <label className="hp-slider">
            <span className="app-eyebrow">Trigger level</span>
            <input
              type="range" min="0" max="15" step="0.1" value={trigger}
              onChange={(e) => setTrigger(parseFloat(e.target.value))}
            />
            <span className="app-num">{trigger.toFixed(1)} ft</span>
          </label>
          <p className={`hp-status ${tone}`}>
            {gap <= 0
              ? `Trigger exceeded by ${Math.abs(gap).toFixed(2)} ft.`
              : `${gap.toFixed(2)} ft below the trigger.`}{" "}
            <span className="app-muted">Example trigger level.</span>
          </p>
        </>
      )}
    </Surface>
  );
}

// Hash routes: "#/historical..." is the historical page; anything else is the
// landing page, where "#how" style hashes stay in-page section links.
function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.startsWith("#/historical") ? "historical" : "home";
}

/**
 * Top navigation shared by both pages, with the company theme switcher
 * (Lapis / Ghost; the choice is remembered in localStorage by ThemeProvider).
 * Section links ("#how") work from the historical page too: they switch the
 * route to Home, which then scrolls to them.
 */
function SiteHeader({ route }) {
  return (
    <header className="app-nav">
      <a className="app-brand" href="#/">Rhodex <span>Water-level API</span></a>
      <div className="app-nav-right">
        <nav>
          <a href="#live">Live gauge</a>
          <a href="#/historical" aria-current={route === "historical" ? "page" : undefined}>Readings</a>
          <a href="#how">How it works</a>
          <a href="#endpoints">Endpoints</a>
          <a href="#record">Data</a>
        </nav>
        <ThemeSwitcher />
      </div>
    </header>
  );
}

export default function App() {
  const route = useRoute();
  // Start each page at the top, like a normal page load
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  // app-root paints the theme background; app-wrap sets the page width
  return (
    <div className="app-root">
      <div className="app-wrap">
        <SiteHeader route={route} />
        {route === "historical" ? <ReadingsPage /> : <Home />}
      </div>
    </div>
  );
}

/** The landing page. */
function Home() {
  // Arriving from another page with "#how" etc: scroll to that section once rendered
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id && !id.startsWith("/")) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <>
      <main>
        {/* Hero: pitch on the left, live gauge on the right */}
        <section className="hp-hero" id="live">
          <div className="hp-copy">
            <p className="app-eyebrow">NOAA tide gauges · parametric triggers</p>
            <h1>Write a deal against any coastline we can measure.</h1>
            <p>
              One API on top of NOAA tide gauges. Ask for a city and get its gauges, their history,
              and the risk behind a trigger. When a gauge crosses the line, the payout follows the data.
            </p>
            <div className="hp-actions">
              <ActionButton as="a" href={CONTACT_HREF} tone="primary" size="px-5 py-3 text-xs">Request access</ActionButton>
              <ActionButton as="a" href="#/historical" tone="ghost" size="px-5 py-3 text-xs">Explore historical readings</ActionButton>
            </div>
          </div>
          <GaugePanel />
        </section>

        {/* Numbered section cards, as on the "Build a bond" page (not collapsible here) */}
        <Section number={1} title="How it works" className="hp-section" id="how">
          <h3>From a city to a settled trigger</h3>
          <p className="hp-lead">Parametric deals pay on a measurement, not an assessed loss. We make the measurement easy to find and easy to audit.</p>
          <ol className="hp-steps">
            {HOW.map((c, i) => (
              <li key={c.title}>
                <span className="app-num">{String(i + 1).padStart(2, "0")}</span>
                <div><strong>{c.title}</strong><p>{c.body}</p></div>
              </li>
            ))}
          </ol>
        </Section>

        <Section number={2} title="Endpoints" className="hp-section" id="endpoints">
          <h3>One interface for every location</h3>
          <p className="hp-lead">A location resolves to its gauges, so New York City returns the New York gauges.</p>
          <ul className="hp-rows">
            {ENDPOINTS.map((e) => (
              <li key={e.route}>
                <code className="hp-code app-num">{e.href ? <a href={e.href}>GET {e.route}</a> : `GET ${e.route}`}</code>
                <span>{e.does}</span>
              </li>
            ))}
          </ul>
        </Section>

        {/* Illustrative example of a settlement record, not live data */}
        <Section number={3} title="Data" className="hp-section" bodyClassName="hp-split" id="record">
          <div>
            <h3>Every settlement has a receipt</h3>
            <p className="hp-lead">
              If a deal triggers, you can see the exact reading, the gauge, the time, and whether
              NOAA had marked it preliminary or verified when it was used.
            </p>
          </div>
          <dl className="hp-record app-num">
            <div><dt>gauge</dt><dd>8518750</dd></div>
            <div><dt>time</dt><dd>2026-11-03 12:00 UTC</dd></div>
            <div><dt>reading</dt><dd>7.42 ft MLLW</dd></div>
            <div><dt>status</dt><dd>preliminary</dd></div>
          </dl>
        </Section>

        <Surface as="section" className="hp-section hp-cta">
          <h2>Build on the water-level API</h2>
          <p className="hp-lead">Tell us the coastline and the sponsor. We'll tell you which gauges can carry the deal.</p>
          <ActionButton as="a" href={CONTACT_HREF} tone="primary" size="px-5 py-3 text-xs">Request access</ActionButton>
        </Surface>
      </main>

      <footer className="hp-foot app-muted">
        Data from NOAA CO-OPS. Preliminary readings are subject to change until verified.
      </footer>
    </>
  );
}
