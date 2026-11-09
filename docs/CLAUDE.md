# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The `water-level-api` is a Node.js/Express REST API that interfaces with NOAA water level data services. It's a lightweight, minimalistic API designed for retrieving real-time water level information from NOAA sources.

## Development Commands

The repo is split into `backend/` (Express API) and `frontend/` (Vite + React UI), each with its own `package.json`. Run backend commands from `backend/` and frontend commands from `frontend/`.

### Running the Application

```bash
cd backend && npm run dev      # API on port 3000
cd frontend && npm run dev     # UI via Vite
```

This starts the Express server with automatic reload on file changes, listening on port 3000 by default.

### Running Tests

```bash
npm test
```

Tests are run with Vitest from `backend/`. Individual tests can be run with:

```bash
npx vitest run tests/health.test.js
```

Or for any file in the `tests/` directory:

```bash
npx vitest run <test-file-path>
```

### Common Development Tasks

- **Install dependencies**: `npm install` or `npm run dev` (which includes install)
- **Run development server**: `npm run dev`
- **Lint**: This project uses Node.js built-in syntax features with ESM module support. Linting is not explicitly configured beyond what's available via default Node.js settings.

## Architecture & Structure

### Core Architecture

The application follows a simple modular architecture centered around the Express server:

```
water-level-api/
├── backend/
│   ├── src/
│   │   ├── app.js          # Express middleware, mounts routes
│   │   ├── server.js       # Entry point, starts server on port 3000
│   │   ├── noaa.js         # NOAA API integration module
│   │   ├── stations.js     # Station directory + location -> gauges mapping
│   │   └── routes/         # Route definitions
│   ├── data/stations.json  # NOAA station list (refresh with scripts/syncStations.js)
│   ├── scripts/            # CLI and data sync scripts
│   ├── tests/              # Vitest + Supertest tests
│   └── package.json
├── frontend/               # Vite + React UI
│   ├── src/
│   └── package.json
└── docs/

```

### Module Responsibilities

| File | Responsibility |
|------|----------------|
| `src/server.js` | Server entry point that initializes the app and starts listening on port 3000 |
| `src/app.js` | Express application setup, middleware stack (helmet security headers, CORS), and route definitions |
| `src/noaa.js` | NOAA API integration logic, data fetching, and response handling |
| `tests/*.test.js` | API endpoint tests using Supertest and Vitest |

### Data Flow

1. Incoming HTTP requests reach the Express server configured in `app.js`
2. Route handlers process requests based on URL endpoints
3. For water level data requests, `noaa.js` handles the NOAA API communication
4. Responses are returned to clients as JSON

## Key Files Reference

- **`src/app.js`**: The main application setup file with Express configuration and middleware. Contains the primary routing structure.
- **`src/server.js`**: Minimal entry point that bootstraps the application by calling `buildApp()` from app.js and starting the server.
- **`src/noaa.js`**: Handles communication with NOAA's water level API endpoints.

## Testing Conventions

Tests use Supertest for HTTP request simulation and Vitest for assertion logic. The testing pattern follows modern Node.js conventions:

```javascript
import { test, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";

test("endpoint returns correct response", async () => {
    const res = await request(buildApp()).get('/<route>');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expectedResponse);
});
```

## Development Workflow

1. Run the development server: `npm run dev`
2. Modify source files in `backend/src/`
3. Tests automatically reload with node's watch mode
4. Verify changes don't break tests: `npm test`
