# water-level-api

An API and web page for NOAA tide-gauge water levels, built so parametric (catastrophe) bonds can be written and settled against them.

A parametric bond pays out when a measurement crosses a threshold, not when someone assesses a loss. The reference case is the MTA's MetroCat Re storm-surge bond, which pays on readings from tide gauges around New York City. This project makes those readings easy to get and easy to audit:

- **Ask for a place, get its gauges.** `nyc` resolves to The Battery, Sandy Hook and Kings Point. Any of NOAA's ~300 water-level stations can also be requested directly by ID.
- **Any date range.** NOAA limits how much data one request can return. The API pages through those limits for you and steps down to hourly or daily data for long ranges.
- **A settlement-grade record.** Every reading keeps its gauge, its exact UTC time, its value, and whether NOAA marked it *preliminary* or *verified*. Each response also records when it was retrieved.

All data comes from the [NOAA CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/prod/). No API key is needed.

---

## Contents

- [How it works](#how-it-works)
- [Run it yourself](#run-it-yourself)
- [Using the web page](#using-the-web-page)
- [Using the API](#using-the-api)
- [Command-line tool](#command-line-tool)
- [Understanding the data](#understanding-the-data)
- [Project structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
 Browser (frontend/, React + Vite)
   │  GET /api/locations/nyc/historical?start=…&end=…
   ▼
 Vite dev server ── proxies /api ──►  Express API (backend/, port 3000)
                                        │  1. resolve location → gauges
                                        │  2. validate dates, pick a resolution
                                        │  3. split the range into NOAA-sized chunks
                                        ▼
                                  NOAA CO-OPS Data API
                                  (one request per chunk, per gauge)
```

1. **Resolve.** A location like `nyc` maps to its gauge IDs in `backend/src/stations.js`. A station ID is checked against NOAA's station list in `backend/data/stations.json`.
2. **Choose a resolution.** 6-minute data is the most detailed, but NOAA serves at most 31 days of it per request. Hourly data allows a year per request, and the daily max/min allows ten years. See [Resolutions](#resolutions).
3. **Page.** The range is split into chunks that fit NOAA's limit. The chunks are fetched one after another and joined in time order.
4. **Handle gaps honestly.** A chunk where NOAA has no data, such as a gauge knocked out by a storm, is skipped. Any other NOAA error fails that gauge, so a settlement never rests on silently partial data.
5. **Respond.** The response is JSON with one entry per gauge. If one gauge fails, the others still return.

---

## Run it yourself

### Requirements

- **Node.js 22.12 or newer.** Check with `node -v`.
- **Git**
- **An internet connection**, because data is fetched live from NOAA.

### 1. Install dependencies

```bash
git clone <repo link>
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

The backend and frontend are separate projects, each with its own `package.json`, so each needs its own install.

### 2. Start the API

```bash
cd backend && npm run dev
```

You should see `Water Level API server running on http://localhost:3000`. Check it with:

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"…"}
```

Leave this terminal running.

### 3. Start the web page

In a second terminal:

```bash
cd frontend && npm run dev
```

Open the address Vite prints, usually **http://localhost:5173**. Click **Historical** in the top navigation to reach the readings page.


## Using the web page

The **Historical readings** page (`/#/historical`) lets you:

| Control | What it does |
|---|---|
| **Location or gauge** | Search by city, gauge name, state or station ID (e.g. `Battery`, `NY`, `8518750`). |
| **Date range** | Quick picks (last 7 days through *All history*, plus a Hurricane Sandy preset) or custom dates. All dates are UTC. *All history* goes back to each gauge's first reading, however old. |
| **Resolution** | *Auto* picks the best detail for the range length. You can force 6-minute, hourly or daily max. |
| **Trigger level** | Optional. Draws the level on the chart and reports how long each gauge stayed at or above it, and when it first got there. |

The results show:
- A summary card per gauge: peak reading, verified vs preliminary share, and any coverage gaps.
- A chart with a hover readout. Use the arrow keys when the chart has focus.
- A table view.
- A **Download CSV** button that exports every reading with its status and retrieval time.

The whole form is stored in the URL, so you can bookmark or share a view. For example:

```
http://localhost:5173/#/historical?target=location:nyc&start=2012-10-22&end=2012-11-05&resolution=auto&trigger=10
```

---

## Using the API

Base URL when running locally: `http://localhost:3000`

### Endpoints

| Method & path | Returns |
|---|---|
| `GET /health` | `{ status: "ok", timestamp }` |
| `GET /locations` | Named locations and their gauges |
| `GET /stations` | Every NOAA water-level station (id, name, state, lat, lng, established) |
| `GET /locations/:location/historical` | Readings for every gauge in a location |
| `GET /stations/:stationId/historical` | Readings for one gauge |

### Query parameters for `/historical`

| Parameter | Required | Example | Notes |
|---|---|---|---|
| `start` | yes | `2012-10-22` | `YYYY-MM-DD`, UTC, inclusive. Or `earliest` for each gauge's whole record (see below). |
| `end` | yes | `2012-11-05` | `YYYY-MM-DD`, UTC, inclusive (covers the whole day) |
| `resolution` | no | `auto` | `6min` (default), `hourly`, `daily` or `auto` |

### Examples

```bash
# Hurricane Sandy at the three NYC gauges, 6-minute data
curl "http://localhost:3000/locations/nyc/historical?start=2012-10-28&end=2012-10-31"

# One gauge by station ID
curl "http://localhost:3000/stations/8518750/historical?start=2012-10-28&end=2012-10-31"

# Every daily maximum at The Battery since its records began (1920)
curl "http://localhost:3000/stations/8518750/historical?start=earliest&end=2026-01-01&resolution=auto"

# Let the API choose the resolution
curl "http://localhost:3000/locations/nyc/historical?start=2020-01-01&end=2024-12-31&resolution=auto"
```

### Whole records: `start=earliest`

`start=earliest` returns each gauge's full record, however far back it goes. Each gauge in a location starts at its own first reading: for NYC, Sandy Hook from 1910, The Battery from 1920 and Kings Point from 1998.
- **Reported start:** the response's `start` is the date of the oldest reading actually found.
- **Resolution:** with `resolution=auto` (or `daily`) you get daily maxima. 6-minute and hourly data can't cover records this long.
- **How it searches:** for each gauge, the API starts looking 10 years before the date NOAA lists the station as `established`. That margin matters because some stations have older data: Prudhoe Bay is listed as 1990 but has readings from 1988.

### Response

```json
{
  "location": "nyc",
  "start": "2012-10-28",
  "end": "2012-10-31",
  "resolution": "6min",
  "datum": "MLLW",
  "units": "english",
  "timeZone": "GMT",
  "retrievedAt": "2026-11-10T17:26:00.000Z",
  "stations": [
    {
      "station": "8518750",
      "name": "The Battery",
      "readings": [
        { "station": "8518750", "datum": "MLLW", "units": "english",
          "t": "2012-10-30T01:24:00.000Z", "v": 14.055, "s": 0.046, "f": "0,0,0,0", "q": "v" }
      ]
    },
    { "station": "8531680", "name": "Sandy Hook", "error": "NOAA API error: …" }
  ]
}
```

| Field | Meaning |
|---|---|
| `t` | Time of the reading, ISO-8601 UTC |
| `v` | Water level in **feet above MLLW** (mean lower low water), or `null` if NOAA has no value |
| `s` | Standard deviation of the 1-second samples behind the reading (6-minute and hourly only) |
| `f` | NOAA's data-quality flags |
| `q` | `"p"` preliminary or `"v"` verified |
| `retrievedAt` | When the API fetched the data. Preliminary readings can be revised later, so this is part of the audit trail. |

Daily readings have one entry per day:
- `t`/`v` are the day's **maximum**.
- `tMin`/`vMin` are its minimum.
- `complete` is the % of the day NOAA had data for.
- `source` says whether NOAA computed the day from 6-minute or hourly data.

### Errors

| Status | When | Body |
|---|---|---|
| `400` | Missing, invalid or future dates; a range too long for the resolution; an unknown resolution | `{ "error": "<which rule failed>" }` |
| `404` | Unknown location or station ID | `{ "error": "unknown location" }` |
| `502` | NOAA failed (single-station endpoint only) | `{ "error": "NOAA API error: …" }` |

On the **location** endpoint, a failing gauge does not fail the request. That gauge gets an `error` field instead of `readings`, and the response is still `200`.

---

## Command-line tool

Fetch readings without running a server:

```bash
cd backend
node scripts/cli.js --start 2012-10-29 --end 2012-10-30 -o text              # NYC gauges, summary
node scripts/cli.js -s 8518750 --start 2012-10-29 --end 2012-10-30           # one station, full JSON
node scripts/cli.js --help
```

The CLI always uses 6-minute data, so its ranges are limited to 366 days.

---

## Understanding the data

### Resolutions

| Resolution | NOAA product | Max range per API call | Freshness | Best for |
|---|---|---|---|---|
| `6min` | `water_level` | 1 year | Near real time (preliminary first, verified later) | Recent days, storm detail, settlement |
| `hourly` | `hourly_height` | 10 years | Verified only, about 1 month behind | Multi-year views |
| `daily` | `daily_max_min` | Unlimited | Verified only, 1–2 months behind | Decades of history, storm rankings |

`auto` uses 6-minute data up to 92 days, hourly up to about 3 years, and daily beyond that.

### Things worth knowing

- **Datum.** Levels are feet above **MLLW**, the average of each day's lower low tide over NOAA's reference epoch. A reading of 14 ft means 14 ft above that baseline, not 14 ft of flooding.
- **Preliminary vs verified.** NOAA publishes readings as *preliminary* within minutes, then reviews them and marks them *verified*, usually within a month or two. A bond's terms decide which counts, which is why every reading carries `q` and every response carries `retrievedAt`.
- **Gaps are real.** Gauges go offline. Sandy Hook stopped reporting at 23:36 UTC on Oct 29, 2012, when Hurricane Sandy destroyed it. The page shows coverage gaps on each gauge's card.
- **Station history varies.** Some gauges reach back to the 1850s–1900s (San Francisco's daily data starts in 1898) and others started recently. A range before a gauge existed simply returns its earliest data. Use `start=earliest` to get everything.
- **Response size.** A year of 6-minute data is about 87,600 readings per gauge, around 30 MB for the three NYC gauges, and takes about 20 seconds to fetch. Use `auto`, `hourly` or `daily` for longer ranges.

---

## Project structure

```
water-level-api/
├── backend/                     Express API (Node.js, ES modules)
│   ├── src/
│   │   ├── server.js            Starts the server (PORT, default 3000)
│   │   ├── app.js               Express setup: security headers, CORS, /health
│   │   ├── routes/index.js      All /locations and /stations endpoints
│   │   ├── noaa.js              NOAA requests, paging, parsing, date validation
│   │   └── stations.js          Station list + location → gauge mapping
│   ├── data/stations.json       NOAA's water-level station list
│   ├── scripts/
│   │   ├── cli.js               Command-line client
│   │   └── syncStations.js      Refreshes data/stations.json from NOAA
│   └── tests/                   Vitest + Supertest tests (no network needed)
├── frontend/                    React + Vite web app
│   ├── vite.config.js           Proxies /api to the backend
│   ├── tailwind.config.js       Tailwind, used by the shared company theme
│   └── src/
│       ├── App.jsx              Landing page + routing
│       ├── api.js               Calls the backend
│       ├── theme/               Company theme (Lapis / Ghost): tokens, provider, switcher, primitives
│       └── historical/          Historical readings page (page, chart, picker, helpers)
└── docs/
    ├── plan.md                  Project brief, research findings, roadmap
    └── CLAUDE.md                Detailed notes for AI coding assistants
```

---

## Development

### Tests

```bash
cd backend
npm test                              # all tests
npx vitest run tests/health.test.js   # one file
```

The tests replace `fetch` with fakes, so they never call NOAA and run offline.

### Add a location

Add an entry to `LOCATION_STATIONS` in `backend/src/stations.js`:

```js
const LOCATION_STATIONS = {
  nyc: { label: 'New York City', stations: ['8518750', '8531680', '8516945'] },
  boston: { label: 'Boston', stations: ['8443970'] },
};
```

Station IDs must exist in `backend/data/stations.json`. You can browse IDs on [NOAA's station map](https://tidesandcurrents.noaa.gov/map/). The new location then appears in `GET /locations` and in the web page's picker.

### Refresh the station list

This rewrites `backend/data/stations.json` with NOAA's current station list, including each station's `established` date. That date is where `start=earliest` begins searching.

```bash
cd backend
node scripts/syncStations.js
```

### Build the frontend for production

```bash
cd frontend
npm run build                                    # outputs to frontend/dist/
VITE_API_BASE=https://your-api.example.com npm run build   # if the API lives elsewhere
```

### Configuration

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `PORT` | backend | `3000` | Port the API listens on |
| `API_TARGET` | frontend (dev) | `http://localhost:3000` | Where the dev server proxies `/api` |
| `VITE_API_BASE` | frontend (build) | `/api` | Base URL the built page calls |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Port 3000 is already in use` | Another app holds the port. Use `PORT=3001 npm run dev` for the backend and `API_TARGET=http://localhost:3001 npm run dev` for the frontend, or stop the other app. |
| Page says *Could not reach the water-level API* | The backend isn't running, or `API_TARGET` points to the wrong port. |
| `npm install` or `npm test` complains about the engine or Node version | Upgrade to Node.js 22.12 or newer. |
| `No data was found` for a gauge | NOAA has no data for that gauge in that range. It may have been offline, or may not have existed yet. |
| Recent days are missing in hourly or daily view | Those products are verified-only and lag real time. Switch to 6-minute. |
| A range is rejected as too long | Each resolution has a maximum. Choose `auto` or a coarser resolution. |

---

## Roadmap

Historical readings are done. Next up, per [`docs/plan.md`](docs/plan.md): latest readings with forecasts, risk profiles (how often an area reaches risky levels), forecasts, internal alerts, and deployment to AWS Lambda behind API Gateway.
