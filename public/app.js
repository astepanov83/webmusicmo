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
    stationBtn: $('stationBtn'), stationsPanel: $('stationsPanel'), stationsClose: $('stationsClose'),
    stationFilter: $('stationFilter'), stationList: $('stationList'),
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

  // Version 1 kept one history and one quality. They belong to Metal Only now.
  // store.set() swallows every failure (quota, storage unavailable), so read the new key
  // back before deleting the old one: only drop the old key once the new value is
  // confirmed on disk, or a failed write plus the delete would just lose the data.
  function migrateKey(oldKey, newKey) {
    if (store.get(oldKey, null) === null) return;
    store.set(newKey, store.get(oldKey, null));
    const MISSING = {};
    if (store.get(newKey, MISSING) === MISSING) return;
    localStorage.removeItem('webplayer:' + oldKey);
  }
  migrateKey('history', 'history:metal-only');
  migrateKey('mount', 'mount:metal-only');

  const state = {
    stations: [],
    favourites: new Set(),  // station ids the user starred
    station: null,          // chosen station object
    applied: null,          // the station whose data is on the page right now
    streams: [],
    current: null,          // chosen stream object
    wanted: false,          // user wants audio playing
    switching: false,       // a station switch is in flight
    retryTimer: null,
    startedAt: 0,
    now: null,              // last now-playing object
    history: [],
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
    document.dispatchEvent(new Event('themechange'));
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
  // The page needs to know as well as the drawing code: with no ring around it, the play
  // button has nothing to step back for, so the stylesheet keeps it at full strength.
  function markViz() {
    el.vizToggle.setAttribute('aria-pressed', String(vizOn));
    el.player.classList.toggle('viz-off', !vizOn);
  }
  markViz();

  // ?debug=1 exposes the player internals (read-only) so they can be driven from the console or a test.
  if (new URLSearchParams(location.search).has('debug')) {
    window.__player = Object.freeze({ get audio() { return audio; }, get state() { return state; }, get audioCtx() { return audioCtx; } });
  }

  function ensureAudioGraph() {
    if (audioCtx || !vizOn) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      // The browser parks the context in "interrupted" (Safari) or "suspended" when something
      // outside the page takes the audio. Treat that like a system pause: see the 'pause' listener.
      audioCtx.addEventListener('statechange', () => {
        const s = audioCtx.state;
        if ((s === 'interrupted' || s === 'suspended') && state.wanted && !audio.paused) pause();
      });
      const src = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.5;
      analyser.minDecibels = -100;
      analyser.maxDecibels = 0;
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
    el.playBtn.setAttribute('aria-label', 'Pause');
    audio.src = streamUrl(state.current);
    audio.load();
    audio.play().catch((err) => {
      if (err && err.name === 'NotAllowedError') {
        state.wanted = false;
        stop('Tap play to start');
      } else if (err && err.name === 'AbortError') {
        // A newer play(), a stop() or a system pause took over the element. Whoever did that owns the state now.
      } else {
        scheduleRetry(err);
      }
    });
    store.set('wasPlaying', true);
  }

  // Pause but keep the element and its source: the browser keeps the media notification for a
  // paused element, so the lock screen still offers a play button. Nothing restarts on its own
  // from here; the next play() rejoins the live edge with a fresh connection.
  function pause(statusText = 'Paused') {
    state.wanted = false;
    clearTimeout(state.retryTimer);
    clearTimeout(stallTimer);
    if (!audio.paused) audio.pause();
    el.player.classList.remove('playing');
    el.playBtn.setAttribute('aria-label', 'Play');
    setStatus('', statusText);
    state.startedAt = 0;
    el.elapsed.textContent = '';
    updateMediaSession();
  }

  function stop(statusText = 'Stopped') {
    state.wanted = false;
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

  // One fixed wait, and always the same endpoint. A stream that drops is usually back within
  // seconds, so there is nothing to win by backing off. The status text says "Reconnecting"
  // with no number in it: a number that never moves reads as a hang.
  const RETRY_MS = 5000;

  function scheduleRetry(err) {
    if (!state.wanted || state.switching) return;
    setStatus('error', 'Reconnecting');
    console.warn('stream problem, retrying', err);
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => state.wanted && play(), RETRY_MS);
  }

  audio.addEventListener('playing', () => {
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

  // Pauses the app did not ask for.
  //
  // What the browser does on a phone call (or when another app takes the audio): it pauses the
  // element itself, so 'pause' fires and audio.paused becomes true, but nothing in the page is
  // told why. Before this listener existed state.wanted stayed true, so the 'error', 'ended' and
  // stall paths above kept calling play() and the stream came back in the middle of the call.
  //
  // What the app guarantees now: a pause that did not come from stop() or pause() puts the player
  // in "Paused". state.wanted is false, so no retry, no stall timer and no quality switch restarts
  // the stream, and audioCtx.resume() is not called. Playback resumes only through play(): the
  // play button, the keyboard, the lock-screen play action, or the browser handing the audio back
  // after the call (that arrives as a 'play' event, handled below). Every resume reconnects fresh.
  audio.addEventListener('pause', () => {
    if (!state.wanted || state.switching) { updateMediaSession(); return; } // our own stop(), pause() or station swap
    if (audio.ended || audio.error) return;               // 'ended' and 'error' reconnect on their own
    pause();
  });
  // A 'play' we did not start: Chrome resumes the element when the call ends and audio focus comes
  // back. The buffered data is stale for a live stream, so go through play() and rejoin the edge.
  audio.addEventListener('play', () => (state.wanted ? updateMediaSession() : play()));

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

  // ---------- Stations ----------
  const isPhone = () => window.matchMedia('(max-width: 700px)').matches;

  async function loadStations() {
    const res = await fetch('/api/stations', { cache: 'no-store' });
    if (res.status === 503) throw new Error('No station list');
    if (!res.ok) throw new Error('stations ' + res.status);
    state.stations = (await res.json()).stations;
    renderStations();
  }

  // ?station= wins, then the saved one, then the first in the list.
  function pickInitialStation() {
    const fromUrl = new URLSearchParams(location.search).get('station');
    const saved = store.get('station', null);
    return state.stations.find((s) => s.id === fromUrl) || state.stations.find((s) => s.id === saved) || state.stations[0];
  }

  function setStationParam(id) {
    const params = new URLSearchParams(location.search);
    params.set('station', id);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }

  function genreText(s) {
    return (s.genre || '').split('|').filter(Boolean).join(' · ');
  }

  // ---------- Favourites ----------
  // Only ids are stored. An id for a station that is no longer in the list is kept, not
  // dropped: SomaFM retires a channel and brings it back, and the star should survive that.
  state.favourites = new Set(store.get('favourites', []));

  function isFavourite(station) {
    return !!station && state.favourites.has(station.id);
  }

  function toggleFavourite(station) {
    if (!station) return;
    if (state.favourites.has(station.id)) {
      state.favourites.delete(station.id);
      toast('Removed from favourites');
    } else {
      state.favourites.add(station.id);
      toast('Added to favourites');
    }
    store.set('favourites', [...state.favourites]);
    renderStations();
  }

  // Favourites first, then the rest, each group keeping the order of the station list.
  // Starring a station moves it to the top; it does not shuffle the rows around it.
  function orderedStations() {
    const fav = state.stations.filter(isFavourite);
    const rest = state.stations.filter((s) => !isFavourite(s));
    return { fav, rest, all: [...fav, ...rest] };
  }

  function stationRow(s) {
    const li = document.createElement('li');
    li.className = 'station-item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'station-row';
    btn.dataset.id = s.id;
    btn.title = s.description || s.name;
    if (state.station && s.id === state.station.id) btn.setAttribute('aria-current', 'true');
    let logo;
    if (s.logo) {
      logo = document.createElement('img');
      logo.className = 's-logo';
      logo.src = s.logo;
      logo.alt = '';
      logo.loading = 'lazy';
    } else {
      logo = document.createElement('span');
      logo.className = 's-logo s-initial';
      logo.textContent = s.name.slice(0, 1).toUpperCase();
    }
    const text = document.createElement('span');
    const name = document.createElement('span');
    name.className = 's-name';
    name.textContent = s.name;
    const genre = document.createElement('span');
    genre.className = 's-genre';
    genre.textContent = genreText(s) || (s.dj ? s.dj : '');
    text.append(name, genre);
    text.style.display = 'grid';
    btn.append(logo, text);
    btn.addEventListener('click', () => { selectStation(s); closeStations(); });
    // A sibling of the row, not a child: a button inside a button is invalid HTML and
    // browsers drop it.
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    star.dataset.id = s.id;
    const on = isFavourite(s);
    star.setAttribute('aria-pressed', String(on));
    star.title = on ? 'Remove from favourites' : 'Add to favourites';
    star.setAttribute('aria-label', star.title);
    star.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/></svg>';
    star.addEventListener('click', () => toggleFavourite(s));
    li.append(btn, star);
    return li;
  }

  function groupHeading(label) {
    const li = document.createElement('li');
    li.className = 'station-group';
    li.textContent = label;
    return li;
  }

  function renderStations() {
    const q = el.stationFilter.value.trim().toLowerCase();
    const match = (s) => !q || `${s.name} ${s.genre} ${s.description}`.toLowerCase().includes(q);
    const { fav, rest } = orderedStations();
    const favShown = fav.filter(match);
    const restShown = rest.filter(match);
    el.stationList.innerHTML = '';
    // With nothing starred the list looks exactly as it did before: no headings.
    const headings = favShown.length > 0;
    if (headings) el.stationList.appendChild(groupHeading('Favourites'));
    for (const s of favShown) el.stationList.appendChild(stationRow(s));
    if (headings && restShown.length) el.stationList.appendChild(groupHeading('All stations'));
    for (const s of restShown) el.stationList.appendChild(stationRow(s));
    if (!el.stationList.childElementCount) {
      const li = document.createElement('li');
      li.className = 'stations-empty';
      li.textContent = 'No station matches';
      el.stationList.appendChild(li);
    }
  }

  function markCurrentStation() {
    for (const btn of el.stationList.querySelectorAll('.station-row')) {
      if (state.station && btn.dataset.id === state.station.id) {
        btn.setAttribute('aria-current', 'true');
        // 'nearest' only scrolls if the row is actually out of view, so stepping
        // through nearby stations does not jump the list around.
        btn.scrollIntoView({ block: 'nearest' });
      } else {
        btn.removeAttribute('aria-current');
      }
    }
  }

  function openStations() {
    if (isPhone()) {
      el.player.classList.add('stations-open');
      document.body.classList.add('modal');
    }
    el.stationFilter.focus();
  }
  function closeStations() {
    el.player.classList.remove('stations-open');
    document.body.classList.remove('modal');
  }
  el.stationBtn.addEventListener('click', openStations);
  el.stationsClose.addEventListener('click', closeStations);
  el.stationFilter.addEventListener('input', renderStations);
  el.stationFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { el.stationFilter.value = ''; renderStations(); el.stationFilter.blur(); closeStations(); }
  });
  // Leaving phone width turns the overlay back into the desktop column, so drop the
  // overlay state with it rather than leaving the page scroll-locked.
  const phoneQuery = window.matchMedia('(max-width: 700px)');
  phoneQuery.addEventListener('change', (e) => { if (!e.matches) closeStations(); });

  // Steps in the order the list shows, so favourites come first here too.
  function stepStation(delta) {
    const list = orderedStations().all;
    if (!list.length) return;
    const i = list.findIndex((s) => state.station && s.id === state.station.id);
    const next = list[(i + delta + list.length) % list.length];
    selectStation(next);
  }

  // ---------- Streams / quality ----------
  function label(s) {
    const codec = /aac/i.test(s.type) ? 'AAC' : /mpeg|mp3/i.test(s.type) ? 'MP3' : '';
    const kbps = s.bitrate ? `${s.bitrate} kbps` : s.mount || 'stream';
    return [kbps, codec].filter(Boolean).join(' ');
  }

  // Ask the server for a station's streams. Nothing on the page changes here, so a
  // reply the user no longer wants can be dropped without leaving a trace.
  async function fetchStreams(station) {
    const res = await fetch(`/api/streams?station=${encodeURIComponent(station.id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('streams ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.streams) || !data.streams.length) throw new Error('streams: empty list');
    return data;
  }

  function applyStreams(station, data) {
    state.streams = data.streams;
    el.stationName.textContent = station.name;
    document.title = station.name;
    el.stationLink.href = data.stationUrl || station.site || '#';
    el.stationLink.textContent = (data.stationUrl || station.site || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') || 'site';
    el.plsLink.href = data.plsUrl;

    el.quality.innerHTML = '';
    const sorted = [...state.streams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    for (const s of sorted) {
      const opt = document.createElement('option');
      opt.value = s.mount;
      opt.textContent = label(s) + (s.primary ? ' · default' : '');
      el.quality.appendChild(opt);
    }
    const savedMount = store.get(`mount:${station.id}`, null);
    state.current = state.streams.find((s) => s.mount === savedMount) || state.streams.find((s) => s.primary) || state.streams[0];
    el.quality.value = state.current.mount;
    el.bitrate.textContent = label(state.current);
    state.applied = station;
  }

  el.quality.addEventListener('change', () => {
    const s = state.streams.find((x) => x.mount === el.quality.value);
    if (!s) return;
    state.current = s;
    store.set(`mount:${state.applied.id}`, s.mount);
    el.bitrate.textContent = label(s);
    if (state.wanted) play();
  });

  function clearNow() {
    state.now = null;
    el.song.textContent = state.wanted ? 'Live' : 'Press play';
    el.artist.innerHTML = '&nbsp;';
    el.show.innerHTML = '';
    el.listeners.textContent = '';
  }

  // The page while a station's streams are on their way. Fetching them takes a moment, and
  // without this the old station's name, track and history stay up for the whole wait. The
  // only thing that did change, the highlight in the list, is behind a closed panel on a phone.
  function showLoading(station) {
    el.stationName.textContent = station.name;
    document.title = station.name;
    setStatus('busy', 'Loading');
    el.song.textContent = 'Loading';
    el.artist.innerHTML = '&nbsp;';
    el.show.innerHTML = '';
    el.listeners.textContent = '';
    el.bitrate.textContent = '';
    // Clear the rendered list, not state.history: a now-playing reply for the station we are
    // leaving can still land, and applyNow would append to the emptied array and save that
    // over the old station's real history.
    el.historyList.innerHTML = '';
  }

  // Put a station that is already loaded back on the page. Used when a switch fails and the
  // page has to return to the station it is really playing.
  function showStation(station) {
    el.stationName.textContent = station.name;
    document.title = station.name;
    el.bitrate.textContent = state.current ? label(state.current) : '';
    state.history = store.get(`history:${station.id}`, []);
    renderHistory();
    clearNow();
  }

  // Switch to a station. Returns true when its streams could be loaded. With `initial`
  // the page is booting: nothing is playing yet, so no play() and no "same station" shortcut.
  async function selectStation(station, { initial = false } = {}) {
    if (!station) return false;
    // Compare against what is actually on the page, not merely what was last clicked,
    // so a station whose load failed can always be retried.
    if (!initial && state.applied && station.id === state.applied.id) return true;
    const resume = state.wanted;
    const previous = state.applied;
    state.station = station;
    state.switching = true;
    markCurrentStation();
    showLoading(station);
    // Cut the old station's sound now instead of when the new stream is ready: hearing one
    // station while reading another's name is worse than a moment of silence. state.wanted
    // stays true so a second click still knows the user wants audio; state.switching is what
    // tells the audio event handlers that this pause is ours and needs no retry.
    if (resume) {
      clearTimeout(state.retryTimer);
      clearTimeout(stallTimer);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    let data;
    try {
      data = await fetchStreams(station);
    } catch (err) {
      console.warn('station unreachable', err);
      // Only undo the choice if the user has not since picked something else, and fall
      // back to the station the page is really showing rather than one that never loaded.
      if (state.station === station) {
        state.switching = false;
        state.station = previous;
        markCurrentStation();
        toast('Station unreachable');
        if (previous) {
          // applyStreams never ran, so state.current is still the previous station's stream.
          showStation(previous);
          if (resume) play(); else setStatus('', 'Stopped');
          pollNow();
        } else {
          setStatus('error', 'Station unreachable');
          el.song.textContent = 'Station unreachable';
        }
      }
      return false;
    }
    // A reply for a station the user has already left changes nothing. The newer call owns
    // state.switching, so leave it alone here.
    if (state.station !== station) return false;
    state.switching = false;
    applyStreams(station, data);
    store.set('station', station.id);
    setStationParam(station.id);
    state.history = store.get(`history:${station.id}`, []);
    renderHistory();
    clearNow();
    updateMediaSession();
    if (resume) play(); else setStatus('', 'Stopped');
    // Stepping stations with [ and ] never opens the panel, so the toast is the only
    // confirmation that the click landed on the station the user meant.
    if (!initial) toast(station.name);
    pollNow();
    return true;
  }

  // ---------- Now playing ----------
  // Polls for the applied station: the one whose data is actually on the page, not merely
  // the one last clicked. Polling state.station instead would, during a switch, apply the
  // new track onto the array still belonging to the old station and save it under the new
  // station's key, permanently mixing one station's history into another's.
  let nowTimer = null;
  async function pollNow() {
    clearTimeout(nowTimer);
    const station = state.applied;
    if (station) {
      try {
        const res = await fetch(`/api/now?station=${encodeURIComponent(station.id)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('now ' + res.status);
        const now = await res.json();
        if (state.applied === station && !state.switching) applyNow(now);
      } catch (err) {
        console.warn('now-playing unavailable', err);
      }
    }
    // Only the poll that still matches the applied station owns the next tick, so a
    // stale call cannot leave a second timer running.
    if (state.applied === station) {
      const interval = document.hidden ? 60000 : state.wanted ? 10000 : 30000;
      nowTimer = setTimeout(pollNow, interval);
    }
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
    if (!now.dj && !now.show && now.album) el.show.textContent = now.album;
    el.listeners.textContent = now.listeners != null ? `${now.listeners} listening` : '';
    if (!state.history.length && Array.isArray(now.history) && now.history.length) seedHistory(now.history);
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
    state.history = state.history.slice(0, 100);
    store.set(`history:${state.applied.id}`, state.history);
    renderHistory();
  }

  // The station's own recent-tracks list, used when this browser has heard nothing here yet.
  function seedHistory(list) {
    if (!state.applied) return;
    state.history = list.map((h) => ({ raw: h.artist ? `${h.artist} - ${h.song}` : h.song, artist: h.artist, song: h.song, at: h.at || Date.now() }));
    store.set(`history:${state.applied.id}`, state.history);
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
    if (!state.applied) return;
    state.history = [];
    store.set(`history:${state.applied.id}`, []);
    renderHistory();
  });

  // ---------- Media Session (OS media keys, lock screen) ----------
  // Chrome for Android picks 512x512 artwork (256x256 on low-end phones) and wants PNG; an SVG
  // may be ignored. The notification shows the song as title and the artist as subtitle.
  // playbackState follows the real element, not what the app wants, so the lock-screen button
  // matches what is actually happening. No previous/next: it is a live stream.
  const ARTWORK = [512, 256].map((px) => ({ src: `${location.origin}/icon-${px}.png`, sizes: `${px}x${px}`, type: 'image/png' }));
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const now = state.now || {};
    try {
      const logo = state.applied && /^https?:/.test(state.applied.logo) ? [{ src: state.applied.logo, sizes: '256x256', type: 'image/png' }] : ARTWORK;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: now.song || el.stationName.textContent,
        artist: now.artist || (now.dj ? `${now.dj} on air` : ''),
        album: el.stationName.textContent,
        artwork: logo,
      });
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
    } catch { /* ignore */ }
  }
  if ('mediaSession' in navigator) {
    const actions = [['play', () => play()], ['pause', () => pause()], ['stop', () => stop()]];
    for (const [action, handler] of actions) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
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
  // A ring of bars around the play button, mirrored left and right.
  // Bands are spaced logarithmically (equal width per octave) and averaged,
  // so bass and treble get equal room. Levels rise instantly and fall slowly.
  const ctx2d = el.viz.getContext('2d');
  let vizFrame = null;
  const BANDS = 56;             // bars per half; the ring shows twice this
  const F_LO = 45, F_HI = 14500; // Hz; MP3 has nothing useful above 16 kHz
  const RELEASE = 0.86;         // per-frame decay of a bar once the signal drops
  const DB_LO = -62, DB_HI = -26; // band power range mapped to bar length 0..1 (measured on the live stream)
  const TILT_DB = 8;             // gentle lift toward the top band so treble is not always the runt
  const PEAK_HOLD = 18;         // frames a peak cap sits still before it starts to fall
  const PEAK_FALL = 0.012;      // how much a cap drops per frame once it lets go
  let levels = new Float32Array(BANDS);
  const peaks = new Float32Array(BANDS);
  const peakHold = new Uint8Array(BANDS);
  const bandDb = new Float32Array(BANDS);
  // ?debug=1 exposes the band readings so they can be inspected from the console (see window.__player too).
  if (new URLSearchParams(location.search).has('debug')) window.__viz = { levels, bandDb };
  let bandEdges = null;
  let colors = { c1: '', c2: '' };

  function readColors() {
    const css = getComputedStyle(document.documentElement);
    colors = { c1: css.getPropertyValue('--viz').trim(), c2: css.getPropertyValue('--viz-2').trim() };
  }
  readColors();
  document.addEventListener('themechange', readColors);

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = el.viz.getBoundingClientRect();
    el.viz.width = Math.round(r.width * dpr);
    el.viz.height = Math.round(r.height * dpr);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function computeBandEdges() {
    const nyquist = audioCtx.sampleRate / 2;
    const bins = analyser.frequencyBinCount;
    const edges = new Array(BANDS + 1);
    for (let i = 0; i <= BANDS; i++) {
      const hz = F_LO * (F_HI / F_LO) ** (i / BANDS);
      edges[i] = Math.min(bins - 1, Math.round((hz / nyquist) * bins));
    }
    return edges;
  }

  function setBass(v) {
    document.documentElement.style.setProperty('--bass', v.toFixed(3));
  }

  function drawViz() {
    cancelAnimationFrame(vizFrame);
    if (!analyser || !vizOn) { clearViz(); return; }
    if (!bandEdges) bandEdges = computeBandEdges();
    const data = new Float32Array(analyser.frequencyBinCount);
    const frame = () => {
      if (!state.wanted || !vizOn) { clearViz(); return; }
      vizFrame = requestAnimationFrame(frame);
      analyser.getFloatFrequencyData(data); // dB per bin

      // Sum the power of the bins in each band (wide treble bands add up, so
      // they are not starved), turn it back into dB, then apply attack/release.
      for (let i = 0; i < BANDS; i++) {
        const from = bandEdges[i];
        const to = Math.max(from + 1, bandEdges[i + 1]);
        let power = 0;
        for (let b = from; b < to; b++) power += 10 ** (data[b] / 10);
        const db = 10 * Math.log10(power + 1e-12) + (i / BANDS) * TILT_DB;
        bandDb[i] = db;
        const v = Math.min(1, Math.max(0, (db - DB_LO) / (DB_HI - DB_LO))) ** 1.3;
        levels[i] = v > levels[i] ? v : levels[i] * RELEASE;
        // Peak caps: jump up with the bar, hold, then fall at a steady pace.
        if (levels[i] >= peaks[i]) {
          peaks[i] = levels[i];
          peakHold[i] = PEAK_HOLD;
        } else if (peakHold[i] > 0) {
          peakHold[i] -= 1;
        } else {
          peaks[i] = Math.max(levels[i], peaks[i] - PEAK_FALL);
        }
      }

      const W = el.viz.width, H = el.viz.height;
      const dpr = window.devicePixelRatio || 1;
      ctx2d.clearRect(0, 0, W, H);
      // Centre the ring on the button wherever CSS put it.
      const br = el.playBtn.getBoundingClientRect();
      const vr = el.viz.getBoundingClientRect();
      const cx = (br.left + br.width / 2 - vr.left) * dpr;
      const cy = (br.top + br.height / 2 - vr.top) * dpr;
      const inner = (br.width / 2 + 10) * dpr;     // just outside the button
      const maxLen = Math.min(cx, H - cy) - inner - 10 * dpr;
      const step = Math.PI / BANDS;                // angle between bars on one side
      const bw = Math.max(1.5 * dpr, inner * step * 0.62);

      ctx2d.save();
      ctx2d.translate(cx, cy);
      ctx2d.lineCap = 'round';
      ctx2d.lineWidth = bw;
      for (let i = 0; i < BANDS; i++) {
        const v = levels[i];
        const len = Math.max(2 * dpr, v * maxLen);
        // Bass at the bottom (6 o'clock), treble at the top, mirrored on both sides.
        const a = Math.PI / 2 - (i + 0.5) * step;
        const grad = ctx2d.createLinearGradient(0, inner, 0, inner + len);
        grad.addColorStop(0, colors.c1);
        grad.addColorStop(1, colors.c2);
        ctx2d.strokeStyle = grad;
        ctx2d.globalAlpha = 0.4 + v * 0.6;
        const cap = inner + Math.max(len, peaks[i] * maxLen) + 5 * dpr;
        for (const side of [1, -1]) {
          ctx2d.save();
          ctx2d.rotate(side * a);
          ctx2d.beginPath();
          ctx2d.moveTo(0, inner);
          ctx2d.lineTo(0, inner + len);
          ctx2d.stroke();
          // The cap: a short dash a little beyond the bar's peak.
          ctx2d.strokeStyle = colors.c1;
          ctx2d.globalAlpha = 0.55 + peaks[i] * 0.45;
          ctx2d.beginPath();
          ctx2d.moveTo(0, cap);
          ctx2d.lineTo(0, cap + 2.5 * dpr);
          ctx2d.stroke();
          ctx2d.restore();
        }
      }
      ctx2d.restore();
      ctx2d.globalAlpha = 1;

      // Bass energy drives the glow around the button and the page.
      let bass = 0;
      for (let i = 0; i < 6; i++) bass += levels[i];
      setBass(bass / 6);
    };
    frame();
  }
  function clearViz() {
    ctx2d.clearRect(0, 0, el.viz.width, el.viz.height);
    levels.fill(0);
    peaks.fill(0);
    setBass(0);
  }

  el.vizToggle.addEventListener('click', () => {
    vizOn = !vizOn;
    store.set('viz', vizOn);
    markViz();
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
      case 'f': toggleFavourite(state.station); break;
      case '[': stepStation(-1); break;
      case ']': stepStation(1); break;
      case '/': e.preventDefault(); openStations(); break;
      case 'Escape': closeStations(); break;
      default: return;
    }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNow(); });

  // ---------- Boot ----------
  (async () => {
    try {
      await loadStations();
    } catch (err) {
      setStatus('error', 'Server unreachable');
      el.song.textContent = err.message === 'No station list' ? 'No station list' : 'Could not load the station list';
      console.error(err);
      return;
    }
    if (!(await selectStation(pickInitialStation(), { initial: true }))) {
      setStatus('error', 'Station unreachable');
      return;
    }
    if (store.get('wasPlaying', false)) play(); // may be blocked by autoplay rules; then we show "Tap play"
  })();
})();
