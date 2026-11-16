# water-level-api

An API and web page for NOAA tide-gauge water levels, built so parametric (catastrophe) bonds can be written and settled against them. A parametric bond pays out when a gauge reading crosses a threshold. The reference case is the MTA's storm-surge bond, which pays on New York City tide gauges.

- **Ask for a place, get its gauges:** `nyc` resolves to The Battery, Sandy Hook and Kings Point. Any of NOAA's ~300 water-level stations can also be requested by ID.
- **Any date or time range:** the API pages past NOAA's per-request limits and steps down to hourly or daily data for long ranges.
- **A settlement-grade record:** every reading keeps its gauge, UTC time, value, and whether NOAA marked it *preliminary* or *verified*.

Data comes live from the [NOAA CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/prod/). No API key is needed.

## Run it

Requires **Node.js 22.12+**.

```bash
cd backend && npm install && npm run dev      # API on http://localhost:3000
cd frontend && npm install && npm run dev     # in a second terminal; open http://localhost:5173
```

Use **Historical** to pick a location, a date range (or **Latest** for the last hour of 1-minute data), a resolution and an optional trigger level. The form is stored in the URL, so any view can be bookmarked or shared.

If port 3000 is taken, run the backend with `PORT=3001 npm run dev` and the frontend with `API_TARGET=http://localhost:3001 npm run dev`.

## API

| Endpoint | Returns |
|---|---|
| `GET /locations` | Named locations and their gauges |
| `GET /stations` | Every NOAA water-level station |
| `GET /locations/:location/historical` | Readings for every gauge in a location |
| `GET /stations/:stationId/historical` | Readings for one gauge |
| `GET /locations/:location/latest` | Most recent reading from each gauge in a location |
| `GET /stations/:stationId/latest` | Most recent reading from one gauge |
| `GET /health` | `{ status: "ok" }` |

`/historical` takes:

| Parameter | Values |
|---|---|
| `start` | `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (UTC, inclusive), or `earliest` for each gauge's whole record |
| `end` | `YYYY-MM-DD` (whole day) or `YYYY-MM-DDTHH:mm` (UTC, inclusive) |
| `resolution` | `1min`, `6min` (default), `hourly`, `daily` or `auto` |

```bash
curl "http://localhost:3000/locations/nyc/historical?start=2012-10-28&end=2012-10-31"
curl "http://localhost:3000/stations/8518750/historical?start=2012-10-29T20:00&end=2012-10-30T04:00"
curl "http://localhost:3000/stations/8518750/historical?start=earliest&end=2026-01-01&resolution=auto"
```

Each reading looks like `{ "t": "2012-10-30T01:24:00.000Z", "v": 14.055, "s": 0.046, "f": "0,0,0,0", "q": "v" }`:
- `t` is the UTC time.
- `v` is feet above MLLW, or `null` if NOAA has no value.
- `q` is `p` (preliminary) or `v` (verified).

Responses also carry `resolution`, `datum`, `units` and `retrievedAt`. Daily readings are the day's maximum, with the minimum in `tMin`/`vMin`.

**Errors:**
- `400`: bad dates or a range too long for the resolution.
- `404`: unknown location or station.
- `502`: NOAA failed. On location endpoints, a failing gauge gets an `error` field instead, and the other gauges still return.

## Resolutions

| Resolution | Max range | Notes |
|---|---|---|
| `1min` | 31 days | Always preliminary. Only from about 2008. Never picked by `auto`. |
| `6min` | 1 year | Preliminary within minutes, verified later |
| `hourly` | 10 years | Verified only, about a month behind |
| `daily` | Unlimited | Verified only, 1–2 months behind. Back to the early 1900s at many gauges. |

`auto` uses 6-minute data up to 92 days, hourly up to about 3 years, and daily beyond that.

## Things worth knowing

- **Datum:** MSL (Mean Sea Level) or NAVD88 (North American Vertical Datum of 1988), standard for surge models.
- **Preliminary vs verified:** NOAA revises preliminary readings when it verifies them. A bond's terms decide which counts, so every reading carries `q` and every response records `retrievedAt`.
- **Gaps are real:** gauges go offline. Sandy Hook stopped reporting during Hurricane Sandy. Missing data is skipped, but any other NOAA error fails that gauge rather than returning partial data.
- **Great Lakes, Niagra Falls, & Puerto Rico stations** Requests for them currently fail as they do not have MSL or NAVD88 Data.

## Project layout

```
backend/    Express API: src/routes/ (endpoints), src/noaa.js (NOAA paging and parsing),
            src/stations.js (locations → gauges), data/stations.json, scripts/, tests/
frontend/   React + Vite: src/historical/ (readings page), src/theme/ (company theme)
docs/       CLAUDE.md (detailed developer notes)
```

## Development

```bash
cd backend && npm test                       # tests run offline against a fake NOAA
cd backend && node scripts/syncStations.js   # refresh the NOAA station list
cd frontend && npm run build                 # set VITE_API_BASE if the API isn't at /api
```

To add a location, add an entry to `LOCATION_STATIONS` in `backend/src/stations.js`, using station IDs from [NOAA's station map](https://tidesandcurrents.noaa.gov/map/).
