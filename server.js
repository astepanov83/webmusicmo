#!/usr/bin/env node
// Entry point. Reads its settings from the environment and starts listening.

import http from 'node:http';
import { createApp } from './lib/app.js';

const PORT = Number(process.env.PORT || 8420);
const HOST = process.env.HOST || '127.0.0.1';
const PLS_URL = process.env.PLS_URL || 'https://metal-only.streampanel.cloud/listen.pls';

const server = http.createServer(createApp({ plsUrl: PLS_URL }));

server.listen(PORT, HOST, () => {
  console.log(`webplayer listening on http://${HOST}:${PORT}  (pls: ${PLS_URL})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
