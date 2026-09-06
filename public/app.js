/* Metal Only web player. Plain browser JavaScript, no build step. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    player: $('player'), playBtn: $('playBtn'), statusDot: $('statusDot'), statusText: $('statusText'),
    stationName: $('stationName'), song: $('song'), artist: $('artist'), show: $('show'),
    muteBtn: $('muteBtn'), volume: $('volume'), quality: $('quality'), sleep: $('sleep'),
    elapsed: $('elapsed'), bitrate: $('bitrate'), listeners: $('listeners'), sleepLeft: $('sleepLeft'),
    historyList: $('historyList'), clearHistory: $('clearHistory'),
    stationLink: $('stationLink'), plsLink: $('plsLink'), copyUrl: $('copyUrl'),
    themeToggle: $('themeToggle'), vizToggle: $('vizToggle'), viz: $('viz'), toast: $('toast'),
  };

  // ---------- Persistent settings ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('webplayer:' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('webplayer:' + key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  const state = {
    streams: [],
    fallbacks: [],
    current: null,          // chosen stream object
    wanted: false,          // user wants audio playing
    retries: 0,
    retryTimer: null,
    startedAt: 0,
    now: null,              // last now-playing object
    history: store.get('history', []),
    sleepUntil: 0,
    sleepTimer: null,
  };

  // ---------- Theme ----------
  const THEMES = ['dark', 'light', 'system'];
  function applyTheme(theme) {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    el.themeToggle.title = `Theme: ${theme} (t)`;
    store.set('theme', theme);
  }
  function cycleTheme() {
    const cur = store.get('theme', 'dark');
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  }
  // ?theme=dark|light|system picks a theme once and remembers it.
  const urlTheme = new URLSearchParams(location.search).get('theme');
  applyTheme(THEMES.includes(urlTheme) ? urlTheme : store.get('theme', 'dark'));
  el.themeToggle.addEventListener('click', cycleTheme);

  // ---------- Audio ----------
  const audio = new Audio();
  audio.preload = 'none';
  audio.crossOrigin = 'anonymous';

  let audioCtx = null;
  let analyser = null;
  let vizOn = store.get('viz', true);
  el.vizToggle.setAttribute('aria-pressed', String(vizOn));

  function ensureAudioGraph() {
    if (audioCtx || !vizOn) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      const src = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      src.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch (err) {
      console.warn('visualizer unavailable', err);
      audioCtx = null; analyser = null;
    }
  }

  function setStatus(kind, text) {
    el.statusDot.className = 'station-dot' + (kind ? ' ' + kind : '');
    el.statusText.textContent = text;
    el.player.classList.toggle('busy', kind === 'busy');
  }

  function streamUrl(s) {
    // Cache-bust so a fresh connection always joins the live edge.
    const u = new URL(s.url);
    u.searchParams.set('_', Date.now().toString(36));
    return u.toString();
  }

  function play() {
    if (!state.current) return;
    state.wanted = true;
    clearTimeout(state.retryTimer);
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    setStatus('busy', 'Connecting');
    el.player.classList.add('playing');
    el.playBtn.setAttribute('aria-label', 'Stop');
    audio.src = streamUrl(state.current);
    audio.load();
    audio.play().catch((err) => {
      if (err && err.name === 'NotAllowedError') {
        state.wanted = false;
        stop('Tap play to start');
      } else {
        scheduleRetry(err);
      }
    });
    store.set('wasPlaying', true);
  }

  function stop(statusText = 'Stopped') {
    state.wanted = false;
    state.retries = 0;
    clearTimeout(state.retryTimer);
    audio.pause();
    audio.removeAttribute('src');
    audio.load(); // drop the connection so we stop downloading
    el.player.classList.remove('playing');
    el.playBtn.setAttribute('aria-label', 'Play');
    setStatus('', statusText);
    state.startedAt = 0;
    el.elapsed.textContent = '';
    store.set('wasPlaying', false);
    updateMediaSession();
  }

  function scheduleRetry(err) {
    if (!state.wanted) return;
    state.retries += 1;
    // After a few failures on the chosen stream, rotate through the fallback hosts.
    if (state.retries % 3 === 0 && state.fallbacks.length) {
      const next = state.fallbacks.shift();
      state.fallbacks.push(state.current.url);
      state.current = { ...state.current, url: next };
      toast('Switching to backup server');
    }
    const delay = Math.min(30000, 1000 * 2 ** Math.min(state.retries - 1, 5));
    setStatus('error', `Reconnecting in ${Math.round(delay / 1000)}s`);
    console.warn('stream problem, retrying', err);
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => state.wanted && play(), delay);
  }

  audio.addEventListener('playing', () => {
    state.retries = 0;
    if (!state.startedAt) state.startedAt = Date.now();
    setStatus('live', 'Live');
    updateMediaSession();
    drawViz();
  });
  audio.addEventListener('waiting', () => state.wanted && setStatus('busy', 'Buffering'));
  audio.addEventListener('stalled', () => state.wanted && setStatus('busy', 'Buffering'));
  audio.addEventListener('error', () => scheduleRetry(audio.error));
  audio.addEventListener('ended', () => scheduleRetry(new Error('stream ended')));
  // If the element sits in "waiting" for too long the connection is probably dead.
  let stallTimer = null;
  audio.addEventListener('waiting', () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => state.wanted && audio.readyState < 3 && scheduleRetry(new Error('stalled')), 15000);
  });
  audio.addEventListener('playing', () => clearTimeout(stallTimer));

  el.playBtn.addEventListener('click', () => (state.wanted ? stop() : play()));

  // ---------- Volume ----------
  function setVolume(v, { save = true } = {}) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    audio.volume = (v / 100) ** 2; // perceptual curve
    el.volume.value = v;
    el.volume.style.backgroundSize = `${v}% 100%`;
    if (save) store.set('volume', v);
  }
  function setMuted(m) {
    audio.muted = m;
    el.muteBtn.setAttribute('aria-pressed', String(m));
    store.set('muted', m);
  }
  setVolume(store.get('volume', 80));
  setMuted(store.get('muted', false));
  el.volume.addEventListener('input', () => { setVolume(Number(el.volume.value)); if (audio.muted) setMuted(false); });
  el.muteBtn.addEventListener('click', () => setMuted(!audio.muted));

  // ---------- Streams / quality ----------
  function label(s) {
    const codec = /aac/i.test(s.type) ? 'AAC' : /mpeg|mp3/i.test(s.type) ? 'MP3' : '';
    const kbps = s.bitrate ? `${s.bitrate} kbps` : s.mount || 'stream';
    return [kbps, codec].filter(Boolean).join(' ');
  }

  async function loadStreams() {
    const res = await fetch('/api/streams', { cache: 'no-store' });
    if (!res.ok) throw new Error('streams ' + res.status);
    const data = await res.json();
    state.streams = data.streams;
    state.fallbacks = data.fallbacks || [];
    el.stationName.textContent = (data.station || 'Stream').split(' - ')[0];
    document.title = el.stationName.textContent;
    if (data.stationUrl) el.stationLink.href = data.stationUrl;
    el.stationLink.textContent = (data.stationUrl || el.stationLink.href).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    el.plsLink.href = data.plsUrl;

    el.quality.innerHTML = '';
    const sorted = [...state.streams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    for (const s of sorted) {
      const opt = document.createElement('option');
      opt.value = s.mount;
      opt.textContent = label(s) + (s.primary ? ' · default' : '');
      el.quality.appendChild(opt);
    }
    const savedMount = store.get('mount', null);
    state.current = state.streams.find((s) => s.mount === savedMount) || state.streams.find((s) => s.primary) || state.streams[0];
    el.quality.value = state.current.mount;
    el.bitrate.textContent = label(state.current);
  }

  el.quality.addEventListener('change', () => {
    const s = state.streams.find((x) => x.mount === el.quality.value);
    if (!s) return;
    state.current = s;
    store.set('mount', s.mount);
    el.bitrate.textContent = label(s);
    if (state.wanted) play();
  });

  // ---------- Now playing ----------
  let nowTimer = null;
  async function pollNow() {
    clearTimeout(nowTimer);
    try {
      const res = await fetch('/api/now', { cache: 'no-store' });
      if (!res.ok) throw new Error('now ' + res.status);
      applyNow(await res.json());
    } catch (err) {
      console.warn('now-playing unavailable', err);
    }
    const interval = document.hidden ? 60000 : state.wanted ? 10000 : 30000;
    nowTimer = setTimeout(pollNow, interval);
  }

  function applyNow(now) {
    const changed = !state.now || state.now.raw !== now.raw;
    state.now = now;
    el.song.textContent = now.song || now.raw || (state.wanted ? 'Live' : 'Press play');
    el.artist.innerHTML = now.artist ? '' : '&nbsp;';
    if (now.artist) el.artist.textContent = now.artist;
    el.show.innerHTML = '';
    if (now.dj) {
      const b = document.createElement('b');
      b.textContent = now.dj;
      el.show.append(b, document.createTextNode(' on air'));
    }
    if (now.show) el.show.append(document.createTextNode((now.dj ? ' · ' : '') + now.show));
    el.listeners.textContent = now.listeners != null ? `${now.listeners} listening` : '';
    if (changed) {
      if (now.song) addHistory(now);
      updateMediaSession();
    }
    document.title = (now.song ? `${now.artist ? now.artist + ' - ' : ''}${now.song} · ` : '') + el.stationName.textContent;
  }

  function addHistory(now) {
    const last = state.history[0];
    if (last && last.raw === now.raw) return;
    state.history.unshift({ raw: now.raw, artist: now.artist, song: now.song, at: Date.now() });
    state.history = state.history.slice(0, 50);
    store.set('history', state.history);
    renderHistory();
  }

  function renderHistory() {
    el.historyList.innerHTML = '';
    const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
    for (const h of state.history) {
      const li = document.createElement('li');
      const t = document.createElement('time');
      t.textContent = fmt.format(new Date(h.at));
      t.dateTime = new Date(h.at).toISOString();
      const song = document.createElement('span');
      song.className = 'h-song';
      song.textContent = h.song;
      li.append(t, song);
      if (h.artist) {
        const a = document.createElement('span');
        a.className = 'h-artist';
        a.textContent = h.artist;
        li.append(a);
      }
      el.historyList.appendChild(li);
    }
  }
  el.clearHistory.addEventListener('click', () => {
    state.history = [];
    store.set('history', []);
    renderHistory();
  });
  renderHistory();

  // ---------- Media Session (OS media keys, lock screen) ----------
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const now = state.now || {};
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: now.song || el.stationName.textContent,
        artist: now.artist || (now.dj ? `${now.dj} on air` : ''),
        album: el.stationName.textContent,
        artwork: [{ src: location.origin + '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      });
      navigator.mediaSession.playbackState = state.wanted ? 'playing' : 'paused';
    } catch { /* ignore */ }
  }
  if ('mediaSession' in navigator) {
    for (const action of ['play']) navigator.mediaSession.setActionHandler(action, () => play());
    for (const action of ['pause', 'stop']) {
      try { navigator.mediaSession.setActionHandler(action, () => stop()); } catch { /* unsupported */ }
    }
  }

  // ---------- Sleep timer ----------
  function setSleep(minutes) {
    clearTimeout(state.sleepTimer);
    state.sleepUntil = minutes > 0 ? Date.now() + minutes * 60000 : 0;
    if (minutes > 0) {
      state.sleepTimer = setTimeout(fadeOutAndStop, minutes * 60000);
      toast(`Sleeping in ${minutes} min`);
    }
    tick();
  }
  function fadeOutAndStop() {
    const saved = Number(el.volume.value);
    let v = saved;
    const step = setInterval(() => {
      v -= Math.max(1, saved / 20);
      if (v <= 0 || !state.wanted) {
        clearInterval(step);
        stop('Sleep timer');
        setVolume(saved);
      } else {
        setVolume(v, { save: false });
      }
    }, 500);
    state.sleepUntil = 0;
    el.sleep.value = '0';
  }
  el.sleep.addEventListener('change', () => setSleep(Number(el.sleep.value)));

  // ---------- Small periodic UI updates ----------
  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }
  function tick() {
    el.elapsed.textContent = state.startedAt && state.wanted ? 'Listening ' + fmtDuration(Date.now() - state.startedAt) : '';
    el.sleepLeft.textContent = state.sleepUntil ? 'Sleep in ' + fmtDuration(Math.max(0, state.sleepUntil - Date.now())) : '';
  }
  setInterval(tick, 1000);

  // ---------- Visualizer ----------
  const ctx2d = el.viz.getContext('2d');
  let vizFrame = null;
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = el.viz.getBoundingClientRect();
    el.viz.width = Math.round(r.width * dpr);
    el.viz.height = Math.round(r.height * dpr);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function drawViz() {
    cancelAnimationFrame(vizFrame);
    if (!analyser || !vizOn) { clearViz(); return; }
    const data = new Uint8Array(analyser.frequencyBinCount);
    const css = () => getComputedStyle(document.documentElement);
    const frame = () => {
      if (!state.wanted || !vizOn) { clearViz(); return; }
      vizFrame = requestAnimationFrame(frame);
      analyser.getByteFrequencyData(data);
      const W = el.viz.width, H = el.viz.height;
      ctx2d.clearRect(0, 0, W, H);
      const bars = 48;
      const gap = W * 0.006;
      const bw = (W - gap * (bars - 1)) / bars;
      const c1 = css().getPropertyValue('--viz').trim();
      const c2 = css().getPropertyValue('--viz-2').trim();
      // Use the lower two thirds of the spectrum; the top is mostly empty for music.
      const usable = Math.floor(data.length * 0.66);
      for (let i = 0; i < bars; i++) {
        const idx = Math.floor((i / bars) ** 1.6 * usable);
        const v = data[idx] / 255;
        const h = Math.max(2, v * H * 0.9);
        const x = i * (bw + gap);
        const grad = ctx2d.createLinearGradient(0, H - h, 0, H);
        grad.addColorStop(0, c1);
        grad.addColorStop(1, c2);
        ctx2d.fillStyle = grad;
        ctx2d.globalAlpha = 0.35 + v * 0.6;
        ctx2d.fillRect(x, H - h, bw, h);
      }
      ctx2d.globalAlpha = 1;
    };
    frame();
  }
  function clearViz() { ctx2d.clearRect(0, 0, el.viz.width, el.viz.height); }

  el.vizToggle.addEventListener('click', () => {
    vizOn = !vizOn;
    store.set('viz', vizOn);
    el.vizToggle.setAttribute('aria-pressed', String(vizOn));
    if (vizOn && state.wanted) { ensureAudioGraph(); drawViz(); } else clearViz();
  });

  // ---------- Misc ----------
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  el.copyUrl.addEventListener('click', async () => {
    if (!state.current) return;
    try {
      await navigator.clipboard.writeText(state.current.url);
      toast('Stream URL copied');
    } catch {
      toast(state.current.url);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); state.wanted ? stop() : play(); break;
      case 'm': setMuted(!audio.muted); break;
      case 'ArrowUp': e.preventDefault(); setVolume(Number(el.volume.value) + 5); break;
      case 'ArrowDown': e.preventDefault(); setVolume(Number(el.volume.value) - 5); break;
      case 't': cycleTheme(); break;
      case 'v': el.vizToggle.click(); break;
      default: return;
    }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNow(); });

  // ---------- Boot ----------
  (async () => {
    try {
      await loadStreams();
    } catch (err) {
      setStatus('error', 'Server unreachable');
      el.song.textContent = 'Could not load the stream list';
      console.error(err);
      return;
    }
    pollNow();
    if (store.get('wasPlaying', false)) play(); // may be blocked by autoplay rules; then we show "Tap play"
  })();
})();
