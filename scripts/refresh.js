#!/usr/bin/env node
// Rebuild public/stations.json. Run it by hand, from a timer, or from the Docker entrypoint.
//   node scripts/refresh.js
// STATIONS_FILE, SOMAFM_URL and LOCAL_STATIONS_FILE override the paths.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshStations } from '../lib/refresh.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const r = await refreshStations({
    file: process.env.STATIONS_FILE || path.join(ROOT, 'public', 'stations.json'),
    localFile: process.env.LOCAL_STATIONS_FILE || path.join(ROOT, 'stations', 'local.json'),
    somafmUrl: process.env.SOMAFM_URL || 'https://somafm.com/channels.json',
    log: console.log,
  });
  console.log(`done: ${JSON.stringify(r)}`);
} catch (err) {
  console.error(`refresh failed: ${err.message}`);
  process.exit(1);
}
