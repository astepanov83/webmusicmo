// HTTP request handler: static player files plus two small JSON endpoints.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePls } from './pls.js';
import { parseStatus } from './nowplaying.js';

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

export function createApp({ plsUrl, fetchImpl = fetch, cacheMs = 5000, preferHttps = true } = {}) {
  if (!plsUrl) throw new Error('plsUrl is required');
  const fix = preferHttps ? toHttps : (u) => u;

  // Small in-memory caches so many open tabs do not hammer the station.
  const cache = new Map();
  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function getText(url) {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'webmusicmo/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.text();
  }

  async function loadPls() {
    return cached('pls', Math.max(cacheMs, 60_000), async () => {
      const entries = parsePls(await getText(plsUrl));
      if (!entries.length) throw new Error('PLS file has no entries');
      return entries;
    });
  }

  // Follow the primary PLS entry to the real stream server and read its ICY headers.
  async function resolvePrimary() {
    const entries = await loadPls();
    const primary = entries[0];
    return cached('primary', Math.max(cacheMs, 60_000), async () => {
      const url = fix(primary.url);
      try {
        const res = await fetchImpl(url, {
          method: 'HEAD',
          redirect: 'follow',
          headers: { 'user-agent': 'webmusicmo/1.0' },
          signal: AbortSignal.timeout(6000),
        });
        const br = Number(res.headers.get('icy-br'));
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        const finalUrl = stripQuery(res.ok && res.url ? res.url : url);
        return { url: finalUrl, mount: mountOf(finalUrl), bitrate: br > 0 ? br : null, type: /^audio\//.test(type) ? type : '', primary: true };
      } catch {
        return { url, mount: mountOf(url), bitrate: null, type: '', primary: true };
      }
    });
  }

  async function loadStatus() {
    const primary = await resolvePrimary();
    return cached('status', cacheMs, async () => {
      const text = await getText(statusUrlFor(primary.url));
      return { ...parseStatus(JSON.parse(text)), fetchedAt: Date.now() };
    });
  }

  async function apiStreams() {
    const entries = await loadPls();
    const primary = await resolvePrimary();
    const streams = [primary];
    let status = null;
    try {
      status = await loadStatus();
    } catch {
      // Fine: we still have the PLS entry.
    }
    if (status) {
      const origin = new URL(primary.url);
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
        if (streams.some((x) => x.bitrate === s.bitrate && x.type === s.type)) continue;
        streams.push({ url, mount: s.mount, bitrate: s.bitrate, type: s.type, primary: false });
      }
    }
    return {
      station: entries[0].title || (status && status.description) || 'Stream',
      description: status ? status.description : '',
      stationUrl: status ? status.stationUrl : '',
      plsUrl,
      streams,
      fallbacks: entries.slice(1).map((e) => fix(e.url)),
    };
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
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    if (pathname === '/api/now') {
      return loadStatus()
        .then((s) => json(res, 200, { ...s.now, listeners: s.listeners, fetchedAt: s.fetchedAt }))
        .catch((err) => json(res, 502, { error: String(err.message || err) }));
    }
    if (pathname === '/api/streams') {
      return apiStreams()
        .then((body) => json(res, 200, body))
        .catch((err) => json(res, 502, { error: String(err.message || err) }));
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
