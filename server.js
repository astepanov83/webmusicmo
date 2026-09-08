#!/usr/bin/env node
// Entry point. Reads its settings from the environment and starts listening.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8420);
const HOST = process.env.HOST || '127.0.0.1';
const STATIONS_FILE = process.env.STATIONS_FILE || path.join(ROOT, 'public', 'stations.json');

const server = http.createServer(createApp({ stationsFile: STATIONS_FILE }));

server.listen(PORT, HOST, () => {
  console.log(`webmusicmo listening on http://${HOST}:${PORT}  (stations: ${STATIONS_FILE})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
