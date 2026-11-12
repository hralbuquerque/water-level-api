import { Router } from 'express';
import { STATIONS, listLocations } from '../stations.js';

const router = Router();

// Named locations and their gauges, e.g. nyc -> The Battery, Sandy Hook, Kings Point
router.get('/locations', (req, res) => {
  res.json({ locations: listLocations() });
});

// Every NOAA water-level station this API can serve
router.get('/stations', (req, res) => {
  res.json({ stations: Object.values(STATIONS) });
});

export default router;
