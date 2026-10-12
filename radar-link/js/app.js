/* Radar Link — wiring. Reads lines from whichever source is open, keeps a track per
 * `idx`, and paints the scope, the contact panel and the raw stream from them.
 *
 * Nothing here corrects the board. A row that disagrees with itself is shown
 * disagreeing, and a frame the link lost is counted rather than smoothed over.
 */
(function () {
  const RL = window.RL;
  const $ = (selector) => document.querySelector(selector);
  const FRAME_WRAP = 65536;          // the frame counter is 16-bit on the wire
  const CAPTURE_LIMIT = 50000;       // lines held for export
  const RECORD_LIMIT = 400000;       // ~11 hours at 10 Hz before a recording truncates
  const LOG_LIMIT = 220;             // rows kept in each stream list

  // ── Settings ─────────────────────────────────────────────
  /* Whoever served this page is the most likely place the bridge is running — a
     teammate's laptop holding the one BLE connection the board allows, say. */
  const bridgeHost = (location.hostname && location.protocol !== 'file:') ? location.hostname : '127.0.0.1';
  const DEFAULTS = {
    rangeMode: 'auto', range: 2, fov: 160, side: 'right', trail: 3, hold: 600,
    speed: 5, window: 10,
    baud: 115200, bridgeUrl: 'ws://' + bridgeHost + ':8787',
    bleService: RL.NUS.service, bleNotify: RL.NUS.notify, bleShowAll: true,
    interval: 100, sound: true,
  };
  const SETTINGS_KEY = 'radarlink.settings.v1';
  let settings = Object.assign({}, DEFAULTS);
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch {}
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

  // ── State ────────────────────────────────────────────────
  const state = {
    mode: 'live',
    tracks: new Map(),
    selected: null,
    autoSelect: true,
    stats: { frames: 0, dropped: 0, resyncs: 0, empty: 0, bad: 0, other: 0, bytes: 0, chars: 0, firstAt: null },
    lastFrame: null,
    lastFrameAt: -99,
    frameTimes: [],
    autoRange: 1,
    link: { kind: null, status: 'idle', name: '', detail: '' },
    handle: null,
    syntheticTimer: null,
    synthetic: null,
    replay: { lines: [], index: 0, playing: false, name: '', carry: 0, speed: 1, loop: true },
    capture: [],
    captureTruncated: false,
    /** An explicitly marked segment, started and stopped by hand. */
    recording: { active: false, startedAt: 0, startedWall: null, lines: [], frames: 0, truncated: false },
    /** Drone-present edge and the last time the tone played. */
    alarm: { droneUp: false, lastAt: -99 },
    logTab: 'stream',
    problems: 0,
    logCount: 0,
    docks: { left: true, right: true, bottom: true },
  };

  const now = () => performance.now() / 1000;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  // ── Elements ─────────────────────────────────────────────
  const els = {};
  const bind = (map) => { for (const key in map) els[key] = $(map[key]); };
  bind({
    viewport: '.viewport-wrap', scope: '#scope', hud: '#hud',
    dockLeft: '#dock-left', dockRight: '#dock-right', dockBottom: '#dock-bottom',
    linkChip: '#link-chip', linkChipLabel: '#link-chip-label', linkChipDetail: '#link-chip-detail',
    runStatus: '#run-status', runStatusLabel: '#run-status-label', frameTag: '#frame-tag',
    scaleLabel: '#scale-label', fps: '#fps',
    trackList: '#track-list', trackEmpty: '#track-empty', trackCount: '#track-count',
    logList: '#log-list', problemList: '#problem-list', logCount: '#log-count', problemCount: '#problem-count',
    logFollow: '#log-follow',
    disconnect: '#disconnect-btn', linkTitle: '#link-title', linkUptime: '#link-uptime', linkHint: '#link-hint',
    supportNote: '#support-note',
    playBtn: '#play-btn', playIcon: '#play-icon', replayPos: '#replay-pos', replayTotal: '#replay-total',
    replayClock: '#replay-clock', replayScrub: '#replay-scrub', replaySpeed: '#replay-speed', replayLoop: '#replay-loop',
    fileInput: '#file-input', toast: '#toast',
    recordBtn: '#record-btn', recordStop: '#record-stop',
    threatAlert: '#threat-alert', threatAction: '#threat-action', soundBtn: '#sound-btn',
    settingsDialog: '#settings-dialog', helpDialog: '#help-dialog',
    footDot: '#foot-dot', footLink: '#foot-link', footSource: '#foot-source', footStats: '#foot-stats', footRate: '#foot-rate',
    inspIcon: '#insp-icon', inspName: '#insp-name', inspBadge: '#insp-badge', inspSub: '#insp-sub', inspWire: '#insp-wire',
  });
  const text = (id, value) => { const node = $(id); if (node && node.textContent !== value) node.textContent = value; };

  const sound = RL.Sound();
  const scope = RL.Scope(els.scope);
  const strips = {
    range: RL.Strip($('#strip-range'), { color: '#3f8a71', format: (v) => RL.fmt.distance(v, 1) }),
    bearing: RL.Strip($('#strip-bearing'), { color: '#5d7f98', zero: true, format: (v) => v.toFixed(0) + '°' }),
    closing: RL.Strip($('#strip-closing'), { color: '#c2673c', zero: true, format: (v) => v.toFixed(1) }),
    ttg: RL.Strip($('#strip-ttg'), { color: '#8a7bb8', format: (v) => Math.round(v * 1000) + 'ms' }),
  };

  // ── Toast ────────────────────────────────────────────────
  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 3200);
  }

  // ── Stream log ───────────────────────────────────────────
  function logRow(list, tone, body, tail) {
    const row = document.createElement('div');
    row.className = 'log-row ' + tone;
    row.innerHTML = '<i></i><span></span><small></small>';
    row.children[1].textContent = body;
    row.children[2].textContent = tail || '';
    list.appendChild(row);
    while (list.childElementCount > LOG_LIMIT) list.removeChild(list.firstChild);
    if (els.logFollow.checked) list.scrollTop = list.scrollHeight;
  }

  function logLine(row) {
    if (row.kind === 'target') {
      state.logCount++;
      logRow(els.logList, '', row.text, '#' + row.idx + ' ' + (row.solved ? 'solved' : 'chase'));
    } else if (row.kind === 'empty') {
      state.logCount++;
      logRow(els.logList, 'empty', row.text, 'no target');
    } else {
      state.problems++;
      const tone = row.kind === 'bad' ? 'bad' : 'other';
      logRow(els.problemList, tone, row.text, row.reason || 'not a G row');
    }
    text('#log-count', String(state.logCount));
    text('#problem-count', String(state.problems));
  }

  function note(message) {
    logRow(els.logList, 'note', message, '');
  }

  // ── Ingest ───────────────────────────────────────────────
  let reader = RL.LineReader();

  function ingestText(chunk) {
    for (const line of reader.push(chunk)) ingestLine(line);
  }

  function ingestLine(raw) {
    const trimmed = String(raw).trim();
    if (!trimmed || trimmed[0] === '#') return;     // '#' is a comment in a saved log

    if (state.capture.length < CAPTURE_LIMIT) state.capture.push(trimmed);
    else state.captureTruncated = true;

    const rec = state.recording;
    if (rec.active) {
      if (rec.lines.length < RECORD_LIMIT) rec.lines.push(trimmed);
      else rec.truncated = true;
    }

    state.stats.chars += trimmed.length + 1;
    const row = RL.parseLine(trimmed);
    if (!row) return;
    logLine(row);

    if (row.kind === 'other') { state.stats.other++; return; }
    if (row.kind === 'bad') { state.stats.bad++; return; }

    countFrame(row.frame);
    if (row.kind === 'empty') { state.stats.empty++; markGap(); return; }
    updateTrack(row);
  }

  /** Frame bookkeeping. Several target rows can share one frame number. */
  function countFrame(frame) {
    const at = now();
    if (state.lastFrame === null) {
      state.stats.frames = 1;
      state.stats.firstAt = at;
    } else {
      let delta = frame - state.lastFrame;
      if (delta < 0) delta += FRAME_WRAP;           // the counter wrapped
      if (delta === 0) { state.lastFrameAt = at; return; }   // another target, same frame
      state.stats.frames++;
      if (delta > 500) state.stats.resyncs++;       // too far to call these dropped frames
      else if (delta > 1) state.stats.dropped += delta - 1;
    }
    state.lastFrame = frame;
    state.lastFrameAt = at;
    state.frameTimes.push(at);
    if (state.frameTimes.length > 400) state.frameTimes.splice(0, 200);
  }

  /** A frame with no target breaks every track's history, rather than joining across it. */
  function markGap() {
    const at = now();
    for (const track of state.tracks.values()) {
      if (track.series.range.length && track.series.range[track.series.range.length - 1].v !== null) {
        for (const key in track.series) track.series[key].push({ t: at, v: null });
      }
    }
  }

  function updateTrack(row) {
    const at = now();
    let track = state.tracks.get(row.idx);
    if (!track) {
      track = { idx: row.idx, history: [], series: { range: [], bearing: [], closing: [], ttg: [] }, frames: 0, solvedFrames: 0, firstAt: at };
      state.tracks.set(row.idx, track);
    }
    track.row = row;
    track.cls = row.cls;
    track.klass = row.klass;
    track.lastAt = at;
    track.stale = false;
    track.frames++;
    if (row.solved) track.solvedFrames++;

    track.history.push({ t: at, x: row.position.x, y: row.position.y });
    const trailKeep = Math.max(settings.trail, 1) + 1;
    while (track.history.length && at - track.history[0].t > trailKeep) track.history.shift();

    track.series.range.push({ t: at, v: row.rangeM });
    track.series.bearing.push({ t: at, v: row.bearingDeg });
    track.series.closing.push({ t: at, v: row.closingMs });
    track.series.ttg.push({ t: at, v: row.solved ? row.ttgS : null });
    for (const key in track.series) {
      const series = track.series[key];
      while (series.length && at - series[0].t > settings.window + 2) series.shift();
    }
  }

  function expireTracks() {
    const at = now();
    const hold = settings.hold / 1000;
    for (const [idx, track] of state.tracks) {
      const age = at - track.lastAt;
      track.stale = age > hold;
      if (age > hold * 3) state.tracks.delete(idx);
    }
  }

  function resetStream(keepCapture) {
    state.tracks.clear();
    state.lastFrame = null;
    state.lastFrameAt = -99;
    state.frameTimes = [];
    state.stats = { frames: 0, dropped: 0, resyncs: 0, empty: 0, bad: 0, other: 0, bytes: 0, firstAt: null };
    state.selected = null;
    state.autoSelect = true;
    reader = RL.LineReader();
    if (!keepCapture) { state.capture = []; state.captureTruncated = false; }
  }

  // ── Link control ─────────────────────────────────────────
  const KIND_LABEL = { ble: 'Bluetooth LE', serial: 'Serial port', bridge: 'Python bridge', synthetic: 'Synthetic feed', replay: 'Replay' };

  function setLink(kind, status, name, detail) {
    state.link = { kind, status, name: name || '', detail: detail || '' };
    const chip = els.linkChip;
    chip.dataset.state = status;
    text('#link-chip-label', status === 'idle' ? 'No link' : KIND_LABEL[kind] || kind);
    text('#link-chip-detail', status === 'idle' ? 'pick a transport' : status === 'connecting' ? 'connecting…' : name || detail || '');
    els.disconnect.disabled = !state.handle && !state.syntheticTimer;
    for (const card of document.querySelectorAll('.transport-card')) {
      card.classList.toggle('active', status === 'open' && card.dataset.value === kind);
    }
    text('#link-title', status === 'idle' ? 'Waiting for a transport'
      : (KIND_LABEL[kind] || kind) + (name ? ' · ' + name : ''));
    els.footDot.className = 'connection-dot' + (status === 'open' ? ' open' : status === 'error' ? ' error' : '');
    text('#foot-link', status === 'idle' ? 'No link' : KIND_LABEL[kind] || kind);
    text('#foot-source', detail || name || '—');
  }

  const handlers = {
    onText: (chunk) => ingestText(chunk),
    onBytes: (count) => { state.stats.bytes += count; },
    onClose: (reason) => { closeLink(); note('Link closed: ' + reason); toast('Link closed — ' + reason); setLink(null, 'idle'); },
    onError: (error) => { note('Link error: ' + (error && error.message ? error.message : error)); toast(String(error && error.message || error)); },
  };

  async function closeLink() {
    if (state.handle) { try { await state.handle.close(); } catch {} state.handle = null; }
    if (state.syntheticTimer) { clearInterval(state.syntheticTimer); state.syntheticTimer = null; state.synthetic = null; }
    els.disconnect.disabled = true;
  }

  async function connect(kind) {
    await closeLink();
    stopReplay();
    state.mode = 'live';
    syncMode();
    resetStream(false);
    setLink(kind, 'connecting');

    if (kind === 'synthetic') {
      state.synthetic = RL.Synthetic({ speed: settings.speed, fovDeg: settings.fov });
      const period = 100;
      state.syntheticTimer = setInterval(() => {
        for (const line of state.synthetic.next(period / 1000)) ingestLine(line);
      }, period);
      setLink('synthetic', 'open', state.synthetic.label, '10 Hz, generated in the browser');
      note('Synthetic feed started — rows are generated here, not measured.');
      return;
    }

    try {
      const handle = await RL.transports[kind](settings, handlers);
      state.handle = handle;
      setLink(handle.kind, 'open', handle.name, handle.detail);
      note('Connected over ' + (KIND_LABEL[handle.kind] || handle.kind) + ' — ' + handle.name);
      toast('Connected to ' + handle.name);
    } catch (error) {
      const message = error && error.name === 'NotFoundError' ? 'No device chosen.' : (error && error.message) || String(error);
      setLink(kind, 'error', '', message);
      text('#link-chip-detail', message);
      note('Could not open ' + (KIND_LABEL[kind] || kind) + ': ' + message);
      toast(message);
    }
  }

  // ── Replay ───────────────────────────────────────────────
  function loadReplay(content, name) {
    const lines = String(content).split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && line[0] !== '#');
    if (!lines.length) { toast('That file has no rows in it.'); return; }
    closeLink();
    state.mode = 'replay';
    state.replay.lines = lines;
    state.replay.index = 0;
    state.replay.carry = 0;
    state.replay.name = name;
    state.replay.playing = true;
    resetStream(false);
    setLink('replay', 'open', name, lines.length + ' lines at ' + settings.interval + ' ms');
    note('Replaying ' + name + ' — ' + lines.length + ' lines, one every ' + settings.interval + ' ms.');
    syncMode();
    syncReplayUi();
  }

  function stopReplay() {
    state.replay.playing = false;
    syncReplayUi();
  }

  function stepReplay(count) {
    const replay = state.replay;
    for (let i = 0; i < count; i++) {
      if (replay.index >= replay.lines.length) {
        if (!replay.loop) { replay.playing = false; note('Replay reached the end of ' + replay.name + '.'); break; }
        replay.index = 0;
        resetStream(true);
        note('Replay looped.');
      }
      ingestLine(replay.lines[replay.index++]);
    }
    syncReplayUi();
  }

  function advanceReplay(dt) {
    const replay = state.replay;
    if (!replay.playing || !replay.lines.length) return;
    replay.carry += (dt * replay.speed * 1000) / Math.max(1, settings.interval);
    const steps = Math.floor(replay.carry);
    if (steps <= 0) return;
    replay.carry -= steps;
    stepReplay(Math.min(steps, 400));
  }

  function syncReplayUi() {
    const replay = state.replay;
    const total = replay.lines.length;
    text('#replay-pos', String(replay.index));
    text('#replay-total', String(total));
    text('#replay-clock', RL.fmt.clock((replay.index * settings.interval) / 1000));
    els.replayScrub.max = String(Math.max(0, total));
    els.replayScrub.value = String(replay.index);
    els.replayScrub.disabled = !total;
    els.replayScrub.style.setProperty('--progress', (total ? (replay.index / total) * 100 : 0) + '%');
    els.playIcon.innerHTML = replay.playing ? '<path d="M8 5v14M16 5v14"/>' : '<path d="m8 5 11 7-11 7Z"/>';
    els.playBtn.setAttribute('aria-label', replay.playing ? 'Pause' : 'Play');
  }

  function syncMode() {
    for (const button of document.querySelectorAll('[data-action=mode]')) {
      const on = button.dataset.value === state.mode;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  // ── Selection ────────────────────────────────────────────
  function trackList() {
    return Array.from(state.tracks.values()).sort((a, b) => a.idx - b.idx);
  }

  /**
   * The contact that matters most right now: a drone over a moving object, a solved
   * intercept over a chase, then whichever is soonest or nearest. The alert and the
   * default selection both read this, so the banner and the panel never disagree.
   */
  function mostUrgent() {
    const live = trackList().filter((track) => !track.stale && track.row);
    if (!live.length) return null;
    const drones = live.filter((track) => track.cls === 2);
    const pool = drones.length ? drones : live;
    const solved = pool.filter((track) => track.row.solved);
    const field = solved.length ? solved : pool;
    return field.reduce((best, track) => {
      const value = track.row.solved ? track.row.ttgS : track.row.rangeM;
      const bestValue = best.row.solved ? best.row.ttgS : best.row.rangeM;
      return value < bestValue ? track : best;
    });
  }

  function pickAuto() {
    const track = mostUrgent();
    return track ? track.idx : null;
  }

  function selectedTrack() {
    if (state.autoSelect || state.selected === null || !state.tracks.has(state.selected)) {
      const auto = pickAuto();
      if (state.autoSelect) state.selected = auto;
      else if (state.selected === null || !state.tracks.has(state.selected)) state.selected = auto;
    }
    return state.selected === null ? null : state.tracks.get(state.selected) || null;
  }

  // ── Views ────────────────────────────────────────────────
  const DRONE_GLYPH = '<svg class="ico" viewBox="0 0 24 24"><path d="m8 8 8 8m0-8-8 8M9 9h6v6H9Z"/><circle cx="5" cy="5" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/></svg>';
  const MOVER_GLYPH = '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
  const RADAR_GLYPH = '<svg class="ico" viewBox="0 0 24 24"><path d="M12 12 4.5 7.5a9 9 0 1 0 3-3Z"/><circle cx="12" cy="12" r="9"/></svg>';

  let listSignature = '';
  function renderTrackList() {
    const tracks = trackList();
    const signature = tracks.map((t) => [t.idx, t.cls, t.stale ? 1 : 0, t.row && t.row.solved ? 1 : 0,
      t.row ? t.row.rangeMm : 0, t.row ? t.row.bearingCdeg : 0, t.idx === state.selected ? 1 : 0].join(':')).join('|');
    text('#track-count', String(tracks.length));
    if (signature === listSignature) return;
    listSignature = signature;
    els.trackEmpty.hidden = tracks.length > 0;
    els.trackList.innerHTML = tracks.map((track) => {
      const row = track.row;
      const key = track.klass ? track.klass.key : 'unknown';
      const glyph = key === 'drone' ? DRONE_GLYPH : MOVER_GLYPH;
      const hitRate = track.frames ? Math.round((track.solvedFrames / track.frames) * 100) : 0;
      return '<button class="entity-item' + (track.idx === state.selected ? ' selected' : '') + (track.stale ? ' stale' : '') +
        '" data-action="select" data-value="' + track.idx + '">' +
        '<span class="entity-icon ' + key + '">' + glyph + '</span>' +
        '<span class="entity-text"><b>#' + track.idx + ' ' + track.klass.label + '</b>' +
        '<small>' + RL.fmt.distance(row.rangeM) + ' · ' + RL.fmt.bearing(row.bearingDeg, 1) + ' · ' + hitRate + '% solved</small></span>' +
        '<span class="entity-status ' + (row.solved ? 'solved' : 'chase') + '"></span></button>';
    }).join('');
  }

  const HUD = {
    range: $('#hud-range'), rangeSub: $('#hud-range-sub'),
    bearing: $('#hud-bearing'), bearingSub: $('#hud-bearing-sub'),
    closing: $('#hud-closing'), closingSub: $('#hud-closing-sub'),
    ttg: $('#hud-ttg'), ttgSub: $('#hud-ttg-sub'), ttgCell: $('#hud-ttg-cell'),
    command: $('#hud-command'), commandSub: $('#hud-command-sub'),
    rate: $('#hud-rate'), rateSub: $('#hud-rate-sub'),
  };

  function rateHz() {
    const at = now();
    const recent = state.frameTimes.filter((t) => at - t <= 3);
    if (recent.length < 2) return 0;
    const span = recent[recent.length - 1] - recent[0];
    return span > 0 ? (recent.length - 1) / span : 0;
  }

  function renderHud(track) {
    const row = track && track.row;
    const rate = rateHz();
    const live = now() - state.lastFrameAt < 1.5;

    if (row) {
      const distance = RL.fmt.distanceValue(row.rangeM);
      HUD.range.textContent = distance.value;
      HUD.rangeSub.textContent = distance.unit + ' · ' + row.rangeMm + ' mm';
      HUD.bearing.textContent = RL.fmt.bearing(row.bearingDeg, 1);
      HUD.bearingSub.textContent = row.bearingCdeg + ' (0.01°)';
      HUD.closing.textContent = RL.fmt.rate(row.closingMs);
      HUD.closingSub.textContent = row.closingMs > 0 ? 'm/s closing' : row.closingMs < 0 ? 'm/s opening' : 'm/s steady';
      HUD.closing.parentElement.dataset.tone = row.closingMs > 0 ? 'bad' : '';
      HUD.ttg.textContent = row.solved ? RL.fmt.duration(row.ttgS) : 'CHASE';
      HUD.ttgSub.textContent = row.solved ? 'sol 1 · solved' : 'sol 0 · no solution';
      HUD.ttgCell.dataset.tone = row.solved ? 'good' : 'warn';
      HUD.command.textContent = RL.fmt.heading(row.command.headingDeg);
      HUD.commandSub.textContent = RL.fmt.speed(row.command.speed);
    } else {
      for (const key of ['range', 'bearing', 'closing', 'ttg', 'command']) { HUD[key].textContent = '—'; HUD[key + 'Sub'].textContent = ' '; }
      HUD.ttgCell.dataset.tone = '';
      HUD.closing.parentElement.dataset.tone = '';
    }

    HUD.rate.textContent = rate > 0 ? rate.toFixed(1) : '—';
    HUD.rateSub.textContent = rate > 0 ? 'Hz · frame ' + (state.lastFrame == null ? '—' : state.lastFrame) : 'no frames';
    HUD.rate.parentElement.dataset.tone = live ? 'live' : '';

    // Status pill: what the link is doing, which is not the same as what it sees.
    let label = 'IDLE', tone = '';
    if (state.link.status === 'connecting') { label = 'CONNECTING'; tone = ''; }
    else if (state.link.status === 'error') { label = 'LINK ERROR'; tone = 'alert'; }
    else if (state.link.status === 'open' && !live) { label = state.replay.lines.length && !state.replay.playing ? 'REPLAY PAUSED' : 'NO FRAMES'; tone = 'alert'; }
    else if (live && state.tracks.size === 0) { label = 'NO CONTACT'; tone = 'running'; }
    else if (live) { label = state.mode === 'replay' ? 'REPLAY' : state.link.kind === 'synthetic' ? 'SYNTHETIC' : 'TRACKING'; tone = 'running'; }
    if (state.recording.active) { label = 'REC · ' + label; tone = 'recording'; }
    els.runStatus.className = 'status-pill' + (tone ? ' ' + tone : '');
    text('#run-status-label', label);
    text('#frame-tag', state.stats.frames ? state.stats.frames + ' frames · ' + state.stats.dropped + ' dropped' : '');
  }

  const ARROW_GLYPH = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';

  const SPEAKER_ON = '<svg class="ico" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4ZM16.5 8.5a5 5 0 0 1 0 7M19 6a8 8 0 0 1 0 12"/></svg>';
  const SPEAKER_OFF = '<svg class="ico" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4ZM17 9l5 6M22 9l-5 6"/></svg>';

  /**
   * Sound the alert on the edge into a drone being present, then repeat while it is
   * still there. Repeating on a timer rather than every frame keeps a contact that
   * flickers in and out from turning into a stutter.
   */
  function soundAlarm(droneUp) {
    const at = now();
    const alarm = state.alarm;
    const firstSight = droneUp && !alarm.droneUp;
    if (settings.sound && droneUp && (firstSight || at - alarm.lastAt > 2)) {
      if (sound.alert()) alarm.lastAt = at;
      else if (firstSight) note('Drone detected, but the browser has not allowed audio yet — click the page once.');
    }
    alarm.droneUp = droneUp;
  }

  function syncSound(play) {
    els.soundBtn.innerHTML = settings.sound ? SPEAKER_ON : SPEAKER_OFF;
    els.soundBtn.classList.toggle('muted', !settings.sound);
    els.soundBtn.title = settings.sound ? 'Alert sound on · click to mute' : 'Alert sound muted · click to turn on';
    els.soundBtn.setAttribute('aria-pressed', String(settings.sound));
    if (play && settings.sound) sound.alert();
  }

  /** The banner: what was found, and what to do about it. */
  function renderAlert() {
    const live = trackList().filter((track) => !track.stale && track.row);
    const threat = mostUrgent();
    if (!threat) { soundAlarm(false); els.threatAlert.hidden = true; return; }

    const drones = live.filter((track) => track.cls === 2);
    const isDrone = drones.length > 0;
    soundAlarm(isDrone);
    els.threatAlert.hidden = false;
    els.threatAlert.dataset.level = isDrone ? 'drone' : 'mover';

    const count = isDrone ? drones.length : live.length;
    text('#threat-title', (isDrone ? '드론 발견' : '이동체 발견') + (count > 1 ? ' ×' + count : ''));

    const row = threat.row;
    text('#threat-where', RL.fmt.distance(row.rangeM) + ' · 방위 ' + RL.fmt.bearing(row.bearingDeg, 1) +
      ' · ' + (row.closingMs > 0 ? '접근 ' : row.closingMs < 0 ? '이탈 ' : '정지 ') +
      Math.abs(row.closingMs).toFixed(2) + ' m/s');

    // The go-to vector, said as an instruction rather than as two more numbers.
    els.threatAction.innerHTML = ARROW_GLYPH +
      '<span><b>' + RL.fmt.heading(row.command.headingDeg) + '</b> 방향</span>' +
      '<span><b>' + row.command.speed.toFixed(1) + ' m/s</b></span>' +
      '<i class="sep"></i>' +
      (row.solved
        ? '<span><b>' + RL.fmt.duration(row.ttgS) + '</b> 후 요격</span>'
        : '<span class="chase">추적만 · 요격해 없음</span>');
  }

  function renderInspector(track) {
    const row = track && track.row;
    if (!row) {
      els.inspIcon.className = 'large-entity-icon';
      els.inspIcon.innerHTML = RADAR_GLYPH;
      text('#insp-name', 'No contact');
      els.inspBadge.className = 'type-badge';
      text('#insp-badge', '—');
      text('#insp-sub', 'Connect a transport, replay a log, or run the synthetic feed.');
      for (const id of ['#m-range', '#m-bearing', '#m-closing', '#m-ttg', '#m-cmd', '#m-corr', '#m-corr-delta']) text(id, '—');
      text('#m-cmd-note', ' ');
      text('#m-cmd-state', '');
      for (const id of ['#chk-speed', '#chk-heading', '#chk-reported', '#chk-intercept', '#chk-radial', '#chk-agree']) {
        const node = $(id); node.textContent = '—'; node.className = '';
      }
      text('#insp-wire', '—');
      return;
    }

    const key = track.klass.key;
    els.inspIcon.className = 'large-entity-icon ' + key;
    els.inspIcon.innerHTML = key === 'drone' ? DRONE_GLYPH : MOVER_GLYPH;
    text('#insp-name', '#' + track.idx + ' ' + track.klass.label);
    els.inspBadge.className = 'type-badge ' + (row.solved ? 'solved' : 'chase');
    text('#insp-badge', row.solved ? '요격 해 있음' : '쫓아가기만');
    text('#insp-sub', track.klass.korean + ' · cls ' + row.cls + ' · sol ' + row.sol + ' · ' +
      track.frames + ' rows, ' + (track.frames ? Math.round((track.solvedFrames / track.frames) * 100) : 0) + '% with a solution' +
      (track.stale ? ' · holding, no new row' : ''));

    text('#m-range', RL.fmt.distance(row.rangeM));
    text('#m-bearing', RL.fmt.bearing(row.bearingDeg));
    text('#m-closing', RL.fmt.rate(row.closingMs) + ' m/s');
    text('#m-ttg', row.solved ? RL.fmt.duration(row.ttgS) : '—');
    text('#m-cmd', RL.fmt.heading(row.command.headingDeg) + '  ·  ' + RL.fmt.speed(row.command.speed));
    text('#m-cmd-state', row.solved ? '' : 'chase');
    text('#m-corr', RL.fmt.heading(row.correctedHeadingDeg) + '  ·  ' + RL.fmt.speed(row.corrected.speed));
    text('#m-corr-delta', row.correctionMms.toFixed(0) + ' mm/s');

    const speedError = Math.abs(row.command.speed - settings.speed);
    const cmdNote = $('#m-cmd-note');
    cmdNote.textContent = 'x ' + row.wx + ', y ' + row.wy + ' mm/s' +
      (speedError > settings.speed * 0.02 ? ' · length is ' + RL.fmt.speed(row.command.speed) + ', setting is ' + RL.fmt.speed(settings.speed) : '');
    cmdNote.className = speedError > settings.speed * 0.02 ? 'warn' : '';

    const mark = (id, value, tone) => { const node = $(id); node.textContent = value; node.className = tone || ''; };
    mark('#chk-speed', RL.fmt.speed(row.command.speed), speedError <= settings.speed * 0.02 ? 'good' : 'warn');
    mark('#chk-heading', RL.fmt.bearing(row.command.headingDeg));
    const residual = Math.abs(row.headingResidualDeg);
    mark('#chk-reported', RL.fmt.bearing(row.correctedHeadingDeg) + ' (Δ ' + residual.toFixed(2) + '°)',
      residual < 0.05 ? 'good' : residual < 1 ? 'warn' : 'bad');
    if (row.solved) {
      mark('#chk-intercept', RL.fmt.distance(row.interceptRangeM));
      mark('#chk-radial', RL.fmt.distance(row.radialRangeM));
      const off = row.agreementM * 1000;
      mark('#chk-agree', off.toFixed(1) + ' mm apart', off < 10 ? 'good' : off < 50 ? 'warn' : 'bad');
    } else {
      mark('#chk-intercept', 'no solution');
      mark('#chk-radial', 'no solution');
      mark('#chk-agree', '요격까지 = ' + row.ttgMs, 'warn');
    }
    text('#insp-wire', row.text);
  }

  function renderStrips(track) {
    const at = now();
    const span = settings.window;
    const blank = { range: [], bearing: [], closing: [], ttg: [] };
    const series = track ? track.series : blank;
    strips.range.draw(series.range, at, span);
    strips.bearing.draw(series.bearing, at, span);
    strips.closing.draw(series.closing, at, span);
    strips.ttg.draw(series.ttg, at, span);
    const row = track && track.row;
    text('#strip-range-value', row ? RL.fmt.distance(row.rangeM) : '—');
    text('#strip-bearing-value', row ? RL.fmt.bearing(row.bearingDeg, 1) : '—');
    text('#strip-closing-value', row ? RL.fmt.rate(row.closingMs) + ' m/s' : '—');
    text('#strip-ttg-value', row && row.solved ? RL.fmt.duration(row.ttgS) : '—');
  }

  function renderLinkPane() {
    const stats = state.stats;
    const uptime = stats.firstAt == null ? '—' : RL.fmt.clock(now() - stats.firstAt);
    text('#link-uptime', uptime);
    text('#stat-frames', String(stats.frames));
    text('#stat-rate', rateHz() > 0 ? rateHz().toFixed(1) + ' Hz' : '—');
    const dropped = $('#stat-dropped');
    dropped.textContent = String(stats.dropped) + (stats.resyncs ? ' · ' + stats.resyncs + ' resync' : '');
    dropped.className = stats.dropped > 0 ? 'warn' : '';
    text('#stat-empty', String(stats.empty));
    const bad = $('#stat-bad');
    bad.textContent = String(stats.bad + stats.other);
    bad.className = stats.bad > 0 ? 'bad' : stats.other > 0 ? 'warn' : '';
    text('#stat-bytes', RL.fmt.bytes(stats.bytes || stats.chars));
    text('#foot-stats', stats.frames + ' frames · ' + stats.dropped + ' dropped');
    text('#foot-rate', rateHz() > 0 ? rateHz().toFixed(1) + ' Hz' : '— Hz');
  }

  // ── Range ────────────────────────────────────────────────
  function currentRange() {
    if (settings.rangeMode === 'fixed') return clamp(settings.range, 0.1, 400);
    let seen = 0;
    for (const track of state.tracks.values()) if (track.row) seen = Math.max(seen, track.row.rangeM);
    const target = Math.max(0.5, RL.niceRange(Math.max(seen, 0.2) * 1.3));
    state.autoRange += (target - state.autoRange) * 0.08;
    return clamp(state.autoRange, 0.1, 400);
  }

  function insets() {
    const wrap = els.viewport.getBoundingClientRect();
    const span = (element, side) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) return 0;
      return side === 'left' ? rect.right - wrap.left : side === 'right' ? wrap.right - rect.left : wrap.bottom - rect.top;
    };
    return {
      top: Math.max(24, els.hud.getBoundingClientRect().bottom - wrap.top + 16),
      left: span(els.dockLeft, 'left') + 16,
      right: span(els.dockRight, 'right') + 16,
      bottom: span(els.dockBottom, 'bottom') + 22,
    };
  }

  // ── Frame loop ───────────────────────────────────────────
  let lastTick = now(), lastUi = 0, frames = 0, fpsAt = now();
  function tick() {
    const at = now();
    const dt = Math.min(0.25, at - lastTick);
    lastTick = at;

    advanceReplay(dt);
    expireTracks();

    const maxRange = currentRange();
    const track = selectedTrack();
    scope.render({
      tracks: trackList(), selected: state.selected, maxRange,
      fovDeg: clamp(settings.fov, 20, 180), side: settings.side === 'left' ? -1 : 1,
      now: at, trailSeconds: settings.trail, insets: insets(),
      pulse: clamp(1 - (at - state.lastFrameAt) / 0.25, 0, 1),
      message: state.link.status === 'idle' ? 'NO LINK' : 'NO CONTACT',
    });

    frames++;
    if (at - fpsAt >= 1) { text('#fps', Math.round(frames / (at - fpsAt)) + ' FPS'); frames = 0; fpsAt = at; }

    if (at - lastUi > 1 / 20) {
      lastUi = at;
      renderHud(track);
      renderAlert();
      renderInspector(track);
      renderStrips(track);
      renderTrackList();
      renderLinkPane();
      if (state.recording.active) {
        text('#record-label', RL.fmt.clock(at - state.recording.startedAt) + ' · ' + state.recording.lines.length + ' lines');
      }
      const step = maxRange / 4;
      text('#scale-label', 'max ' + RL.fmt.distance(maxRange, 1) + ' · ring ' + RL.fmt.distance(step, 1) +
        (settings.rangeMode === 'auto' ? ' · auto' : ''));
    }
    requestAnimationFrame(tick);
  }

  // ── Interaction ──────────────────────────────────────────
  document.addEventListener('click', (event) => {
    sound.unlock();                      // audio may only start from a gesture
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action, value = target.dataset.value;

    if (action === 'mode') {
      state.mode = value;
      if (value === 'live') stopReplay();
      else { closeLink(); setLink('replay', state.replay.lines.length ? 'open' : 'idle', state.replay.name, state.replay.lines.length + ' lines'); }
      syncMode();
    } else if (action === 'connect') { connect(value); }
    else if (action === 'disconnect') { closeLink(); setLink(null, 'idle'); note('Disconnected.'); }
    else if (action === 'left-tab') {
      for (const button of document.querySelectorAll('[data-action=left-tab]')) button.classList.toggle('active', button === target);
      $('#pane-link').hidden = value !== 'link';
      $('#pane-tracks').hidden = value !== 'tracks';
    } else if (action === 'log-tab') {
      for (const button of document.querySelectorAll('[data-action=log-tab]')) button.classList.toggle('active', button === target);
      els.logList.hidden = value !== 'stream';
      els.problemList.hidden = value !== 'problems';
    } else if (action === 'dock') {
      state.docks[value] = !state.docks[value];
      const dock = value === 'left' ? els.dockLeft : value === 'right' ? els.dockRight : els.dockBottom;
      dock.classList.toggle('collapsed', !state.docks[value]);
      document.documentElement.dataset[value + 'Dock'] = state.docks[value] ? 'open' : 'closed';
    } else if (action === 'select') {
      state.selected = Number(value);
      state.autoSelect = false;
    } else if (action === 'play') {
      if (!state.replay.lines.length) { loadSample(); return; }
      state.mode = 'replay'; syncMode(); closeLink();
      state.replay.playing = !state.replay.playing;
      if (state.replay.playing) setLink('replay', 'open', state.replay.name, state.replay.lines.length + ' lines at ' + settings.interval + ' ms');
      syncReplayUi();
    } else if (action === 'step') {
      if (!state.replay.lines.length) { loadSample(); return; }
      state.mode = 'replay'; syncMode();
      state.replay.playing = false;
      stepReplay(1);
    } else if (action === 'rewind') {
      state.replay.index = 0; state.replay.carry = 0;
      resetStream(true); syncReplayUi();
    } else if (action === 'load-sample') { loadSample(); }
    else if (action === 'open-file') { els.fileInput.click(); }
    else if (action === 'clear-log') {
      els.logList.innerHTML = ''; els.problemList.innerHTML = '';
      state.logCount = 0; state.problems = 0;
      text('#log-count', '0'); text('#problem-count', '0');
    } else if (action === 'sound') {
      settings.sound = !settings.sound;
      saveSettings();
      syncSound(settings.sound);         // play it once when turning it on, as a check
      toast(settings.sound ? 'Drone alert sound on.' : 'Drone alert sound muted.');
    }
    else if (action === 'record') { if (!state.recording.active) startRecording(); }
    else if (action === 'record-stop') { stopRecording(); }
    else if (action === 'export') { exportCapture(); }
    else if (action === 'settings') { openSettings(); }
    else if (action === 'help') { els.helpDialog.showModal(); }
  });

  els.scope.addEventListener('click', (event) => {
    const rect = els.scope.getBoundingClientRect();
    const hit = scope.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (hit === null) { state.autoSelect = true; }
    else { state.selected = hit; state.autoSelect = false; }
  });

  els.scope.addEventListener('wheel', (event) => {
    event.preventDefault();
    if (settings.rangeMode === 'auto') { settings.rangeMode = 'fixed'; settings.range = state.autoRange; }
    settings.range = clamp(settings.range * Math.pow(1.12, event.deltaY > 0 ? 1 : -1), 0.1, 400);
    saveSettings();
  }, { passive: false });

  els.replayScrub.addEventListener('input', () => {
    state.replay.index = clamp(Number(els.replayScrub.value), 0, state.replay.lines.length);
    state.replay.carry = 0;
    resetStream(true);
    syncReplayUi();
  });
  els.replaySpeed.addEventListener('change', () => { state.replay.speed = Number(els.replaySpeed.value) || 1; });
  els.replayLoop.addEventListener('change', () => { state.replay.loop = els.replayLoop.checked; });

  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (!file) return;
    file.text().then((content) => loadReplay(content, file.name));
    els.fileInput.value = '';
  });

  // Dropping a log anywhere on the page replays it.
  document.addEventListener('dragover', (event) => { event.preventDefault(); });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) file.text().then((content) => loadReplay(content, file.name));
  });

  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (document.querySelector('dialog[open]')) return;
    const tracks = trackList();
    if (event.code === 'Space') { event.preventDefault(); $('[data-action=play]').click(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); $('[data-action=step]').click(); }
    else if (event.key === 'r' || event.key === 'R') { $('[data-action=rewind]').click(); }
    else if (event.key === 'a' || event.key === 'A') { settings.rangeMode = 'auto'; saveSettings(); toast('Range: auto fit'); }
    else if (event.key === 'Escape') { state.autoSelect = true; }
    else if (event.key >= '1' && event.key <= '9') {
      const chosen = tracks[Number(event.key) - 1];
      if (chosen) { state.selected = chosen.idx; state.autoSelect = false; }
    }
  });

  // ── Sample log and export ────────────────────────────────
  /* The rows the board printed on 2026-10-11 08:16, 1.1 s of a bench run. */
  const SAMPLE = [
    'G,183,1,1,1,349,-4859,-711,81,3307,-3751,3307,-3750,-4859',
    'G,184,1,1,1,305,-5138,948,51,3122,-3906,3122,-3907,-5138',
    'G,185,1,1,1,305,-5754,948,51,2683,-4219,2684,-4219,-5754',
    'G,186,1,1,1,305,6104,711,53,2420,4375,2420,4375,6104',
    'G,187,1,1,1,305,-5434,948,51,2914,-4063,2915,-4063,-5434',
    'G,188,1,1,1,305,-1081,948,51,4911,-938,4912,-938,-1081',
    'G,189,-1',
    'G,190,1,1,1,349,-4859,-711,81,3306,-3751,3308,-3751,-4859',
    'G,191,1,1,1,305,1081,948,51,4911,938,4912,938,1081',
    'G,192,1,1,1,305,-5434,948,51,2914,-4063,2915,-4063,-5434',
    'G,193,1,1,1,305,-5138,711,53,3121,-3906,3121,-3907,-5138',
  ];

  function loadSample() {
    // Prefer the file on disk so an edited sample-log.csv is what plays.
    fetch('sample-log.csv').then((response) => {
      if (!response.ok) throw new Error('not available');
      return response.text();
    }).then((content) => loadReplay(content, 'sample-log.csv'))
      .catch(() => loadReplay(SAMPLE.join('\n'), 'built-in sample (11 lines)'));
  }

  const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  /** Write lines out as a .csv the page can read back in. */
  function saveLines(lines, filename, headerLines) {
    const body = headerLines.map((line) => '# ' + line).join('\n') + '\n' + lines.join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const sourceLabel = () => (KIND_LABEL[state.link.kind] || 'no link') + (state.link.name ? ' · ' + state.link.name : '');

  function exportCapture() {
    if (!state.capture.length) { toast('Nothing received yet.'); return; }
    saveLines(state.capture, 'radar-link-' + stampNow() + '.csv', [
      'radar-link capture ' + new Date().toISOString() + ' · ' + sourceLabel(),
      state.capture.length + ' lines' + (state.captureTruncated ? ', truncated at ' + CAPTURE_LIMIT : ''),
    ]);
    toast('Saved ' + state.capture.length + ' lines' + (state.captureTruncated ? ' (truncated)' : ''));
  }

  function startRecording() {
    state.recording = { active: true, startedAt: now(), startedWall: new Date(), lines: [], frames: state.stats.frames, truncated: false };
    els.recordBtn.classList.add('active');
    els.recordStop.disabled = false;
    note('Recording started.');
    toast('Recording. Press Stop & save to write the file.');
  }

  function stopRecording() {
    const rec = state.recording;
    if (!rec.active) return;
    rec.active = false;
    els.recordBtn.classList.remove('active');
    els.recordStop.disabled = true;
    text('#record-label', 'Record');

    const seconds = now() - rec.startedAt;
    if (!rec.lines.length) {
      note('Recording stopped after ' + RL.fmt.clock(seconds) + ' with no lines — nothing to save.');
      toast('No lines arrived, so nothing was saved.');
      return;
    }
    saveLines(rec.lines, 'radar-link-rec-' + stampNow() + '.csv', [
      'radar-link recording · ' + sourceLabel(),
      'started ' + rec.startedWall.toISOString() + ', ran ' + RL.fmt.clock(seconds),
      rec.lines.length + ' lines, ' + (state.stats.frames - rec.frames) + ' frames' +
        (rec.truncated ? ', truncated at ' + RECORD_LIMIT : ''),
    ]);
    note('Recording saved: ' + rec.lines.length + ' lines over ' + RL.fmt.clock(seconds) + '.');
    toast('Saved ' + rec.lines.length + ' lines (' + RL.fmt.clock(seconds) + ').');
  }

  // ── Settings dialog ──────────────────────────────────────
  const FORM = {
    rangeMode: '#set-range-mode', range: '#set-range', fov: '#set-fov', side: '#set-side',
    trail: '#set-trail', hold: '#set-hold', speed: '#set-speed', window: '#set-window',
    baud: '#set-baud', bridgeUrl: '#set-bridge', bleService: '#set-ble-service',
    bleNotify: '#set-ble-notify', interval: '#set-interval',
  };

  function fillSettingsForm() {
    for (const key in FORM) $(FORM[key]).value = settings[key];
    $('#set-ble-all').value = settings.bleShowAll ? 'all' : 'service';
  }

  function readSettingsForm() {
    const next = Object.assign({}, settings);
    const number = (key, low, high) => {
      const value = Number($(FORM[key]).value);
      if (Number.isFinite(value)) next[key] = clamp(value, low, high);
    };
    next.rangeMode = $(FORM.rangeMode).value === 'fixed' ? 'fixed' : 'auto';
    next.side = $(FORM.side).value === 'left' ? 'left' : 'right';
    number('range', 0.1, 400); number('fov', 20, 180); number('trail', 0, 60);
    number('hold', 100, 10000); number('speed', 0.1, 100); number('window', 2, 120);
    number('baud', 1200, 2000000); number('interval', 1, 5000);
    next.bridgeUrl = $(FORM.bridgeUrl).value.trim() || DEFAULTS.bridgeUrl;
    next.bleService = $(FORM.bleService).value.trim() || DEFAULTS.bleService;
    next.bleNotify = $(FORM.bleNotify).value.trim() || DEFAULTS.bleNotify;
    next.bleShowAll = $('#set-ble-all').value === 'all';
    settings = next;
    saveSettings();
    applySettings();
  }

  function applySettings() {
    text('#baud-label', String(settings.baud));
    text('#bridge-label', settings.bridgeUrl);
    syncReplayUi();
  }

  function openSettings() { fillSettingsForm(); els.settingsDialog.showModal(); }
  $('#set-apply').addEventListener('click', () => { readSettingsForm(); els.settingsDialog.close(); toast('Settings applied.'); });
  $('#set-reset').addEventListener('click', () => { settings = Object.assign({}, DEFAULTS); saveSettings(); fillSettingsForm(); applySettings(); toast('Settings reset.'); });

  // ── Start ────────────────────────────────────────────────
  function describeSupport() {
    const missing = [];
    if (!RL.support.bluetooth) missing.push('Web Bluetooth');
    if (!RL.support.serial) missing.push('Web Serial');
    if (!missing.length && RL.support.secure) { els.supportNote.hidden = true; return; }
    els.supportNote.hidden = false;

    // A page served from another machine cannot reach devices by design. That is the
    // normal case for watching someone else's board, so say so rather than warn.
    const remote = location.protocol === 'http:' && !/^(localhost|127\.|\[?::1)/.test(location.hostname);
    els.supportNote.innerHTML = remote
      ? 'This page came from <b>' + location.hostname + '</b>, so it cannot open a device on your machine — ' +
        'only the machine holding the board can. Use the <b>Python bridge</b>, which is what that machine is running.'
      : (missing.length ? '<b>' + missing.join(' and ') + '</b> ' + (missing.length > 1 ? 'are' : 'is') +
          ' not available in this browser. ' : '') +
        (!RL.support.secure ? 'The page is not in a secure context, which also blocks device access. ' : '') +
        'Serve this folder over <b>http://localhost</b> in Chrome, or use the <b>Python bridge</b>.';
  }

  for (const side of ['left', 'right', 'bottom']) document.documentElement.dataset[side + 'Dock'] = 'open';
  applySettings();
  syncSound(false);
  describeSupport();
  syncMode();
  syncReplayUi();
  setLink(null, 'idle');
  note('Radar Link ready. Pick a transport, or press Space to replay the sample log.');
  requestAnimationFrame(tick);
})();
