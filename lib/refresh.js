// Build public/stations.json: hand-written stations first, then SomaFM's channel list.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseChannels } from './somafm.js';
import { validateStation } from './stations.js';

const UA = 'webmusicmo/1.0';

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 1));
  await fs.rename(tmp, file);
}

export async function refreshStations({ file, localFile, somafmUrl, fetchImpl = fetch, log = () => {} } = {}) {
  if (!file || !localFile || !somafmUrl) throw new Error('file, localFile and somafmUrl are required');

  const localRaw = JSON.parse(await fs.readFile(localFile, 'utf8'));
  const local = (Array.isArray(localRaw.stations) ? localRaw.stations : []).map(validateStation);

  let somafm;
  try {
    const res = await fetchImpl(somafmUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${somafmUrl} answered ${res.status}`);
    somafm = parseChannels(JSON.parse(await res.text())).map(validateStation);
    if (!somafm.length) throw new Error(`${somafmUrl}: no channels in the response`);
  } catch (err) {
    if (await exists(file)) {
      log(`refresh: SomaFM failed, keeping ${file}: ${err.message}`);
    } else {
      await writeJson(file, { fetchedAt: Date.now(), stations: local });
      log(`refresh: SomaFM failed, wrote local stations only to ${file}: ${err.message}`);
    }
    throw err;
  }

  const seen = new Set(local.map((s) => s.id));
  const stations = [...local, ...somafm.filter((s) => !seen.has(s.id))];
  await writeJson(file, { fetchedAt: Date.now(), stations });
  log(`refresh: ${local.length} local + ${somafm.length} SomaFM stations -> ${file}`);
  return { local: local.length, somafm: somafm.length };
}
