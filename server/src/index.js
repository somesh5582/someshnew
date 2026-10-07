import { app } from './app.js';
import { db } from './db.js';

const requestedPort = Number(process.env.PORT);
const port = Number.isSafeInteger(requestedPort) && requestedPort > 0
  ? requestedPort
  : 4000;

const server = app.listen(port, () => {
  console.log(`HerdBook API is running at http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
