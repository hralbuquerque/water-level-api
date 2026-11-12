# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`water-level-api` is a data layer over NOAA CO-OPS tide gauges, built to track and settle parametric (catastrophe) bond triggers. The reference deal is the MTA's MetroCat Re storm-surge bond, which pays out on NYC gauge readings. A location resolves to its gauges (`nyc` → The Battery, Sandy Hook, Kings Point), and station IDs stay available underneath.

Settlement needs an auditable record of the reading behind a trigger: which gauge, what time, what value, and whether NOAA had it as **preliminary (`q: "p"`) or verified (`q: "v"`)**. Preserve those fields in any change.

The project brief, roadmap and NOAA research findings are in `docs/plan.md`. Read it before adding features.

## Repository Layout

The repo has two independent packages, each with its own `package.json` and `node_modules`. There is no root `package.json`.

```
water-level-api/
├── backend/                  # Express 5 API (ESM, Node built-in fetch)
│   ├── src/
│   │   ├── server.js         # Entry point; listens on $PORT (default 3000)
│   │   ├── app.js            # buildApp(): helmet, cors, JSON body parsing, then setupRoutes
│   │   ├── routes/           # EVERY HTTP route lives here, one Express Router per feature
│   │   │   ├── index.js      # setupRoutes(app): mounts the routers below
│   │   │   ├── health.js     # /health
│   │   │   ├── directory.js  # /locations, /stations
│   │   │   ├── historical.js # /locations/:loc/historical, /stations/:id/historical
│   │   │   ├── latest.js     # /locations/:loc/latest, /stations/:id/latest
│   │   │   └── shared.js     # meta(): response fields shared by readings endpoints
│   │   ├── noaa.js           # fetchReadings, fetchLatest, parseReadings, validateDateRange
│   │   └── stations.js       # STATIONS directory + LOCATION_STATIONS (location → gauge IDs)
│   ├── data/stations.json    # All NOAA water-level stations (id, name, state, lat, lng)
│   ├── scripts/
│   │   ├── cli.js            # Command-line client; runs the app in-process
│   │   └── syncStations.js   # Refreshes data/stations.json (incl. `established` dates) from the NOAA Metadata API
│   ├── services/             # Empty placeholder
│   └── tests/                # Vitest + Supertest
├── frontend/                 # Vite + React 19
│   ├── index.html
│   ├── vite.config.js        # proxies /api -> backend
│   └── src/
│       ├── main.jsx, App.jsx # entry, hash routing, landing page
│       ├── api.js            # backend client
│       ├── theme/            # company theme, copied from another Rhodex project (see Theme below)
│       ├── global.css        # app shell + landing styles, built on the theme tokens
│       └── historical/       # Historical readings page: page, chart, picker, time helpers, CSS
└── docs/                     # CLAUDE.md, plan.md
```

## Commands

Backend (run from `backend/`):

```bash
npm install
npm run dev                          # node --watch src/server.js, http://localhost:3000
npm test                             # vitest run (all tests)
npx vitest run tests/health.test.js  # single file
node scripts/cli.js --start 2012-10-29 --end 2012-10-30 -o text        # nyc gauges
node scripts/cli.js -s 8518750 --start 2012-10-29 --end 2012-10-30     # one station, JSON
node scripts/syncStations.js         # refresh data/stations.json (must run from backend/)
```

Frontend (run from `frontend/`):

```bash
npm install
npm run dev      # Vite dev server; needs the backend running (it proxies /api -> localhost:3000)
npm run build    # production build to dist/
```

- `/api/*` is proxied to the backend, with the `/api` prefix stripped. If the backend runs on another port, start Vite with `API_TARGET=http://localhost:3001 npm run dev`. If the API is deployed elsewhere, build with `VITE_API_BASE=https://...`.
- If port 3000 is taken, the backend exits with an error. Start it with `PORT=3001 npm run dev` and point `API_TARGET` at that port.

No linter or formatter is configured.

## API

| Route | Description |
|---|---|
| `GET /health` | `{ status: "ok", timestamp }` |
| `GET /locations` | Named locations with their gauges, in display order |
| `GET /stations` | Every station in `data/stations.json` (id, name, state, lat, lng, established) |
| `GET /locations/:loc/historical?start=YYYY-MM-DD&end=YYYY-MM-DD[&resolution=]` | Readings for every gauge in a location. `:loc` is case-insensitive. |
| `GET /stations/:id/historical?start=YYYY-MM-DD&end=YYYY-MM-DD[&resolution=]` | Readings for a single NOAA station ID (any station in `data/stations.json`) |
| `GET /locations/:loc/latest` | Most recent 1-minute reading from every gauge in a location; a failing gauge gets `error` instead of `reading` |
| `GET /stations/:id/latest` | Most recent 1-minute reading from one gauge; 502 on a NOAA error |

