import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../lib/app.js';

// Metal Only style station: one PLS on a redirector host, the real server lives on real.example
// and publishes Icecast status JSON with more mounts.
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
// SomaFM style station: several PLS files, each with the same hosts, now-playing from a songs feed.
const GS_MP3 = '[playlist]\nFile1=https://ice2.example/gs-256-mp3\nFile2=https://ice6.example/gs-256-mp3\n';
const GS_AAC = '[playlist]\nFile1=https://ice2.example/gs-128-aac\nFile2=https://ice6.example/gs-128-aac\n';
const GS_LOW = '[playlist]\nFile1=https://ice2.example/gs-64-aac\n';
const SONGS = { id: 'gs', songs: [{ title: 'Egotron', artist: 'Sine', album: 'Spring', date: '1788896620' }, { title: 'Wonder', artist: 'Potlatch', album: '', date: '1788896304' }] };

const STATIONS = {
  fetchedAt: 42,
  stations: [
    {
      id: 'metal-only', name: 'Metal Only', description: 'Metal', genre: 'metal', dj: '', site: 'https://www.metal-only.de', logo: '/icon-256.png', source: 'local',
      playlists: [{ url: 'http://station.example/listen.pls', format: 'mp3', quality: 'highest' }],
      nowPlaying: { kind: 'icecast' },
    },
    {
      id: 'gs', name: 'Groove Salad', description: 'Chilled', genre: 'ambient|electronic', dj: 'Rusty', site: 'https://somafm.com/gs/', logo: 'https://l.example/gs.png', source: 'somafm',
      playlists: [
        { url: 'https://api.example/gs256.pls', format: 'mp3', quality: 'highest' },
        { url: 'https://api.example/gs130.pls', format: 'aac', quality: 'highest' },
        { url: 'https://api.example/gs64.pls', format: 'aacp', quality: 'high' },
        { url: 'https://api.example/gs-broken.pls', format: 'aacp', quality: 'low' },
      ],
      nowPlaying: { kind: 'somafm', url: 'https://songs.example/gs.json' },
    },
  ],
};

// Map of url -> string | object | { redirectTo, headers } for HEAD probes.
function fakeFetch(map, calls = []) {
  return async (url, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + url);
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

const NET = {
  'http://station.example/listen.pls': PLS,
  'https://edge.example/stream': { redirectTo: 'https://real.example/stream?time=1', headers: { 'icy-br': '192', 'content-type': 'audio/mpeg' } },
  'https://real.example/status-json.xsl': STATUS,
  'https://api.example/gs256.pls': GS_MP3,
  'https://api.example/gs130.pls': GS_AAC,
  'https://api.example/gs64.pls': GS_LOW,
  'https://ice2.example/gs-256-mp3': { headers: { 'icy-br': '256', 'content-type': 'audio/mpeg' } },
  'https://ice2.example/gs-128-aac': { headers: { 'icy-br': '128', 'content-type': 'audio/aac' } },
  'https://ice2.example/gs-64-aac': { headers: { 'icy-br': '64', 'content-type': 'audio/aacp' } },
  'https://songs.example/gs.json': SONGS,
};

function stationsFile(data = STATIONS) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webmusicmo-')), 'stations.json');
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

async function withServer(opts, fn) {
  const app = createApp({ stationsFile: stationsFile(), cacheMs: 0, ...opts });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const baseOpts = { fetchImpl: fakeFetch(NET) };

test('GET / serves the player page', async () => {
  await withServer(baseOpts, async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<title>/);
  });
});

test('GET /api/stations lists stations without playlists', async () => {
  await withServer(baseOpts, async (base) => {
    const body = await (await fetch(base + '/api/stations')).json();
    assert.equal(body.fetchedAt, 42);
    assert.deepEqual(body.stations[1], {
      id: 'gs', name: 'Groove Salad', description: 'Chilled', genre: 'ambient|electronic', dj: 'Rusty', site: 'https://somafm.com/gs/', logo: 'https://l.example/gs.png', source: 'somafm',
    });
    assert.equal(body.stations[0].id, 'metal-only');
    assert.equal('playlists' in body.stations[0], false);
  });
});

test('GET /api/stations answers 503 when the file is missing', async () => {
  await withServer({ ...baseOpts, stationsFile: '/nonexistent/stations.json' }, async (base) => {
    const res = await fetch(base + '/api/stations');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /ENOENT/);
  });
});

test('GET /api/streams (default station) resolves the redirect, merges status mounts, https first', async () => {
  await withServer(baseOpts, async (base) => {
    const res = await fetch(base + '/api/streams');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.station, 'Metal Only');
    assert.equal(body.stationUrl, 'https://www.metal-only.de');
    assert.equal(body.plsUrl, 'http://station.example/listen.pls');
    assert.deepEqual(body.streams, [
      { url: 'https://real.example/stream', mount: 'stream', bitrate: 192, type: 'audio/mpeg', primary: true, format: 'mp3' },
      { url: 'https://real.example/stream320', mount: 'stream320', bitrate: 320, type: 'audio/aac', primary: false, format: '' },
      { url: 'https://real.example/stream64', mount: 'stream64', bitrate: 64, type: 'audio/aac', primary: false, format: '' },
    ]);
    // IP literal hosts stay on http: an https certificate will not match an IP.
    assert.deepEqual(body.fallbacks, ['http://10.0.0.1/stream']);
  });
});

