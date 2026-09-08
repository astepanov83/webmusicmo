// HTTP request handler: static player files plus three small JSON endpoints.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePls } from './pls.js';
import { parseStatus } from './nowplaying.js';
import { createStationStore } from './stations.js';
import { parseSongs } from './somafm.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const IP_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

// Upgrade http to https, except for bare IP hosts where the certificate cannot match.
function toHttps(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' && !IP_HOST.test(u.hostname)) u.protocol = 'https:';
    return u.toString();
  } catch {
    return String(url);
  }
}

function stripQuery(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

function mountOf(url) {
  try {
    return new URL(url).pathname.replace(/^\/+/, '');
  } catch {
    return '';
  }
}

function statusUrlFor(streamUrl) {
  const u = new URL(streamUrl);
  return `${u.protocol}//${u.host}/status-json.xsl`;
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// Two mounts count as the same stream when they carry the same bitrate and codec.
// A mount we could not probe has no bitrate, so it never counts as a duplicate:
// dropping a real mount is worse than listing a redundant one.
function sameStreamListed(streams, bitrate, type) {
  return bitrate ? streams.some((x) => x.bitrate === bitrate && x.type === type) : false;
}

export function createApp({ stationsFile, fetchImpl = fetch, cacheMs = 5000, preferHttps = true, checkMs = 60_000 } = {}) {
  if (!stationsFile) throw new Error('stationsFile is required');
  const fix = preferHttps ? toHttps : (u) => u;
  const store = createStationStore({ file: stationsFile, checkMs, log: console.warn });
  const UA = { 'user-agent': 'webmusicmo/1.0' };

  // Small in-memory caches so many open tabs do not hammer the stations. Keys are "<station id>:<what>".
  const cache = new Map();
  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function getText(url) {
    const res = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.text();
  }

  async function loadPls(station, url) {
    return cached(`${station.id}:pls:${url}`, Math.max(cacheMs, 60_000), async () => {
      const entries = parsePls(await getText(url));
      if (!entries.length) throw new Error(`${url} has no entries`);
      return entries;
    });
  }

  // Follow a PLS entry to the real stream server and read its ICY headers.
  async function probe(rawUrl) {
    const url = fix(rawUrl);
    try {
      const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', headers: UA, signal: AbortSignal.timeout(6000) });
      const br = Number(res.headers.get('icy-br'));
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      const finalUrl = stripQuery(res.ok && res.url ? res.url : url);
      return { url: finalUrl, mount: mountOf(finalUrl), bitrate: br > 0 ? br : null, type: /^audio\//.test(type) ? type : '' };
    } catch {
      return { url, mount: mountOf(url), bitrate: null, type: '' };
    }
  }

  // One stream per playlist: the first entry of each PLS, probed. The first playlist is primary
  // and its other entries are the fallbacks.
  async function resolvePlaylists(station) {
    return cached(`${station.id}:streams`, Math.max(cacheMs, 60_000), async () => {
      const streams = [];
      let fallbacks = [];
      let plsUrl = '';
      let firstError = null;
      for (const p of station.playlists) {
        let entries;
        try {
          entries = await loadPls(station, p.url);
        } catch (err) {
          firstError = firstError || err;
          continue;
        }
        const probed = await probe(entries[0].url);
        // The first playlist that could be read is the primary one, and its other
        // entries are the backup servers for it.
        const primary = streams.length === 0;
        if (primary) {
          fallbacks = entries.slice(1).map((e) => fix(e.url));
          plsUrl = p.url;
        }
        const stream = { ...probed, primary, format: p.format };
        if (streams.some((x) => x.url === stream.url)) continue;
        if (sameStreamListed(streams, stream.bitrate, stream.type)) continue;
        streams.push(stream);
      }
      if (!streams.length) throw new Error(`no playlist could be read: ${firstError ? firstError.message : 'no playlists'}`);
      return { streams, fallbacks, plsUrl };
    });
  }

  async function primaryOf(station) {
    return (await resolvePlaylists(station)).streams[0];
  }

  // Now-playing, per station kind. Both readers return { now, listeners, history, description, stationUrl, streams }.
  async function loadStatus(station) {
    return cached(`${station.id}:status`, cacheMs, async () => {
      if (station.nowPlaying.kind === 'somafm') {
        const r = parseSongs(JSON.parse(await getText(station.nowPlaying.url)));
        return { ...r, description: '', stationUrl: '', streams: [], fetchedAt: Date.now() };
      }
      const primary = await primaryOf(station);
      const r = parseStatus(JSON.parse(await getText(statusUrlFor(primary.url))));
      return { ...r, now: { album: '', ...r.now }, history: [], fetchedAt: Date.now() };
    });
  }

  async function apiStreams(station) {
    const { streams: resolved, fallbacks, plsUrl } = await resolvePlaylists(station);
    const streams = resolved.map((s) => ({ ...s }));
    let status = null;
    if (station.nowPlaying.kind === 'icecast') {
      try {
        status = await loadStatus(station);
      } catch {
        // Fine: we still have the PLS entries.
      }
    }
    if (status) {
      const origin = new URL(streams[0].url);
      for (const s of status.streams) {
        // Put every mount on the resolved host so the browser talks to one origin.
        const u = new URL(fix(s.url));
        u.protocol = origin.protocol;
        u.host = origin.host;
        const url = u.toString();
        const existing = streams.find((x) => x.url === url);
        if (existing) {
          if (!existing.bitrate) existing.bitrate = s.bitrate;
          if (!existing.type) existing.type = s.type;
          continue;
        }
        // Skip mounts that are the same bitrate and codec as one we already have (e.g. "autodj").
        if (sameStreamListed(streams, s.bitrate, s.type)) continue;
        streams.push({ url, mount: s.mount, bitrate: s.bitrate, type: s.type, primary: false, format: '' });
      }
    }
    return {
      station: station.name,
      description: station.description || (status && status.description) || '',
      stationUrl: station.site || (status && status.stationUrl) || '',
      plsUrl,
      streams,
      fallbacks,
    };
  }

  const publicFields = ({ id, name, description, genre, dj, site, logo, source }) => ({ id, name, description, genre, dj, site, logo, source });

  async function apiStations() {
    const { fetchedAt, stations } = await store.list();
    return { fetchedAt, stations: stations.map(publicFields) };
  }

  // Runs fn(station) for the station named in the query, or the first one. Maps errors to codes.
  function withStation(res, query, fn) {
    const id = query.get('station') || '';
    return store
      .get(id)
      .then((station) => {
        if (!station) return json(res, 404, { error: 'unknown station' });
        return fn(station)
          .then((body) => json(res, 200, body))
          .catch((err) => json(res, 502, { error: String(err.message || err) }));
      })
      .catch((err) => json(res, 503, { error: String(err.message || err) }));
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound(res);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': type,
        'content-length': st.size,
        'cache-control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  function notFound(res) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  return function handler(req, res) {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    if (pathname === '/api/stations') {
      return apiStations()
        .then((body) => json(res, 200, body))
        .catch((err) => json(res, 503, { error: String(err.message || err) }));
    }
    if (pathname === '/api/now') {
      return withStation(res, searchParams, (station) =>
        loadStatus(station).then((s) => ({ ...s.now, listeners: s.listeners, history: s.history, fetchedAt: s.fetchedAt })));
    }
    if (pathname === '/api/streams') {
      return withStation(res, searchParams, apiStreams);
    }
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, uptime: process.uptime() });
    }
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Bad request');
    }
    return serveStatic(req, res, decoded);
  };
}
