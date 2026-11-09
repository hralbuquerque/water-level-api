Parametric Water-Level API — Project Brief
Oct 9, 2026 · @Someone
Goal and impact
Build an API layer on top of NOAA water-level gauges that we can structure parametric bonds against. The reference case is the NY MTA's storm surge cat bond (MetroCat Re), which pays out based on readings from a set of tide gauges around New York City rather than on assessed losses (Business Insurance).
If this works, we can do the MTA-style deal and reuse the same framework for any other sponsor that wants one. Parametric means we can pay out as fast as the API says a trigger was hit.
This brief is deliberately broad. It fixes the order of work and the features we want, and leaves the design to you. Push back on anything that doesn't hold up once you're in the data.
Deadline and checkpoints
Deadline: before Halloween, so done by Oct 30, 2026.
1. Runs locally. Core endpoints work end to end on your machine, tests green.
    ◦ Storage may be light here if NOAA lets us pull historical ranges on demand.
    ◦ Proof point: can we replicate the MTA bond's trigger from gauge data?
2. Deployed. Same code running on AWS behind API Gateway, tests still green.
3. Integrated. The API is called from the main deals repo.
Phase 1: learn the data, then generalize
The one concrete ask is the order of work. Discovery comes before any API design.
1. Read NOAA's water-gauge docs. Start with the CO-OPS Data API, Metadata API (station lists) and Derived Product API (extreme water levels, top-ten events).
2. Connect and document what's actually there. For each product: what data, at what cadence, how far back, how fresh, and per-request limits. Note the difference between preliminary and verified readings, since settlement will likely care which one counts.
3. Decide whether it generalizes. If each city needs its own endpoints or params to the point we can't abstract it, document that and stop there.
4. If it does generalize, keep the interface dead simple. A location should resolve to its gauges: NYC → the NYC gauges. Station-level IDs stay available underneath.
Where to start: NOAA's docs are clean. Browse stations on the station map (New York region), then pull data through the CO-OPS Data API.
A few things already visible in the docs, worth confirming: a datum is mandatory on water-level requests, verified data at each interval is its own product, and 6-minute data is capped at about a month per request (hourly at a year), so long histories need paging.
Features
The first four are the core; alerts and the AI fetcher are stretch, but worth laying foundations for.
Feature
What it does
Priority
Historical
Readings for a location over a date range
Core
Latest
Today's / most recent reading, plus auxiliary data: NOAA forecast readings and Google DeepMind precipitation and cyclone forecasts
Core
Risk profile
Stats on how often this area reaches risky levels
Core
Forecast
Forecasted readings for the location
Core
Alerts (internal)
How many of our bonds rely on this gauge, and how many have triggers close to today's reading. The big-picture view.
Stretch
AI news fetcher
Use history to judge when a reading is significant, then kick off an AI workflow to find related news
Bonus
On the DeepMind side, Weather Lab offers downloadable cyclone track forecasts (CSV/ATCF) and its global forecasts are reachable via BigQuery, Earth Engine and Cloud Storage. Real-time data is under experimental terms of use, so flag early if we need a different access agreement. NOAA's Derived Product API also has extreme water level and exceedance data that may shortcut the risk profile.
Your call: more risk and pricing features
The list above is a floor, not a ceiling. If you see a feature that helps us address or price risk, build it and document it; no need to check first. Some starters:
• Return-period curves per gauge (how high is a 1-in-10, 1-in-50, 1-in-100 year surge)
• Expected loss for a given trigger level, to sanity-check bond pricing
• Backtesting: replay a proposed trigger against every historical storm
• Basis risk: how far gauges in one area disagree during the same event
• Sea-level trend adjustment, so old readings compare fairly with today's
Storage
We don't need to store everything, but we do need a clear, reliable record of the readings a deal settles on. If a bond triggers, we should be able to show exactly which reading, from which gauge, at what time, and whether it was preliminary or verified when we used it.
How much else to cache is your call once you know what NOAA serves on demand.
Stack, infra and testing
• Language: Python, js fire, also feel free to try RUST  for more performannce(AWS on running Rust). 
• Infra: AWS, with Lambda and API Gateway. Good resume skill, and it lets us get detailed with security. at that check point I can help set that up.
• Repo: a separate repo to keep this lean & shoot over an invite 
• Testing: make your room glow with green passes.
Visual: the data-pipeline globe
More of a bonus. Build a visual in our GHOST design that shows every data pipeline we have, and so every place we can now write deals against. Think a globe with each gauge network lit up, but get creative with it.
Other bonus Ideas to riff on, not requirements:
• Gauges as points that pulse with their latest reading, colored by how close they sit to a trigger
• Live storm tracks from the DeepMind feed drawn over the globe
• Arcs from each pipeline to the bonds that depend on it, sized by notional
• A scrub bar to replay a past storm (Sandy over NYC) and watch triggers fire

