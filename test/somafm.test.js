import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChannels, parseSongs } from '../lib/somafm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));

test('parseChannels maps channels.json to stations and skips channels without playlists', () => {
  const stations = parseChannels(readJson('fixture-channels.json'));
  assert.deepEqual(stations.map((s) => s.id), ['7soul', 'groovesalad']);
  const gs = stations[1];
  assert.deepEqual(gs, {
    id: 'groovesalad',
    name: 'Groove Salad',
    description: 'A nicely chilled plate of ambient/downtempo beats and grooves.',
    genre: 'ambient|electronic',
    dj: 'Rusty Hodge',
    site: 'https://somafm.com/groovesalad/',
    logo: 'https://api.somafm.com/logos/256/groovesalad256.png',
    source: 'somafm',
    playlists: [
      { url: 'https://api.somafm.com/groovesalad256.pls', format: 'mp3', quality: 'highest' },
      { url: 'https://api.somafm.com/groovesalad130.pls', format: 'aac', quality: 'highest' },
      { url: 'https://api.somafm.com/groovesalad64.pls', format: 'aacp', quality: 'high' },
      { url: 'https://api.somafm.com/groovesalad32.pls', format: 'aacp', quality: 'low' },
    ],
    nowPlaying: { kind: 'somafm', url: 'https://somafm.com/songs/groovesalad.json' },
  });
});

test('parseChannels tolerates junk input', () => {
  assert.deepEqual(parseChannels(null), []);
  assert.deepEqual(parseChannels({}), []);
  assert.deepEqual(parseChannels({ channels: [null, { id: 'x' }] }), []);
});

test('parseSongs returns the newest track as now and the list as history', () => {
  const r = parseSongs(readJson('fixture-songs.json'));
  assert.deepEqual(r.now, { raw: "Nod Flenders - Vincent's Echo Ride", artist: 'Nod Flenders', song: "Vincent's Echo Ride", album: '[single]', dj: '', show: '' });
  assert.equal(r.listeners, null);
  // The empty fourth entry is dropped; the third has a title but no artist.
  assert.deepEqual(r.history, [
    { artist: 'Nod Flenders', song: "Vincent's Echo Ride", album: '[single]', at: 1788896940000 },
    { artist: 'Sine', song: 'Egotron', album: 'Spring Chill Vol. 3', at: 1788896620000 },
    { artist: '', song: 'Break', album: '', at: 1788896304000 },
  ]);
});

test('parseSongs with no songs gives an empty now', () => {
  const r = parseSongs({ id: 'x', songs: [] });
  assert.deepEqual(r.now, { raw: '', artist: '', song: '', album: '', dj: '', show: '' });
  assert.deepEqual(r.history, []);
  assert.deepEqual(parseSongs(null).history, []);
});
