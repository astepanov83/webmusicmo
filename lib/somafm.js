// Parsers for SomaFM's public JSON: channels.json (the station list) and songs/<id>.json
// (recent tracks). Pure functions, no network.

import { decodeEntities } from './nowplaying.js';

function stripQuery(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return String(url || '');
  }
}

export function parseChannels(json) {
  const list = json && Array.isArray(json.channels) ? json.channels : [];
  const out = [];
  for (const c of list) {
    if (!c || !c.id || !Array.isArray(c.playlists)) continue;
    const playlists = c.playlists
      .filter((p) => p && p.url)
      .map((p) => ({ url: String(p.url), format: String(p.format || ''), quality: String(p.quality || '') }));
    if (!playlists.length) continue;
    const id = String(c.id);
    out.push({
      id,
      name: String(c.title || id),
      description: String(c.description || ''),
      genre: String(c.genre || ''),
      dj: String(c.dj || ''),
      site: `https://somafm.com/${id}/`,
      logo: stripQuery(c.largeimage || c.image || ''),
      source: 'somafm',
      playlists,
      nowPlaying: { kind: 'somafm', url: `https://somafm.com/songs/${id}.json` },
    });
  }
  return out;
}

const EMPTY_NOW = { raw: '', artist: '', song: '', album: '', dj: '', show: '' };

export function parseSongs(json) {
  const songs = json && Array.isArray(json.songs) ? json.songs : [];
  const history = [];
  for (const s of songs) {
    if (!s) continue;
    const artist = decodeEntities(s.artist || '').trim();
    const song = decodeEntities(s.title || '').trim();
    if (!artist && !song) continue;
    const album = decodeEntities(s.album || '').trim();
    const at = Number(s.date) > 0 ? Number(s.date) * 1000 : 0;
    history.push({ artist, song, album, at });
  }
  const first = history[0];
  const now = first
    ? { raw: [first.artist, first.song].filter(Boolean).join(' - '), artist: first.artist, song: first.song, album: first.album, dj: '', show: '' }
    : { ...EMPTY_NOW };
  return { now, listeners: null, history };
}
