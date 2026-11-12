// Every HTTP route lives in this folder, one module per feature. Each module
// exports an Express Router with full paths; setupRoutes mounts them all.
import health from './health.js';
import directory from './directory.js';
import historical from './historical.js';
import latest from './latest.js';

export function setupRoutes(app) {
  app.use(health); //     GET /health
  app.use(directory); //  GET /locations, GET /stations
  app.use(historical); // GET /locations/:loc/historical, GET /stations/:id/historical
  app.use(latest); //     GET /locations/:loc/latest, GET /stations/:id/latest
}
