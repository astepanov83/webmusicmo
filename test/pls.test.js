import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePls } from '../lib/pls.js';

const sample = `[playlist]
NumberOfEntries=3

File1=http://metalonly.sp.radio.fm/stream
Title1=METAL ONLY - https://www.metal-only.de
Length1=-1

File2=http://metalonly.spcast.eu/stream
Title2=METAL ONLY - https://www.metal-only.de
Length2=-1

File3=http://91.99.117.184/stream
Title3=METAL ONLY - https://www.metal-only.de
Length3=-1

Version=2
`;

test('parses every File/Title pair in order', () => {
  const entries = parsePls(sample);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    url: 'http://metalonly.sp.radio.fm/stream',
    title: 'METAL ONLY - https://www.metal-only.de',
  });
  assert.equal(entries[2].url, 'http://91.99.117.184/stream');
});

test('tolerates missing titles, CRLF line endings and odd spacing', () => {
  const text = '[playlist]\r\nFile1 = http://a/x\r\nFile2=http://b/y\r\nTitle2=B\r\n';
  assert.deepEqual(parsePls(text), [
    { url: 'http://a/x', title: '' },
    { url: 'http://b/y', title: 'B' },
  ]);
});

test('returns an empty list for garbage', () => {
  assert.deepEqual(parsePls(''), []);
  assert.deepEqual(parsePls('<html>nope</html>'), []);
});
