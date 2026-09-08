import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshStations } from '../lib/refresh.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS = fs.readFileSync(path.join(here, 'fixture-channels.json'), 'utf8');
const LOCAL = path.join(here, '..', 'stations', 'local.json');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webmusicmo-')), 'stations.json');
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function fakeFetch(body, status = 200) {
  return async () => ({ ok: status === 200, status, text: async () => body });
}

test('writes local stations first, then SomaFM', async () => {
  const file = tmpFile();
  const r = await refreshStations({ file, localFile: LOCAL, somafmUrl: 'http://s.example/channels.json', fetchImpl: fakeFetch(CHANNELS) });
  assert.deepEqual(r, { local: 1, somafm: 2 });
  const saved = readJson(file);
  assert.ok(saved.fetchedAt > 0);
  assert.deepEqual(saved.stations.map((s) => s.id), ['metal-only', '7soul', 'groovesalad']);
  assert.equal(saved.stations[0].nowPlaying.kind, 'icecast');
});

test('keeps the old file when SomaFM fails', async () => {
  const file = tmpFile();
  await refreshStations({ file, localFile: LOCAL, somafmUrl: 'http://s.example/c', fetchImpl: fakeFetch(CHANNELS) });
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(
    () => refreshStations({ file, localFile: LOCAL, somafmUrl: 'http://s.example/c', fetchImpl: fakeFetch('down', 503) }),
    /503/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await assert.rejects(
    () => refreshStations({ file, localFile: LOCAL, somafmUrl: 'http://s.example/c', fetchImpl: fakeFetch('{"channels":[]}') }),
    /no channels/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('with no previous file it writes the local stations and still fails', async () => {
  const file = tmpFile();
  await assert.rejects(
    () => refreshStations({ file, localFile: LOCAL, somafmUrl: 'http://s.example/c', fetchImpl: async () => { throw new Error('offline'); } }),
    /offline/,
  );
  assert.deepEqual(readJson(file).stations.map((s) => s.id), ['metal-only']);
});
