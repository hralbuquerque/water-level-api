import { buildApp } from './app.js';

const PORT = process.env.PORT || 3000;

export function startServer() {
  const app = buildApp();
  app.listen(PORT, () => {
    console.log(`Water Level API server running on http://localhost:${PORT}`);
  });
}

startServer();