- **Time ranges:** `start`/`end` accept `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (UTC). A date-only start is 00:00 and a date-only end is the whole day. `fetchReadings` splits the range into whole-day chunks, then puts the times back on the first and last NOAA request (`begin_date=20121029 20:00`). Daily data ignores times. The end may be later today, but not a future day.
- **Adding a route:** create a Router module in `src/routes/` (full paths, e.g. `/locations/:loc/risk`) and mount it in `routes/index.js`. Don't define routes in `app.js` or outside `routes/`.
- **Latest** (`fetchLatest` in `noaa.js`): NOAA `one_minute_water_level` with `date=latest` (`LATEST_RESOLUTION = '1min'`). 1-minute rows have only `t` and `v`, so `s`/`f` are null and `q` is set to `'p'`: NOAA never verifies 1-minute data. Gauges transmit in 6-minute batches, so the latest minute can be up to ~6 minutes old. `reading` is `null` when the gauge reported nothing recently (outage or decommissioned), which is a 200, not an error. NOAA forecasts and DeepMind data from the plan are not included yet.

- **Resolution** (`RESOLUTIONS` in `noaa.js`): set with `resolution`. The default is `6min`, so API callers get full detail unless they opt out. The response's `resolution` field says which one was used.

  | `resolution` | NOAA product | Max range per call | Notes |
  |---|---|---|---|
  | `1min` | `one_minute_water_level` | 31 days (4 per NOAA request) | Never verified, so always preliminary. Starts around 2008. Opt-in only: `auto` never picks it. |
  | `6min` (default) | `water_level` | 366 days | Preliminary within days, verified later |
  | `hourly` | `hourly_height` | 3,660 days | Verified only, so it lags real time by about a month |
  | `daily` | `daily_max_min` | No limit | Verified only, lags by one to two months. One reading per day. |
  | `auto` | Picks one of the above | | `6min` up to 92 days, `hourly` up to 1,100 days, otherwise `daily`. The frontend uses this. |

- **`start=earliest`:** fetches each station's whole record.
  - **Search start:** each station is searched from `probeStartFor(established)`, which is 10 calendar years before its NOAA `established` date, or 1850-01-01 if there is none. The margin exists because `established` is approximate: Prudhoe Bay has data two years before its listed date. The empty early chunks are skipped.
  - **Reported start:** the response's `start` is the oldest reading actually found.
  - **Resolution:** `auto` means `daily`. An explicit `6min`/`hourly` that can't span the record returns 400.
  - **Late stations:** a station established after `end` gets a "No data was found" error rather than a date error.
- **Date rules** (`getDateRangeError` in `noaa.js`): strict `YYYY-MM-DD` format, real calendar dates (no Feb 30), `start <= end`, and neither in the future. The range must also fit the resolution's maximum. Both dates are inclusive: `end` covers that whole day in UTC. A 400 response names the rule that failed.
- **Errors:** an unknown location or station returns 404, and bad or missing dates return 400, both as `{ error: "<message>" }`.
- **Metadata:** both endpoints return `datum`, `units`, `timeZone` and `retrievedAt` at the top level. `retrievedAt` records when NOAA's preliminary/verified flags were observed, which matters for settlement.
- **Partial failures:** on the location endpoint, one station failing does not fail the request. That station's entry gets `error` instead of `readings`, and the response is still 200. The station endpoint returns 502 when NOAA fails.

Location response shape:

```json
{
  "location": "nyc", "start": "2012-10-29", "end": "2012-10-30", "resolution": "6min",
  "datum": "MLLW", "units": "english", "timeZone": "GMT", "retrievedAt": "2026-11-09T22:00:17.950Z",
  "stations": [
    { "station": "8518750", "name": "The Battery", "readings": [ /* reading */ ] },
    { "station": "8531680", "name": "Sandy Hook", "error": "NOAA API error: ..." }
  ]
}
```

Reading shape (from `parseReadings` in `noaa.js`):

```json
{ "station": "8518750", "datum": "MLLW", "units": "english",
  "t": "2012-10-29T23:00:00.000Z", "v": 4.21, "s": 0.02, "f": "0,0,0,0", "q": "v" }
