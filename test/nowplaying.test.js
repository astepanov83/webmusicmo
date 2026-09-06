import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle, parseStatus } from '../lib/nowplaying.js';

test('splits "artist - song * dj OnAir * show *" into parts', () => {
  const t = parseTitle('M-16 (USA) - Shot Down * Blacky OnAir * 60er Bis 95er Beat, Rock * ');
  assert.deepEqual(t, {
    raw: 'M-16 (USA) - Shot Down * Blacky OnAir * 60er Bis 95er Beat, Rock *',
    artist: 'M-16 (USA)',
    song: 'Shot Down',
    dj: 'Blacky',
    show: '60er Bis 95er Beat, Rock',
  });
});

test('handles a plain "artist - song" title', () => {
  const t = parseTitle('Iron Maiden - The Trooper');
  assert.equal(t.artist, 'Iron Maiden');
  assert.equal(t.song, 'The Trooper');
  assert.equal(t.dj, '');
  assert.equal(t.show, '');
});

test('keeps a title without a dash as the song', () => {
  const t = parseTitle('Station Jingle');
  assert.equal(t.artist, '');
  assert.equal(t.song, 'Station Jingle');
});

test('decodes html entities and handles empty input', () => {
  assert.equal(parseTitle('Foo &amp; Bar - Baz').artist, 'Foo & Bar');
  assert.equal(parseTitle('').song, '');
  assert.equal(parseTitle(undefined).song, '');
});

test('parseStatus pulls the track and the stream list from icestats', () => {
  const json = {
    icestats: {
      source: [
        { listenurl: 'http://h/autodj', bitrate: 192, server_type: 'audio/mpeg', title: 'A - B * DJ OnAir * Show * ' },
        { listenurl: 'http://h/stream320', bitrate: 320, server_type: 'audio/aac', title: 'A - B * DJ OnAir * Show * ' },
        { listenurl: 'http://h/stream64', bitrate: 64, server_type: 'audio/aac', title: 'A - B' },
      ],
    },
  };
  const s = parseStatus(json);
  assert.equal(s.now.artist, 'A');
  assert.equal(s.now.song, 'B');
  assert.equal(s.now.dj, 'DJ');
  assert.deepEqual(s.streams, [
    { url: 'http://h/autodj', bitrate: 192, type: 'audio/mpeg', mount: 'autodj' },
    { url: 'http://h/stream320', bitrate: 320, type: 'audio/aac', mount: 'stream320' },
    { url: 'http://h/stream64', bitrate: 64, type: 'audio/aac', mount: 'stream64' },
  ]);
});

test('parseStatus reads ice-bitrate and audio_info bitrates and sums listeners', () => {
  const s = parseStatus({ icestats: { source: [
    { listenurl: 'http://h/a', 'ice-bitrate': 192, listeners: 26, title: 'A - B' },
    { listenurl: 'http://h/b', audio_info: 'bitrate=320', listeners: 1, server_url: 'https://x/' },
    { listenurl: 'http://h/c', listeners: 3 },
  ] } });
  assert.deepEqual(s.streams.map((x) => x.bitrate), [192, 320, null]);
  assert.equal(s.listeners, 30);
  assert.equal(s.stationUrl, 'https://x/');
  assert.equal(s.now.song, 'B');
});

test('parseStatus accepts a single source object and missing fields', () => {
  const s = parseStatus({ icestats: { source: { listenurl: 'http://h/s', title: 'X - Y' } } });
  assert.equal(s.now.song, 'Y');
  assert.deepEqual(s.streams, [{ url: 'http://h/s', bitrate: null, type: '', mount: 's' }]);
  assert.deepEqual(parseStatus({}).streams, []);
  assert.equal(parseStatus({}).listeners, null);
  assert.equal(parseStatus(null).now.song, '');
});