test('GET /api/streams?station=gs reads every playlist and skips a broken one', async () => {
  await withServer(baseOpts, async (base) => {
    const body = await (await fetch(base + '/api/streams?station=gs')).json();
    assert.equal(body.station, 'Groove Salad');
    assert.equal(body.plsUrl, 'https://api.example/gs256.pls');
    assert.deepEqual(body.streams, [
      { url: 'https://ice2.example/gs-256-mp3', mount: 'gs-256-mp3', bitrate: 256, type: 'audio/mpeg', primary: true, format: 'mp3' },
      { url: 'https://ice2.example/gs-128-aac', mount: 'gs-128-aac', bitrate: 128, type: 'audio/aac', primary: false, format: 'aac' },
      { url: 'https://ice2.example/gs-64-aac', mount: 'gs-64-aac', bitrate: 64, type: 'audio/aacp', primary: false, format: 'aacp' },
    ]);
    assert.deepEqual(body.fallbacks, ['https://ice6.example/gs-256-mp3']);
  });
});

test('GET /api/streams still works when the status page is down', async () => {
  const opts = {
    fetchImpl: fakeFetch({
      'http://station.example/listen.pls': PLS,
      'https://edge.example/stream': { headers: { 'icy-br': '128', 'content-type': 'audio/mpeg' } },
    }),
  };
  await withServer(opts, async (base) => {
    const body = await (await fetch(base + '/api/streams')).json();
    assert.deepEqual(body.streams, [
      { url: 'https://edge.example/stream', mount: 'stream', bitrate: 128, type: 'audio/mpeg', primary: true, format: 'mp3' },
    ]);
  });
});

test('GET /api/streams answers 502 when no playlist can be read and 404 for an unknown station', async () => {
  await withServer({ fetchImpl: fakeFetch({}) }, async (base) => {
    const res = await fetch(base + '/api/streams?station=gs');
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /playlist/);
  });
  await withServer(baseOpts, async (base) => {
    const res = await fetch(base + '/api/streams?station=nope');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'unknown station' });
    assert.equal((await fetch(base + '/api/now?station=nope')).status, 404);
  });
});

test('GET /api/now returns the parsed current track from Icecast status', async () => {
  await withServer(baseOpts, async (base) => {
    const body = await (await fetch(base + '/api/now?station=metal-only')).json();
    assert.equal(body.artist, 'A');
    assert.equal(body.song, 'B');
    assert.equal(body.dj, 'DJ');
    assert.equal(body.listeners, 7);
    assert.deepEqual(body.history, []);
    assert.equal(typeof body.fetchedAt, 'number');
  });
});

test('GET /api/now for a SomaFM station reads the songs feed with history', async () => {
  await withServer(baseOpts, async (base) => {
    const body = await (await fetch(base + '/api/now?station=gs')).json();
    assert.equal(body.artist, 'Sine');
    assert.equal(body.song, 'Egotron');
    assert.equal(body.album, 'Spring');
    assert.equal(body.listeners, null);
    assert.deepEqual(body.history, [
      { artist: 'Sine', song: 'Egotron', album: 'Spring', at: 1788896620000 },
      { artist: 'Potlatch', song: 'Wonder', album: '', at: 1788896304000 },
    ]);
  });
});

test('caches are per station', async () => {
  const calls = [];
  await withServer({ fetchImpl: fakeFetch(NET, calls), cacheMs: 60_000 }, async (base) => {
    await fetch(base + '/api/now?station=gs');
    await fetch(base + '/api/now?station=metal-only');
    await fetch(base + '/api/now?station=gs');
    await fetch(base + '/api/now?station=metal-only');
    assert.equal(calls.filter((c) => c.endsWith('gs.json')).length, 1);
    assert.equal(calls.filter((c) => c.endsWith('status-json.xsl')).length, 1);
  });
});

test('GET /api/now reports 502 when the station is unreachable', async () => {
  const opts = { fetchImpl: async () => { throw new Error('down'); } };
  await withServer(opts, async (base) => {
    const res = await fetch(base + '/api/now');
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /down/);
  });
});

test('static handler refuses path traversal, unknown files and bad escapes', async () => {
  await withServer(baseOpts, async (base) => {
    assert.equal((await fetch(base + '/../package.json')).status, 404);
    assert.equal((await fetch(base + '/nothing-here.js')).status, 404);
    assert.equal((await fetch(base + '/%')).status, 400);
    assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
    // The server must still be alive afterwards.
    assert.equal((await fetch(base + '/api/health')).status, 200);
  });
});