```

- `t` is always ISO-8601 UTC.
- `v` (water level, ft) and `s` (sigma) are numbers, or `null` when NOAA sends an empty or non-numeric value.
- `f` holds NOAA's data flags.
- `q` is the quality flag: `"p"` preliminary, `"v"` verified, or `null`. Hourly and daily readings are always `"v"`, because those NOAA products are verified-only.

Daily readings (`parseDailyMaxMin`) have a different shape:
- `t`/`v` are the day's **maximum**, which is what a surge trigger cares about.
- `tMin`/`vMin` are the day's minimum.
- `complete` is the % of the day's data NOAA had.
- `source` is `"6min"` or `"hourly"`: which NOAA data the max and min were computed from.

## NOAA Integration (`backend/src/noaa.js`)

- **Request parameters:** every request uses the CO-OPS Data API `datagetter` with the resolution's `product`, plus `datum=MLLW`, `units=english`, `time_zone=gmt` and `application=rhodex-water-level-api`.
- **Datum:** NOAA requires a datum on water-level requests.
- **Date format:** NOAA wants dates as `YYYYMMDD`, so `toNoaaDate` converts from our `YYYY-MM-DD`.
- **Errors:** NOAA reports errors either as a non-2xx status or as a 200 whose body has an `error` field. The body may not be JSON. `fetchReadings` handles all three cases and throws `Error("NOAA API error: ...")`.
- **Paging:** each NOAA product has a per-request limit (`chunkDays`): 31 days for 6-minute, 365 for hourly, 3,650 for daily. `fetchReadings` uses `splitDateRange` to break the range into non-overlapping chunks of that size. It fetches them one after another and joins them, oldest first.
- **Daily, two sources:** NOAA computes daily max/min either from 6-minute data (`interval=6`, which keeps the true storm peak but only exists from the mid-1990s) or from hourly data (which reaches back to the 1910s–20s). `fetchDailyChunk` requests both and keeps the 6-minute value for any day that has one.
- **Gaps:** NOAA reports a window with no data (a gauge outage, or a date before the station existed) as an error. A chunk like that is skipped. If every chunk is empty, the station fails with "No data was found".
- **No partial data:** any other NOAA error in any chunk fails the whole station, so a settlement never rests on silently partial data.
- **Size:** a full year of 6-minute data is about 87,600 readings per station, roughly 30 MB of JSON for the three NYC gauges, and takes about 20 s. The resolution caps keep every response around that size or smaller. A full NYC daily history (back to 1910) comes to about 83k readings and takes about 10 s.
- **Real outages:** NOAA itself sometimes returns rows with an empty value and all flags set (`f: "1,1,1,1"`), as during Sandy Hook's recovery in December 2012. These pass through with `v: null`.

## Adding a Location

Add an entry to `LOCATION_STATIONS` in `backend/src/stations.js`. The array order is the order stations appear in responses (tests assert NYC's order). Every ID must exist in `data/stations.json`. `getStationsForLocation` silently drops unknown IDs.

## Testing Conventions

Tests use Vitest + Supertest against `buildApp()` and never call the real NOAA. They stub the global `fetch`:

```javascript
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app.js';

beforeEach(() => {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    json: async () => ({ data: [{ t: '2012-10-29 23:00', v: '4.21', s: '0.02', f: '0,0,0,0', q: 'v' }] }),
  }));
});
afterEach(() => vi.unstubAllGlobals());

test('returns readings', async () => {
  const res = await request(buildApp()).get('/stations/8518750/historical?start=2012-10-29&end=2012-10-30');
  expect(res.status).toBe(200);
});
```

- Use dates in the past; future dates are rejected by validation.
- To simulate one station failing, branch on `String(url).includes('station=<id>')` inside the stub.

## Frontend Notes

- **Routing:** hash routes, with no router library. `#/historical?...` renders `src/historical/HistoricalPage.jsx`. Any other hash shows the landing page in `App.jsx`, where `#how`-style hashes stay in-page section links.
- **Page layout** follows the company's "Build a bond" page (screenshot in `frontend/references/`):
  - **Header:** a "← RHODEX." back link, a title and a one-line subtitle.
  - **Sections:** numbered cards from `src/components/Section.jsx` ("01 Request", with × / + to collapse), each with a hairline under its header. Inside, use `SubLabel` for uppercase sub-headings, `.sec-cols` for the two-column layout, `.sec-summary` for a mono summary box with an "Edit" link, `.sec-source` for the source line and `.sec-foot` for a centered action. All of these are styled in `global.css`.
  - **Highlight key fields:** a checkbox on the page root sets `data-highlight="on"`. Add `.hl` to any input or box, or `.hl-text` to any value, that a trigger depends on, and it gets outlined or colored in the accent.
