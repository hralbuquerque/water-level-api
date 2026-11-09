#!/usr/bin/env node

/**
 * CLI for the Water Level API. Runs the app in-process, no server needed.
 *
 * Usage:
 *   node scripts/cli.js --location nyc --start 2012-10-29 --end 2012-10-30
 *   node scripts/cli.js --station 8518750 --start 2012-10-29 --end 2012-10-30 --output text
 *
 * Dates can also come from WATER_LEVEL_API_START / WATER_LEVEL_API_END,
 * and the location from WATER_LEVEL_API_LOCATION (default: nyc).
 */

import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';

const HELP = `Fetch historical water level data from NOAA

Options:
  -l, --location <name>   Location group, e.g. nyc (default: nyc)
  -s, --station <id>      Single NOAA station ID, e.g. 8518750 (overrides --location)
      --start <date>      Start date, YYYY-MM-DD (required)
      --end <date>        End date, YYYY-MM-DD (required)
  -o, --output <fmt>      json | text (default: json)
  -h, --help              Show help`;

const { values: args } = parseArgs({
  options: {
    location: { type: 'string', short: 'l' },
    station: { type: 'string', short: 's' },
    start: { type: 'string' },
    end: { type: 'string' },
    output: { type: 'string', short: 'o', default: 'json' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const start = args.start || process.env.WATER_LEVEL_API_START;
const end = args.end || process.env.WATER_LEVEL_API_END;
if (!start || !end) {
  console.error('Error: --start and --end are required\n');
  console.error(HELP);
  process.exit(1);
}

const path = args.station
  ? `/stations/${encodeURIComponent(args.station)}/historical`
  : `/locations/${encodeURIComponent(args.location || process.env.WATER_LEVEL_API_LOCATION || 'nyc')}/historical`;
const query = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;

// Listen on a random free port just for this request
const server = buildApp().listen(0);
try {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}${query}`);
  const body = await response.json();

  if (args.output === 'text') {
    if (body.error) {
      console.log(`Error: ${body.error}`);
    } else {
      const stations = body.stations ?? [body];
      for (const s of stations) {
        console.log(`${s.station} ${s.name}: ${s.error ?? `${s.readings.length} readings`}`);
      }
    }
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
  process.exitCode = response.ok ? 0 : 1;
} catch (err) {
  console.error('Error:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}
