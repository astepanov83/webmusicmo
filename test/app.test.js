import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../lib/app.js';

// The PLS points at a redirector host; the real server lives on real.example.
const PLS = '[playlist]\nFile1=http://edge.example/stream\nTitle1=STATION\nFile2=http://10.0.0.1/stream\n';
const STATUS = {
  icestats: {
    source: [
      { listenurl: 'http://real.example/stream320', bitrate: 320, server_type: 'audio/aac', title: 'A - B * DJ OnAir * Show * ' },
      { listenurl: 'http://real.example/stream', bitrate: 192, server_type: 'audio/mpeg', title: 'A - B', listeners: 5 },
      { listenurl: 'http://real.example/autodj', bitrate: 192, server_type: 'audio/mpeg', title: 'A - B', listeners: 2 },
      { listenurl: 'http://real.example/stream64', bitrate: 64, server_type: 'audio/aac', title: 'A - B' },
    ],
  },
};

// Map of url -> string | object | { redirectTo, headers } for HEAD probes.
function fakeFetch(map) {
  return async (url, opts = {}) => {
    const hit = map[url];
    if (!hit) return { ok: false, status: 404, url, headers: new Headers(), text: async () => 'nope', json: async () => ({}) };
    if (opts.method === 'HEAD') {
      return { ok: true, status: 200, url: hit.redirectTo || url, headers: new Headers(hit.headers || {}) };
    }
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers(),
      text: async () => (typeof hit === 'string' ? hit : JSON.stringify(hit)),
      json: async () => (typeof hit === 'string' ? JSON.parse(hit) : hit),
    };
  };
}

async function withServer(opts, fn) {
  const app = createApp(opts);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const baseOpts = {
  plsUrl: 'http://station.example/listen.pls',
  fetchImpl: fakeFetch({
    'http://station.example/listen.pls': PLS,
    'https://edge.example/stream': { redirectTo: 'https://real.example/stream?time=1', headers: { 'icy-br': '192', 'content-type': 'audio/mpeg' } },
    'https://real.example/status-json.xsl': STATUS,
  }),
  cacheMs: 0,
};

test('GET / serves the player page', async () => {
  await withServer(baseOpts, async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<title>/);
  });
});

test('GET /api/streams resolves the redirect, merges status mounts, https first', async () => {
  await withServer(baseOpts, async (base) => {
    const res = await fetch(base + '/api/streams');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.station, 'STATION');
    assert.equal(body.plsUrl, 'http://station.example/listen.pls');
    assert.deepEqual(body.streams, [
      { url: 'https://real.example/stream', mount: 'stream', bitrate: 192, type: 'audio/mpeg', primary: true },
      { url: 'https://real.example/stream320', mount: 'stream320', bitrate: 320, type: 'audio/aac', primary: false },
      { url: 'https://real.example/stream64', mount: 'stream64', bitrate: 64, type: 'audio/aac', primary: false },
    ]);
    // IP literal hosts stay on http: an https certificate will not match an IP.
    assert.deepEqual(body.fallbacks, ['http://10.0.0.1/stream']);
  });
});

test('GET /api/streams still works when the status page is down', async () => {
  const opts = {
    ...baseOpts,
    fetchImpl: fakeFetch({
      'http://station.example/listen.pls': PLS,
      'https://edge.example/stream': { headers: { 'icy-br': '128', 'content-type': 'audio/mpeg' } },
    }),
  };
  await withServer(opts, async (base) => {
    const body = await (await fetch(base + '/api/streams')).json();
    assert.deepEqual(body.streams, [
      { url: 'https://edge.example/stream', mount: 'stream', bitrate: 128, type: 'audio/mpeg', primary: true },
    ]);
  });
});

test('GET /api/now returns the parsed current track', async () => {
  await withServer(baseOpts, async (base) => {
    const res = await fetch(base + '/api/now');
    const body = await res.json();
    assert.equal(body.artist, 'A');
    assert.equal(body.song, 'B');
    assert.equal(body.dj, 'DJ');
    assert.equal(body.listeners, 7);
    assert.equal(typeof body.fetchedAt, 'number');
  });
});

test('GET /api/now reports 502 when the station is unreachable', async () => {
  const opts = { ...baseOpts, fetchImpl: async () => { throw new Error('down'); } };
  await withServer(opts, async (base) => {
    const res = await fetch(base + '/api/now');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /down/);
  });
});

test('static handler refuses path traversal and unknown files', async () => {
  await withServer(baseOpts, async (base) => {
    assert.equal((await fetch(base + '/../package.json')).status, 404);
    assert.equal((await fetch(base + '/nothing-here.js')).status, 404);
  });
});