- **Historical page** (`src/historical/`):
  - **Sections:** 01 Request (the form; the location picker is an option box), 02 Readings (summary, gauge cards, chart, trigger sentence, source, CSV), and 03 Readings table (collapsed, and only built when opened).
  - Calls the backend through `src/api.js`.
  - Its form lives in the URL (`target=location:nyc|station:<id>`, `start`, `end`, `resolution`, `trigger`, `latest=1`), so a link reopens the same view. With a time range, `start`/`end` carry the time (`2026-11-11T21:00`).
  - **Time range:** the time inputs under the dates are dimmed and disabled unless the "Time range" checkbox or the "Latest" chip is on (`timesOn(form)`). Otherwise requests are whole days. Editing a time switches on the checkbox; a whole-day preset switches it off.
  - **Latest chip:** the last 60 minutes up to the moment the request runs (`latestWindow()` in `time.js`), at `1min`, with the resolution locked. It fetches through `/historical` with a time range, not `/latest`. Cards lead with each gauge's latest value and list the hour's peak. A `latest=1` link always means the last hour when opened.
  - `time.js` mirrors the backend's resolution limits so the form can explain them before a request. The API's 400 messages are still shown as-is.
  - `ReadingsChart.jsx` keeps the lowest and highest reading per pixel column, so peaks survive at any range. Lines break at gaps longer than 2.5 reading intervals.
  - Colors come from the dataviz reference palette; each gauge's color is fixed by its position in the location.
- **Landing page:** the live-gauge panel in `App.jsx` still calls NOAA directly (last 24h for the three NYC gauges), not the backend.
- **Planned endpoints:** the landing page's endpoint list includes `/risk` and `/forecast`. Those are planned; `/historical` and `/latest` exist (`/latest` without forecasts so far).

## Theme (`frontend/src/theme/`)

The company design system, copied from another Rhodex project. Keep these files as close to upstream as possible. The only local change is `Tokens.js` being renamed to `tokens.js`, to match the import in `ThemeProvider.jsx`.

- **Two themes:** **Lapis** (the default) is IBM Plex Mono on a blue-gray gradient, with square "brutalist" buttons and glass cards. **Ghost** is a white "clean room": Plex Sans, hairline borders, 8–10px radii and a soft shadow. Users switch with `ThemeSwitcher` in the header, and the choice is stored in localStorage (`rhodex-theme`).
- **How it applies:** `ThemeProvider` (wrapping `<App/>` in `main.jsx`) writes the active theme's tokens onto `:root` as `--rhodex-*` variables and sets `<html data-theme="lapis|ghost">`.
- **Primitives:** use `ActionButton`, `Surface` and `Tag` from `Primitives.jsx` for buttons, cards/panels and status chips, so both themes render correctly. Their tones mean different things per theme: `primary` is a filled blue button in Lapis but an outline in Ghost. Don't hand-roll buttons or cards.
- **Tailwind:** the primitives are written in Tailwind v3 classes, so `index.css` has the `@tailwind` directives and `tailwind.config.js` / `postcss.config.js` exist. Page styles stay in plain CSS (`global.css`, `historical/historical.css`) and read the theme through `--app-*` variables defined in `global.css`. Those map `--rhodex-*` tokens and add per-theme values such as `--app-line`, `--app-radius`, `--app-field` and `--app-plot`, keyed on `[data-theme]`.
- **Selector caveat:** Tailwind utilities are single-class selectors. Keep page selectors that could hit a primitive at low specificity (e.g. `:where(.app-root) a`), or they override the primitive's colors.
- **Light only:** both themes are light, so there is no dark mode.
- **Chart colors:** `--series-1…8` in `historical.css` are the dataviz reference palette, using its darker orange and aqua steps. They were validated against both theme chart surfaces (Lapis chart panel ≈ #E5EAEE, Ghost ≈ #FEFEFF). The Lapis chart panel is deliberately more opaque than a normal glass card so the lines keep contrast. Re-run the validator if you change either.