Open questions
[x] Where does the GHOST design system live? Answered: the RHODEX GHOST brief from the August Build a Bond workshop spec (summary under the globe section).
[ ] What's the --green hex? The August spec points at the repo for it.
[ ] Separate repo, or inside the main one?
[ ] Which gauges and threshold logic does the MTA trigger use? The public coverage doesn't spell it out; we may need the offering circular.
[ ] Is MTA renewing? The 2023-1 notes were on risk until end of April 2026, and I haven't confirmed a 2026 issuance.
[ ] Do we need extra data access (DeepMind real-time terms, anything else)?
Sources
• MetroCat Re 2023-1 — Artemis Deal Directory
• MTA secures $100m MetroCat Re cat bond — Artemis
• New York's MTA buys $200 million cat bond — Business Insurance
• CO-OPS Data API
• CO-OPS web services overview
• CO-OPS Derived Product API
• Weather Lab guide — Google



# Water Levels API Phase 1

## Goal

Build a water-level data layer for catastrophe-bond trigger tracking, using NOAA's water-gauge APIs.

### Research steps
1. Read NOAA's water-gauge docs: the CO-OPS Data API, Metadata API (station lists) and Derived Product API (extreme water levels, top-ten events).
2. Connect and document what's actually there. For each product: what data, at what cadence, how far back, how fresh, and per-request limits. Note the difference between preliminary and verified readings, since settlement will likely care which one counts.
3. Decide whether it generalizes. If each city needs its own endpoints or params to the point we can't abstract it, document that and stop there.
4. If it does generalize, keep the interface dead simple. A location resolves to its gauges (NYC → the NYC gauges). Station-level IDs stay available underneath.

## Findings: NOAA data

**It generalizes.** Every city uses the same endpoints and parameters. Only the station ID changes.
**Station history varies.** Stations differ in age, so some hold far more historical data than others. Check a station's record length before promising a date range. The Metadata API's station `details` includes an `established` date.


### Data API products

| Product | Cadence | Max span per request | Status |
|---|---|---|---|
| `water_level` | 6-min | 1 month | Preliminary, or verified once available |
| `one_minute_water_level` | 1-min | 4 days | Preliminary only |
| `hourly_height` | Hourly | 1 year | Verified |
| `high_low` | Per tide | 1 year | Verified |
| `daily_max_min` | Daily | 10 years | Verified, from hourly or 6-min (`interval=6`). Needs `time_zone` lst or gmt |
| `predictions` | 1 to 60-min or `hilo` | 1 year (`hilo`: 10 years) | Harmonic model, not observed |
| `ofs_water_level` | 6-min | Not stated | Model guidance, 2020 to present |

### Storms

- The MetroCat trigger requires a **named storm**. The CO-OPS Data API has no storm information, only raw oceanographic and meteorological observations.
- Approach: cross-reference storm dates and check whether the station is in the path of the storm.
- The Metadata API has a `stormsurge` field (boolean): whether the station is in storm surge mode.
- The Derived Product API's `peakwaterlevels` lists storm events by year.

## Reference: MTA MetroCat bond

- For 2023, the MTA reverted to seeking only named-storm-induced storm surge protection (parametric surge risk only), which drew broader investor support.
- Payout needs both a **named storm** and a surge that reaches a threshold.
- Size: MTA sought $75M or more, and the deal increased to **$100M**.
- Two storm surge areas, each needing a different depth of named-storm-linked surge for any payout. Measurements come from recognized tidal gauge stations around New York.
- Term: almost three years, on risk until the end of April 2026.
- Attachment probability: **1.337%**.
- Expected loss: **1.337%**, because the binary trigger is all-or-nothing.

## Features

| Feature | What it does | Priority |
|---|---|---|
| Historical | Readings for a location over a date range | Core |
| Latest | Today's / most recent reading, plus auxiliary data: NOAA forecast readings and Google DeepMind precipitation and cyclone forecasts | Core |
| Risk profile | Stats on how often this area reaches risky levels | Core |
| Forecast | Forecasted readings for the location | Core |
| Alerts (internal) | How many of our bonds rely on this gauge, and how many have triggers close to today's reading. The big-picture view | Stretch |
| AI news fetcher | Use history to judge when a reading is significant, then kick off an AI workflow to find related news | Bonus |