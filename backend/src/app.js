import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { setupRoutes } from './routes/index.js';

export function buildApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  setupRoutes(app);

  return app;
}

export default buildApp;
