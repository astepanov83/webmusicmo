// Turn the station's Icecast-style status JSON into a small, tidy object.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, k) => ENTITIES[k]);
}

// Titles look like: "Artist - Song * DJ OnAir * Show name * "
// Sometimes only "Artist - Song". Sometimes no dash at all.
export function parseTitle(raw) {
  const text = decodeEntities(raw || '').trim();
  const parts = text.split('*').map((p) => p.trim()).filter(Boolean);
  const track = parts[0] || '';
  let dj = '';
  let show = '';
  for (const part of parts.slice(1)) {
    const onAir = /^(.*?)\s+OnAir$/i.exec(part);
    if (onAir && !dj) dj = onAir[1].trim();
    else if (!show) show = part;
  }
  let artist = '';
  let song = track;
  const dash = track.indexOf(' - ');
  if (dash > 0) {
    artist = track.slice(0, dash).trim();
    song = track.slice(dash + 3).trim();
  }
  return { raw: text, artist, song, dj, show };
}

// Different servers spell the bitrate differently: "bitrate", "ice-bitrate" or "audio_info=bitrate=192".
function bitrateOf(s) {
  for (const v of [s.bitrate, s['ice-bitrate']]) {
    const n = Number(v);
    if (v !== undefined && v !== '' && Number.isFinite(n) && n > 0) return n;
  }
  const m = /bitrate=(\d+)/.exec(String(s.audio_info || ''));
  return m ? Number(m[1]) : null;
}

function mountOf(url) {
  try {
    return new URL(url).pathname.replace(/^\/+/, '');
  } catch {
    return String(url || '');
  }
}

export function parseStatus(json) {
  const src = json && json.icestats && json.icestats.source;
  const list = Array.isArray(src) ? src : src ? [src] : [];
  const streams = list
    .filter((s) => s && s.listenurl)
    .map((s) => ({
      url: s.listenurl,
      bitrate: bitrateOf(s),
      type: s.server_type || '',
      mount: mountOf(s.listenurl),
    }));
  const pick = (key) => (list.find((s) => s && s[key]) || {})[key] || '';
  const listeners = list.reduce((n, s) => n + (Number(s && s.listeners) || 0), 0);
  return {
    now: parseTitle(pick('title')),
    description: pick('server_description'),
    stationUrl: pick('server_url'),
    listeners: list.some((s) => s && s.listeners !== undefined) ? listeners : null,
    streams,
  };
}
