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

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  setupRoutes(app);

  return app;
}

export default buildApp;
