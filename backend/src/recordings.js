/**
 * Water Level Recordings Routes
 *
 * Handles historical water level data retrieval for parametric bond triggers.
 * Endpoints return reading metadata with quality indicators (preliminary vs verified).
 */

import express from 'express';
import { STATIONS } from './stations.js';
import { validateDateRange, fetchReadings } from './noaa.js';

const router = express.Router();

/**
 * POST /api/stations/:stationId/readings
 *
 * Fetch historical water level readings for a station over a date range.
 *
 * Request body:
 * - station: string (NOAA station ID)
 * - from: string (YYYY-MM-DD start date)
 * - to: string (YYYY-MM-DD end date)
 *
 * Success response (200):
 * {
 *   station: "8518750",
 *   datum: "MLLW",
 *   timeZone: "GMT",
 *   readings: [
 *     { t: "2012-10-29T23:00:00.000Z", v: 4.21, q: "p" },
 *     ...
 *   ]
 * }
 *
 * Error responses:
 * - 400: Invalid station or date range
 * - 502: NOAA API error
 */
export function createRecordingsHandler(app) {
  app.post(
    '/api/stations/:stationId/readings',
    async (req, res) => {
      // Extract params from route
      const { stationId } = req.params;

      // Validate station is in noaa's water-level directory
      if (!Object.values(STATIONS).some(s => String(s.id) === stationId)) {
        return res.status(400).json({
          error: {
            message: `Station ${stationId} not in NOAA's water-level directory: The Battery (8518750), Sandy Hook (8531680), Kings Point (8516945)`,
          },
        });
      }

      // Extract body params with defaults
      const { from, to } = req.body || {};
      if (!from || !to) {
        return res.status(400).json({
          error: { message: 'Missing required fields: from and to dates' },
        });
      }

      // Validate date range (<= 31 days, not in future, from <= to)
      if (!validateDateRange(from, to)) {
        const reasons = [];
        if (new Date(`${from.replace(/[-]/g, '/')}`) > new Date()) {
          reasons.push('from date is in the future');
        }
        if (new Date(`${to.replace(/[-]/g, '/')}`) > new Date()) {
          reasons.push('to date is in the future');
        }
        const diffDays = Math.ceil(
          (new Date(`${to.replace(/[-]/g, '/')}`) -
            new Date(`${from.replace(/[-]/g, '/')}`)) /
          (1000 * 60 * 60 * 24),
        );
        if (diffDays > 31) {
          reasons.push('date span exceeds 31-day NOAA limit for 6-minute data');
        }
        if (from > to) {
          reasons.push('start date must be before end date');
        }

        return res.status(400).json({
          error: { message: `Invalid date range: ${reasons.join('. ')}` },
        });
      }

      // Fetch data from NOAA API
      try {
        const readings = await fetchReadings(stationId, from, to);

        const station = STATIONS[stationId];

        res.status(200).json({
          station: String(station.id),
          datum: 'MLLW',
          timeZone: 'GMT',
          quality: readings.reduce((acc, r) => {
            if (r.q === 'v') return 'verified';
            if (r.q === 'p') return 'preliminary';
            return acc;
          }, 'mixed'),
          readings: readings.map(r => ({
            timestamp: r.t,       // ISO string
            value: r.v,           // number or null
            quality: r.q || null,  // 'p', 'v', or null
          })),
        });
      } catch (error) {
        // If NOAA returns error JSON with status 200, pass through
        if (!req.res && req.httpStatus === 200) {
          return res.status(502).json({ error: { message: error.message } });
        }

        // Fallback for other cases - just bubble up the original error
        console.error('NOAA API fetch failed:', error);
        res.status(502).json({ error: { message: 'Failed to fetch data from NOAA' } });
      }
    },
  );

  return app;
}
