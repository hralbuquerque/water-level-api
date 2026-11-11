import { buildApp } from './app.js';

const PORT = process.env.PORT || 3000;

export function startServer() {
  const app = buildApp();
  // Express 5 passes startup errors (e.g. port already in use) to this callback
  app.listen(PORT, (err) => {
    if (err) {
      const hint = err.code === 'EADDRINUSE' ? ` Port ${PORT} is already in use; set PORT to use another one.` : '';
      console.error(`Water Level API failed to start: ${err.message}.${hint}`);
      process.exit(1);
    }
    console.log(`Water Level API server running on http://localhost:${PORT}`);
  });
}

startServer();
