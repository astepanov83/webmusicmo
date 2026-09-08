// The station list: reads public/stations.json, checks the entries, re-reads when the
// refresh script rewrites the file, and never drops good data because of a bad rewrite.

import fs from 'node:fs/promises';

export const NOW_PLAYING_KINDS = ['icecast', 'somafm'];
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

const str = (v) => (v == null ? '' : String(v));

export function validateStation(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('station must be an object');
  const id = str(raw.id);
  if (!ID_RE.test(id)) throw new Error(`station id "${id}" is not url-safe`);
  const name = str(raw.name).trim();
  if (!name) throw new Error(`station ${id}: name is required`);
  if (!Array.isArray(raw.playlists) || !raw.playlists.length) throw new Error(`station ${id}: playlists must be a non-empty array`);
  const playlists = raw.playlists.map((p) => {
    if (!p || !str(p.url)) throw new Error(`station ${id}: playlists entries need a url`);
    return { url: str(p.url), format: str(p.format), quality: str(p.quality) };
  });
  const np = raw.nowPlaying || {};
  if (!NOW_PLAYING_KINDS.includes(np.kind)) throw new Error(`station ${id}: nowPlaying.kind must be one of ${NOW_PLAYING_KINDS.join(', ')}`);
  if (np.kind === 'somafm' && !str(np.url)) throw new Error(`station ${id}: nowPlaying.url is required for kind somafm`);
  return {
    id,
    name,
    description: str(raw.description),
    genre: str(raw.genre),
    dj: str(raw.dj),
    site: str(raw.site),
    logo: str(raw.logo),
    source: str(raw.source) || 'local',
    playlists,
    nowPlaying: { kind: np.kind, url: str(np.url) },
  };
}

export function createStationStore({ file, checkMs = 60_000, now = Date.now, log = () => {} } = {}) {
  if (!file) throw new Error('file is required');
  let data = null;
  let mtimeMs = -1;
  let lastCheck = -Infinity;

  async function load(force = false) {
    if (!force && data && now() - lastCheck < checkMs) return data;
    lastCheck = now();
    try {
      const st = await fs.stat(file);
      if (data && st.mtimeMs === mtimeMs) return data;
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      const stations = (Array.isArray(parsed.stations) ? parsed.stations : []).map(validateStation);
      if (!stations.length) throw new Error(`${file}: no stations`);
      data = { fetchedAt: Number(parsed.fetchedAt) || 0, stations };
      mtimeMs = st.mtimeMs;
    } catch (err) {
      if (!data) throw err;
      log(`stations: keeping the last good list, ${err.message}`);
    }
    return data;
  }

  return {
    load,
    list: () => load(),
    async get(id) {
      const d = await load();
      if (!id) return d.stations[0];
      return d.stations.find((s) => s.id === id) || null;
    },
  };
}
