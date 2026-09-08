import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStationStore, validateStation } from '../lib/stations.js';

const good = {
  id: 'one',
  name: 'One',
  playlists: [{ url: 'http://x/one.pls', format: 'mp3', quality: 'highest' }],
  nowPlaying: { kind: 'icecast' },
};

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webmusicmo-'));
  const file = path.join(dir, 'stations.json');
  if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test('validateStation fills in display fields and keeps the rest', () => {
  const s = validateStation(good);
  assert.deepEqual(s, {
    id: 'one', name: 'One', description: '', genre: '', dj: '', site: '', logo: '', source: 'local',
    playlists: [{ url: 'http://x/one.pls', format: 'mp3', quality: 'highest' }],
    nowPlaying: { kind: 'icecast', url: '' },
  });
});

test('validateStation rejects bad entries with a reason', () => {
  assert.throws(() => validateStation({ ...good, id: 'has space' }), /id/);
  assert.throws(() => validateStation({ ...good, name: '' }), /name/);
  assert.throws(() => validateStation({ ...good, playlists: [] }), /playlists/);
  assert.throws(() => validateStation({ ...good, playlists: [{ format: 'mp3' }] }), /playlists/);
  assert.throws(() => validateStation({ ...good, nowPlaying: { kind: 'magic' } }), /nowPlaying/);
  assert.throws(() => validateStation({ ...good, nowPlaying: { kind: 'somafm' } }), /nowPlaying.url/);
});

test('store lists stations and picks by id, first station by default', async () => {
  const file = tmpFile({ fetchedAt: 5, stations: [good, { ...good, id: 'two', name: 'Two' }] });
  const store = createStationStore({ file });
  const list = await store.list();
  assert.equal(list.fetchedAt, 5);
  assert.deepEqual(list.stations.map((s) => s.id), ['one', 'two']);
  assert.equal((await store.get()).id, 'one');
  assert.equal((await store.get('two')).name, 'Two');
  assert.equal(await store.get('nope'), null);
});

test('store re-reads the file when its mtime changes, at most once per checkMs', async () => {
  let t = 1_000_000;
  const file = tmpFile({ stations: [good] });
  const store = createStationStore({ file, checkMs: 1000, now: () => t });
  assert.equal((await store.list()).stations.length, 1);

  fs.writeFileSync(file, JSON.stringify({ stations: [good, { ...good, id: 'two' }] }));
  const later = new Date(t + 5000);
  fs.utimesSync(file, later, later);
  // Inside the check window: still the old data.
  assert.equal((await store.list()).stations.length, 1);
  t += 2000;
  assert.equal((await store.list()).stations.length, 2);
});

test('store keeps the last good data when the file turns bad, and throws when it never had any', async () => {
  const file = tmpFile({ stations: [good] });
  let t = 0;
  const store = createStationStore({ file, checkMs: 0, now: () => t });
  await store.list();
  fs.writeFileSync(file, '{not json');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  t += 1;
  assert.equal((await store.list()).stations.length, 1);

  const missing = createStationStore({ file: tmpFile(), checkMs: 0 });
  await assert.rejects(() => missing.list(), /ENOENT/);
  const empty = createStationStore({ file: tmpFile({ stations: [] }), checkMs: 0 });
  await assert.rejects(() => empty.list(), /no stations/);
});
