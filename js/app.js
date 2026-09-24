// ditherfield - the app: one page for phone and desktop, built like a hardware controller (an instrument, not a
// settings list): icon tab bar, one section on screen at a time, relative faders (no jump on touch, double-tap =
// the seed's value, long-press = number + LFO), segmented controls instead of dropdowns, relative XY pads, saved
// pieces as select-then-act with two-tap confirms. The engine runs on the device itself, so the phone needs no PC.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  // memory-backed storage: if the browser blocks storage the app still works for the visit
  var mem = {};
  var PERSIST = (function () { try { localStorage.setItem('df._', '1'); localStorage.removeItem('df._'); return true; } catch (e) { return false; } })();
  var store = {
    get: function (k, d) { if (k in mem) return JSON.parse(mem[k]); try { var v = localStorage.getItem('df.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { mem[k] = JSON.stringify(v); try { localStorage.setItem('df.' + k, mem[k]); } catch (e) { } }
  };
  var IN_ARTIFACT = !!(window.claude && window.claude.use);
  var FRAMED = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  // host capabilities (the private claude.ai page): asked at once, so the wait overlaps font loading
  var DB = null, DL = null, dbSettled = !IN_ARTIFACT;
  var dbReady = IN_ARTIFACT ? window.claude.use('db').then(function (d) { DB = d || null; dbSettled = true; return DB; }, function () { dbSettled = true; return null; }) : Promise.resolve(null);
  var dlReady = IN_ARTIFACT ? window.claude.use('downloads').then(function (d) { DL = d || null; return DL; }, function () { return null; }) : Promise.resolve(null);

  var engine, piece, f = 0, t0 = 0, playing = true, live = new DF.Live(), rafTimes = [], lastDraw = 0;
  var tab = store.get('tab', 'play'), sectionOf = store.get('sections', {}), panelOpen = true, saveTimer = 0;
  var hot = {}, dirty = false, lost = false, wantSound = false;
  var GEOMETRY = { grid: 1, aspect: 1, sortAng: 1, bars: 1, step: 1, hitLen: 1, procOut: 1, procPass: 1 };

  function vib(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { } }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(function () { t.classList.remove('on'); }, 2000); }
  function plainInput(i) { i.setAttribute('autocorrect', 'off'); i.setAttribute('autocapitalize', 'off'); i.spellcheck = false; i.autocomplete = 'off'; return i; }

  // ---------------------------------------------------------------- the piece, and undo
  function apply(geometry) {
    dirty = true;
    if (!lost) { engine.setPiece(piece); if (geometry) fit(); }
    if (live.running()) live.piece = piece;
    scheduleHistory();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var st = DF.encodeState(piece);
      store.set('current', st);
      if (!IN_ARTIFACT) try { history.replaceState(null, '', '#' + st); } catch (e) { }
    }, 400);
  }
  function refreshHot(k) { (hot[k] || []).forEach(function (fn) { fn(); }); }
  function setDial(k, v, geometry) {
    var nv = DF.clampParam(k, v); if (nv === piece.v[k]) return false;
    piece.v[k] = nv; refreshHot(k); apply(geometry || GEOMETRY[k]); return true;
  }
  function load(p, fromUndo) {
    if (!fromUndo) { clearTimeout(histT); commitHistory(); }
    var keep = piece ? { clip: piece.v.clip, clipWhole: piece.v.clipWhole } : null;   // your clip length outlives a new seed
    piece = p;
    if (keep && !fromUndo && p.__fresh) { piece.v.clip = keep.clip; piece.v.clipWhole = keep.clipWhole; }
    delete piece.__fresh;
    f = 0; t0 = performance.now(); if (engine) engine.procF = -2;
    apply(true); render();
    if (!fromUndo) { clearTimeout(histT); commitHistory(); }
    if (live.running()) live.anchor(0);
  }
  function fresh(seed) { var p = DF.pieceFromSeed(seed); p.__fresh = true; return p; }
  function seedValue(k) { return DF.pieceFromSeed(piece.seed).v[k]; }
  var hist = [], histCur = null, histT = 0;
  function commitHistory() {
    var s = DF.encodeState(piece); if (s === histCur) return;
    if (histCur !== null) { hist.push(histCur); if (hist.length > 40) hist.shift(); }
    histCur = s; showUndo();
  }
  function scheduleHistory() { clearTimeout(histT); histT = setTimeout(commitHistory, 700); showUndo(); }
  function undo() {
    clearTimeout(histT);
    var now = DF.encodeState(piece), target = now !== histCur && histCur ? histCur : hist.pop();
    if (!target) { toast('nothing to undo'); return; }
    histCur = target;
    var d = DF.decodeState('#' + target); if (d.piece) load(d.piece, true);
    showUndo(); toast('undone'); vib(8);
  }
  function showUndo() { var b = $('undoBtn'); if (b) b.disabled = !hist.length && DF.encodeState(piece) === histCur; }

  // ---------------------------------------------------------------- layout: tabs -> sections -> widgets
  var ICON = {
    play: 'M8 5v14l11-7z',
    source: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18m0 4a5 5 0 1 0 0 10a5 5 0 1 0 0-10m0 4a1 1 0 1 0 0 2a1 1 0 1 0 0-2',
    sort: 'M4 6h16M4 10h12M4 14h8M4 18h4',
    colour: 'M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z',
    sound: 'M3 12h2l2-6 3 12 3-9 2 5 2-2h4',
    saved: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'
  };
  var TABS = [
    { id: 'play', l: 'play', sections: [
      { s: 'LIVE', w: [{ t: 'seed' }, { t: 'seg', k: 'sortMode' },
        { t: 'toggles', items: [['stOn', 'stripes'], ['rgOn', 'rings'], ['tyOn', 'type'], ['scan', 'scanlines', 60]] }, { t: 'reroll' },
        { t: 'xy', x: 'sortLo', y: 'sortMax', l: 'dark threshold  x  longest run  (drag sideways, or hold then move)' }] }] },
    { id: 'source', l: 'source', sections: [
      { s: 'STRIPES', w: [{ t: 'toggles', items: [['stOn', 'stripes on']] }, { t: 'fader', k: 'stAngle' }, { t: 'fader', k: 'stPeriod' }, { t: 'fader', k: 'stSpeed' },
        { t: 'fader', k: 'stGain' }, { t: 'fader', k: 'stCut' }, { t: 'seg', k: 'stMode' }] },
      { s: 'RINGS', w: [{ t: 'toggles', items: [['rgOn', 'rings on']] }, { t: 'fader', k: 'rgX' }, { t: 'fader', k: 'rgY' }, { t: 'fader', k: 'rgPeriod' },
        { t: 'fader', k: 'rgSpeed' }, { t: 'fader', k: 'rgCount' }, { t: 'fader', k: 'rgOrbit' }, { t: 'fader', k: 'rgOrbSpd' }, { t: 'fader', k: 'rgGain' },
        { t: 'fader', k: 'rgCut' }, { t: 'seg', k: 'rgMode' }, { t: 'xy', x: 'rgX', y: 'rgY', l: 'centre', invY: true }] },
      { s: 'TYPE', w: [{ t: 'toggles', items: [['tyOn', 'type on']] }, { t: 'text' }, { t: 'chips', k: 'tyFont' }, { t: 'fader', k: 'tySize' },
        { t: 'fader', k: 'tyTrack' }, { t: 'fader', k: 'tyX' }, { t: 'fader', k: 'tyY' }, { t: 'fader', k: 'tyVal' }, { t: 'seg', k: 'tyMode' }] },
      { s: 'FRAME', w: [{ t: 'fader', k: 'bg' }, { t: 'seg', k: 'aspect' }, { t: 'chips', k: 'grid' }] }] },
    { id: 'sort', l: 'sort', sections: [
      { s: 'MODE', w: [{ t: 'seg', k: 'sortMode' }, { t: 'fader', k: 'sortAng' }, { t: 'seg', k: 'sortTint' }] },
      { s: 'WINDOW', w: [{ t: 'fader', k: 'beatOpen' }, { t: 'fader', k: 'sortLo' }, { t: 'fader', k: 'sortHi' }, { t: 'fader', k: 'sortMax' }, { t: 'fader', k: 'sortAmt' }] },
      { s: 'BANDS', w: [{ t: 'fader', k: 'sortBands' }, { t: 'fader', k: 'sortSpread' }] },
      { s: 'MOTION', w: [{ t: 'fader', k: 'procPass' }, { t: 'fader', k: 'procOut' }, { t: 'fader', k: 'hitLen' }, { t: 'fader', k: 'sweepStag' }] }] },
    { id: 'colour', l: 'colour', sections: [
      { s: 'PALETTE', w: [{ t: 'palette', which: 'A' }, { t: 'palette', which: 'B' }, { t: 'layers' }] },
      { s: 'DITHER', w: [{ t: 'seg', k: 'dither' }, { t: 'seg', k: 'colMode' }, { t: 'fader', k: 'levels' }, { t: 'fader', k: 'spread' }, { t: 'seg', k: 'dithHome' }] },
      { s: 'MOVE', w: [{ t: 'fader', k: 'xfade' }, { t: 'fader', k: 'cycle' }, { t: 'fader', k: 'hue' }] },
      { s: 'POST', w: [{ t: 'fader', k: 'scan' }, { t: 'fader', k: 'curve' }, { t: 'fader', k: 'vignette' }] }] },
    { id: 'sound', l: 'sound', sections: [
      { s: 'STEPS', w: [{ t: 'steps' }, { t: 'fader', k: 'hitLen' }, { t: 'fader', k: 'beatOpen' }] },
      { s: 'VOICE', w: [{ t: 'seg', k: 'voice' }, { t: 'chips', k: 'scale' }, { t: 'fader', k: 'root' }, { t: 'fader', k: 'vol' }, { t: 'fader', k: 'thump' }] },
      { s: 'TIME', w: [{ t: 'fader', k: 'step' }, { t: 'fader', k: 'bars' }, { t: 'loopinfo' }] }] },
    { id: 'saved', l: 'saved', sections: [
      { s: 'PIECES', w: [{ t: 'saved' }] },
      { s: 'EXPORT', w: [{ t: 'clip' }, { t: 'export' }, { t: 'bench' }] }] }
  ];

  // ---------------------------------------------------------------- rendering the panel
  function render() {
    hot = {}; armed = null;
    var bar = $('tabs'); bar.innerHTML = '';
    TABS.forEach(function (T) {
      var b = el('button', 'tab' + (T.id === tab ? ' on' : '')); b.type = 'button'; b.setAttribute('aria-label', T.l);
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICON[T.id] + '"/></svg><span>' + T.l + '</span>';
      b.onclick = function () { tab = T.id; store.set('tab', tab); vib(5); if (!panelOpen) togglePanel(true); render(); };
      bar.appendChild(b);
    });
    var T = TABS.filter(function (x) { return x.id === tab; })[0] || TABS[0];
    var secs = $('secs'); secs.innerHTML = '';
    var cur = sectionOf[T.id] || T.sections[0].s;
    if (!T.sections.some(function (s) { return s.s === cur; })) cur = T.sections[0].s;
    if (T.sections.length > 1) T.sections.forEach(function (S) {
      var c = el('button', 'sec' + (S.s === cur ? ' on' : ''), S.s); c.type = 'button';
      c.onclick = function () { sectionOf[T.id] = S.s; store.set('sections', sectionOf); vib(4); render(); };
      secs.appendChild(c);
    });
    secs.hidden = T.sections.length < 2;
    var body = $('body'); body.innerHTML = '';
    var S = T.sections.filter(function (s) { return s.s === cur; })[0];
    S.w.forEach(function (w) { var node = WIDGETS[w.t](w); if (node) body.appendChild(node); });
  }
  function onHot(k, fn) { (hot[k] = hot[k] || []).push(fn); }
  function hasSource() { var v = piece.v; return v.stOn || v.rgOn || (v.tyOn && (piece.text || '').trim()); }

  var WIDGETS = {
    // relative fader: drag sideways from where it is (full range = at least 280 px of travel; move the finger 40 px
    // above or below the track for 4x finer steps); vertical swipes scroll; double-tap = seed value; long-press = editor
    fader: function (w) {
      var P = DF.PARAM[w.k], row = el('div', 'w fader-row'), name = el('span', 'lab', P.l), trk = el('div', 'track'), knob = el('i', 'knob'), fill = el('b', 'fill'), val = el('span', 'val');
      trk.appendChild(fill); trk.appendChild(knob); row.appendChild(name); row.appendChild(trk); row.appendChild(val);
      trk.setAttribute('role', 'slider'); trk.setAttribute('aria-label', P.l); trk.tabIndex = 0;
      trk.setAttribute('aria-valuemin', P.min); trk.setAttribute('aria-valuemax', P.max);
      function show() {
        var v = piece.v[w.k], x = (v - P.min) / (P.max - P.min);
        knob.style.left = (x * 100) + '%'; fill.style.width = (x * 100) + '%';
        val.textContent = v + (piece.mods && piece.mods[w.k] ? ' ~' : '');
        trk.setAttribute('aria-valuenow', v); row.classList.toggle('lfo', !!(piece.mods && piece.mods[w.k]));
      }
      show(); onHot(w.k, show);
      var start = null, lastTap = 0, pressT = 0;
      trk.addEventListener('pointerdown', function (e) {
        start = { x: e.clientX, y: e.clientY, v: piece.v[w.k], drag: false, id: e.pointerId, w: Math.max(280, trk.getBoundingClientRect().width), gain: 1 };
        clearTimeout(pressT);
        pressT = setTimeout(function () { if (start && !start.drag) { start = null; vib(12); editor(w.k); } }, 550);
      });
      trk.addEventListener('pointermove', function (e) {
        if (!start || e.pointerId !== start.id) return;
        var dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!start.drag) {
          if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { start = null; clearTimeout(pressT); return; }   // a scroll
          if (Math.abs(dx) < 6) return;
          start.drag = true; clearTimeout(pressT); try { trk.setPointerCapture(e.pointerId); } catch (x) { }
        }
        var gain = Math.abs(dy) > 40 ? 0.25 : 1;
        if (gain !== start.gain) { start.v = piece.v[w.k]; start.x = e.clientX; start.gain = gain; dx = 0; }
        var nv = Math.round((start.v + dx / start.w * (P.max - P.min) * gain) / P.st) * P.st;
        if (setDial(w.k, nv)) vib(3);
      });
      function end() {
        clearTimeout(pressT);
        if (start && !start.drag) {
          var now = performance.now();
          if (now - lastTap < 320) { setDial(w.k, seedValue(w.k)); vib(8); toast(P.l + ': back to the seed'); lastTap = 0; }
          else lastTap = now;
        }
        start = null;
      }
      trk.addEventListener('pointerup', end); trk.addEventListener('pointercancel', function () { clearTimeout(pressT); start = null; });
      trk.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      trk.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (d) { e.preventDefault(); setDial(w.k, piece.v[w.k] + d * P.st * (e.shiftKey ? 10 : 1)); }
        if (e.key === 'Enter') editor(w.k);
      });
      return row;
    },
    seg: function (w) {
      var P = DF.PARAM[w.k], box = el('div', 'w'), lab = el('div', 'lab', P.l), seg = el('div', 'seg');
      box.appendChild(lab); box.appendChild(seg);
      P.opts.forEach(function (o, i) { var b = el('button', '', o); b.type = 'button'; b.onclick = function () { setDial(w.k, i); vib(5); }; seg.appendChild(b); });
      function show() { Array.prototype.forEach.call(seg.children, function (b, i) { b.classList.toggle('on', i === piece.v[w.k]); b.setAttribute('aria-pressed', i === piece.v[w.k]); }); }
      show(); onHot(w.k, show); return box;
    },
    chips: function (w) {
      var P = DF.PARAM[w.k], box = el('div', 'w'), lab = el('div', 'lab', P.l), row = el('div', 'chips');
      box.appendChild(lab); box.appendChild(row);
      P.opts.forEach(function (o, i) { var b = el('button', 'chip', o); b.type = 'button'; b.onclick = function () { setDial(w.k, i, w.k === 'grid'); vib(5); }; row.appendChild(b); });
      function show() { Array.prototype.forEach.call(row.children, function (b, i) { b.classList.toggle('on', i === piece.v[w.k]); }); }
      show(); onHot(w.k, show); return box;
    },
    toggles: function (w) {
      var box = el('div', 'w toggles');
      w.items.forEach(function (it) {
        var k = it[0], b = el('button', 'tog', it[1]); b.type = 'button';
        var isOpt = !!DF.PARAM[k].opts;
        function isOn() { return isOpt ? piece.v[k] === 1 : piece.v[k] > 0; }
        function show() { b.classList.toggle('on', isOn()); b.setAttribute('aria-pressed', isOn()); }
        b.onclick = function () {
          if (isOn()) { if (!isOpt) store.set('lastOn.' + k, piece.v[k]); setDial(k, 0); }
          else setDial(k, isOpt ? 1 : store.get('lastOn.' + k, it[2]));        // back to the level you had
          vib(6);
          if (!hasSource()) toast('no source on: nothing to sort');
        };
        show(); onHot(k, show); box.appendChild(b);
      });
      return box;
    },
    // XY pad, relative like the faders: drag sideways to start (or hold 250 ms, then move any way); a vertical swipe
    // scrolls the panel; double-tap = both dials back to the seed
    xy: function (w) {
      var box = el('div', 'w'), lab = el('div', 'lab', w.l), pad = el('div', 'xy'), dot = el('i'), rd = el('span', 'xyval');
      pad.appendChild(dot); pad.appendChild(rd); box.appendChild(lab); box.appendChild(pad);
      pad.setAttribute('aria-label', w.l); pad.setAttribute('role', 'group');
      var PX = DF.PARAM[w.x], PY = DF.PARAM[w.y], s = null, holdT = 0, lastTap = 0;
      function show() {
        var x = (piece.v[w.x] - PX.min) / (PX.max - PX.min), y = (piece.v[w.y] - PY.min) / (PY.max - PY.min);
        dot.style.left = (x * 100) + '%'; dot.style.top = ((w.invY ? y : 1 - y) * 100) + '%';
        rd.textContent = piece.v[w.x] + ' / ' + piece.v[w.y];
      }
      function arm(e) { if (!s || s.armed) return; s.armed = true; pad.classList.add('armed'); vib(6); try { pad.setPointerCapture(s.id); } catch (x) { } }
      pad.addEventListener('pointerdown', function (e) {
        var r = pad.getBoundingClientRect();
        s = { x: e.clientX, y: e.clientY, vx: piece.v[w.x], vy: piece.v[w.y], w: r.width, h: r.height, armed: false, id: e.pointerId };
        clearTimeout(holdT); holdT = setTimeout(arm, 250);
      });
      pad.addEventListener('pointermove', function (e) {
        if (!s || e.pointerId !== s.id) return;
        var dx = e.clientX - s.x, dy = e.clientY - s.y;
        if (!s.armed) {
          if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { s = null; clearTimeout(holdT); return; }   // a scroll
          if (Math.abs(dx) < 6) return;
          clearTimeout(holdT); arm();
        }
        var a = setDial(w.x, s.vx + dx / s.w * (PX.max - PX.min)), b = setDial(w.y, s.vy + (w.invY ? dy : -dy) / s.h * (PY.max - PY.min));
        if (a || b) vib(2);
      });
      pad.addEventListener('touchmove', function (e) { if (s && s.armed) e.preventDefault(); }, { passive: false });
      function end() {
        clearTimeout(holdT); pad.classList.remove('armed');
        if (s && !s.armed) {
          var now = performance.now();
          if (now - lastTap < 320) { setDial(w.x, seedValue(w.x)); setDial(w.y, seedValue(w.y)); vib(8); toast('back to the seed'); lastTap = 0; }
          else lastTap = now;
        }
        s = null;
      }
      pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', function () { clearTimeout(holdT); pad.classList.remove('armed'); s = null; });
      show(); onHot(w.x, show); onHot(w.y, show); return box;
    },
    seed: function () {
      var box = el('div', 'w seedbox'), inp = plainInput(el('input')), row = el('div', 'btns');
      inp.value = piece.seed; inp.setAttribute('aria-label', 'seed: paste any hash, address or words');
      var make = el('button', 'btn', 'make'), dice = el('button', 'btn hi', 'dice');
      make.type = dice.type = 'button';
      make.onclick = function () { load(fresh(inp.value)); vib(10); };
      dice.onclick = function () { load(fresh(DF.seed.random())); vib(10); };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') make.click(); });
      row.appendChild(dice); row.appendChild(make);
      box.appendChild(inp); box.appendChild(row); return box;
    },
    // new values for one part of the piece, from a fresh random seed; the rest stays (undo brings it back)
    reroll: function () {
      var box = el('div', 'w'), lab = el('div', 'lab', 'new, keep the rest'), row = el('div', 'btns wrap');
      box.appendChild(lab); box.appendChild(row);
      var GROUPS = { source: ['bg', 'stOn', 'stAngle', 'stPeriod', 'stSpeed', 'stGain', 'stCut', 'stMode', 'rgOn', 'rgX', 'rgY', 'rgPeriod', 'rgSpeed', 'rgGain', 'rgCut', 'rgMode', 'rgCount', 'rgOrbit', 'rgOrbSpd'],
        sort: ['sortMode', 'sortAng', 'sortLo', 'sortHi', 'sortMax', 'sortBands', 'sortSpread', 'sortAmt', 'procOut', 'procPass', 'sweepStag', 'sortTint'],
        colour: ['palA', 'palB', 'colMode', 'dither', 'cycle'], rhythm: ['hitLen', 'scale', 'root', 'voice'] };
      Object.keys(GROUPS).forEach(function (g) {
        var b = el('button', 'btn', g); b.type = 'button';
        b.onclick = function () {
          clearTimeout(histT); commitHistory();
          var other = DF.pieceFromSeed(DF.seed.random());
          GROUPS[g].forEach(function (k) { piece.v[k] = other.v[k]; });
          if (g === 'colour') { piece.palA = other.palA; piece.palB = other.palB; piece.layerPal = other.layerPal; }
          if (g === 'rhythm') piece.seq = other.seq;
          if (g === 'source' && !hasSource()) piece.v.rgOn = 1;
          vib(10); apply(true); render(); clearTimeout(histT); commitHistory();
        };
        row.appendChild(b);
      });
      return box;
    },
    text: function () {
      var box = el('div', 'w'), lab = el('div', 'lab', 'text  ( / = new line )'), inp = plainInput(el('input'));
      inp.value = piece.text || ''; inp.setAttribute('aria-label', 'text');
      inp.addEventListener('input', function () { piece.text = inp.value; apply(false); });
      box.appendChild(lab); box.appendChild(inp); return box;
    },
    palette: function (w) { return paletteWidget(w.which); },
    layers: function () {
      var box = el('div', 'w'), lab = el('div', 'lab', 'which palette each layer uses'), row = el('div', 'toggles');
      box.appendChild(lab); box.appendChild(row);
      ['ground', 'stripes', 'rings', 'type'].forEach(function (n, i) {
        var b = el('button', 'tog'); b.type = 'button';
        function show() { var v = (piece.layerPal || [0, 0, 0, 0])[i]; b.textContent = n + ' ' + (v ? 'B' : 'A'); b.classList.toggle('on', !!v); }
        b.onclick = function () { piece.layerPal = (piece.layerPal || [0, 0, 0, 0]).slice(); piece.layerPal[i] ^= 1; show(); apply(false); vib(5); };
        show(); row.appendChild(b);
      });
      var sorted = el('button', 'tog'); sorted.type = 'button';
      function showS() { sorted.textContent = 'sorted pixels ' + (piece.v.sortTint ? 'B' : 'same'); sorted.classList.toggle('on', !!piece.v.sortTint); }
      sorted.onclick = function () { setDial('sortTint', piece.v.sortTint ? 0 : 1); showS(); vib(5); };
      showS(); row.appendChild(sorted);
      return box;
    },
    steps: function () {
      var box = el('div', 'w steps');
      piece.seq = piece.seq || { hits: 0, notes: [] };
      [['sort hits', 'hits'], ['notes', 'notes']].forEach(function (lane) {
        var lab = el('div', 'lab', lane[0] + (lane[1] === 'notes' ? '  (tap up, long-press down)' : '')), row = el('div', 'lane');
        box.appendChild(lab); box.appendChild(row);
        for (var s = 0; s < 16; s++) (function (s) {
          var b = el('button', 'cell' + (s % 4 === 0 ? ' beat' : '')); b.type = 'button'; b.dataset.step = s;
          function show() {
            if (lane[1] === 'hits') { var on = !!(piece.seq.hits & (1 << s)); b.classList.toggle('on', on); b.textContent = on ? '●' : ''; }
            else { var n = piece.seq.notes[s] || 0; b.classList.toggle('on', !!n); b.textContent = n || ''; }
            b.setAttribute('aria-label', lane[0] + ' step ' + (s + 1));
          }
          var pt = 0, long = false;
          b.addEventListener('pointerdown', function () { long = false; pt = setTimeout(function () { long = true; if (lane[1] === 'notes') { piece.seq.notes[s] = ((piece.seq.notes[s] || 0) + 8) % 9; show(); apply(false); vib(10); } }, 450); });
          b.addEventListener('pointerup', function () { clearTimeout(pt); });
          b.addEventListener('pointercancel', function () { clearTimeout(pt); });
          b.onclick = function () {
            if (long) return;
            if (lane[1] === 'hits') piece.seq.hits ^= (1 << s); else piece.seq.notes[s] = ((piece.seq.notes[s] || 0) + 1) % 9;
            show(); apply(true); vib(4);
          };
          b.oncontextmenu = function (e) { e.preventDefault(); };
          show(); row.appendChild(b);
        })(s);
      });
      return box;
    },
    loopinfo: function () {
      var box = el('div', 'w note');
      function show() {
        var v = piece.v, L = DF.loopFrames(v), bpm = 3600 / (v.step * 4);
        box.textContent = 'one loop = ' + v.bars + ' bar' + (v.bars > 1 ? 's' : '') + ' x 16 steps x ' + v.step + ' frames = ' + (L / 60).toFixed(2) + ' s  (' + bpm.toFixed(1) + ' bpm in 16ths)';
      }
      show(); onHot('step', show); onHot('bars', show); return box;
    },
    // clip length lives in the piece (dials clip / clipWhole), so a length set on the phone reaches the desktop export
    clip: function () {
      var box = el('div', 'w'), lab = el('div', 'lab', canMP4() ? 'clip length' : 'clip length (for the desktop export, kept with the piece)');
      var row = el('div', 'btns'), val = el('span', 'val big');
      var minus = el('button', 'btn', '-'), plus = el('button', 'btn', '+'), whole = el('button', 'tog', 'whole loops');
      minus.type = plus.type = whole.type = 'button'; minus.setAttribute('aria-label', 'shorter'); plus.setAttribute('aria-label', 'longer');
      function show() {
        var v = piece.v, L = DF.loopFrames(v), frames = clipFrames(v), n = frames / L;
        val.textContent = (frames / 60).toFixed(2) + ' s' + (v.clipWhole ? '  = ' + n + (n === 1 ? ' loop' : ' loops') + (frames > v.clip * 60 + 1 ? ' (one loop is ' + (L / 60).toFixed(1) + ' s)' : '') : '  (cuts mid-loop)');
        whole.classList.toggle('on', !!v.clipWhole); minus.disabled = v.clipWhole ? n <= 1 : v.clip <= 1;
      }
      minus.onclick = function () {
        var v = piece.v, L = DF.loopFrames(v);
        if (v.clipWhole) setDial('clip', Math.max(1, Math.round((clipFrames(v) / L - 1) * L / 60))); else setDial('clip', v.clip - 1);
        show();
      };
      plus.onclick = function () {
        var v = piece.v, L = DF.loopFrames(v);
        if (v.clipWhole) setDial('clip', Math.min(60, Math.ceil((clipFrames(v) / L + 1) * L / 60))); else setDial('clip', v.clip + 1);
        show();
      };
      whole.onclick = function () { setDial('clipWhole', piece.v.clipWhole ? 0 : 1); show(); };
      row.appendChild(minus); row.appendChild(val); row.appendChild(plus); row.appendChild(whole);
      box.appendChild(lab); box.appendChild(row); show(); ['step', 'bars', 'clip', 'clipWhole'].forEach(function (k) { onHot(k, show); }); return box;
    },
    export: function () {
      var box = el('div', 'w'), row = el('div', 'btns wrap'), out = el('div', 'note', '');
      out.id = 'exportOut';
      var mp4 = el('button', 'btn hi', 'export MP4'), png = el('button', 'btn', 'save PNG'), link = el('button', 'btn', 'copy link');
      mp4.type = png.type = link.type = 'button'; mp4.id = 'exportMp4'; png.id = 'savePng'; link.id = 'copyLink';
      if (!canMP4()) { mp4.disabled = true; mp4.textContent = 'MP4: on the desktop studio'; }
      if (IN_ARTIFACT && !DF.PUBLIC_BASE) link.hidden = true;           // no public address yet
      dlReady.then(function (d) { if (IN_ARTIFACT && FRAMED && !d) { png.hidden = true; out.textContent = 'saving files is not available in this view'; } });
      mp4.onclick = exportMP4; png.onclick = savePNG; link.onclick = copyLink;
      row.appendChild(mp4); row.appendChild(png); row.appendChild(link);
      box.appendChild(row); box.appendChild(out); return box;
    },
    bench: function () {
      var box = el('div', 'w'), b = el('button', 'btn', 'benchmark this device (15 s)'); b.type = 'button';
      b.onclick = function () { bench(); };
      box.appendChild(b); box.appendChild(el('div', 'note', 'runs the three sort modes 4 s each and shows the frame rate' + (IN_ARTIFACT ? '; the numbers are kept for Claude' : '')));
      return box;
    },
    saved: function () { return savedWidget(); }
  };
  function canMP4() { return !!(window.Mp4Muxer && DF.exportMP4 && 'VideoEncoder' in window && 'AudioEncoder' in window); }
  function clipFrames(v) { var L = DF.loopFrames(v); return v.clipWhole ? Math.max(1, Math.ceil(v.clip * 60 / L - 1e-9)) * L : Math.round(v.clip * 60); }

  // ---------------------------------------------------------------- number + LFO editor (long-press a fader)
  function editor(k) {
    var P = DF.PARAM[k], sh = $('sheet'), b = $('sheetBody'); b.innerHTML = '';
    $('sheetTitle').textContent = P.l;
    var row = el('div', 'btns'), num = el('input'); num.type = 'number'; num.min = P.min; num.max = P.max; num.step = P.st; num.value = piece.v[k];
    if (P.min >= 0) num.inputMode = 'numeric';             // the iPhone digit pad has no minus key
    num.setAttribute('aria-label', P.l);
    num.onchange = function () {
      if (num.value === '' || !isFinite(num.valueAsNumber)) { num.value = piece.v[k]; return; }
      setDial(k, num.valueAsNumber); num.value = piece.v[k];
    };
    var minus = el('button', 'btn', '-'), plus = el('button', 'btn', '+'), dflt = el('button', 'btn', 'seed value');
    minus.type = plus.type = dflt.type = 'button';
    minus.onclick = function () { setDial(k, piece.v[k] - P.st); num.value = piece.v[k]; };
    plus.onclick = function () { setDial(k, piece.v[k] + P.st); num.value = piece.v[k]; };
    dflt.onclick = function () { setDial(k, seedValue(k)); num.value = piece.v[k]; };
    row.appendChild(minus); row.appendChild(num); row.appendChild(plus);
    if (P.min < 0) { var pm = el('button', 'btn', '±'); pm.type = 'button'; pm.setAttribute('aria-label', 'flip the sign'); pm.onclick = function () { setDial(k, -piece.v[k]); num.value = piece.v[k]; }; row.appendChild(pm); }
    row.appendChild(dflt);
    b.appendChild(row);
    b.appendChild(el('div', 'note', P.min + ' to ' + P.max + (DF.MODULATABLE.indexOf(k) >= 0 ? '' : '   (no LFO on this one)')));
    if (DF.MODULATABLE.indexOf(k) >= 0) {
      var lfo = el('div', 'lfo'); b.appendChild(lfo);
      var drawL = function () {
        lfo.innerHTML = '';
        var m = piece.mods && piece.mods[k];
        var on = el('button', 'tog' + (m ? ' on' : ''), m ? 'LFO on' : 'LFO off'); on.type = 'button';
        on.onclick = function () { piece.mods = piece.mods || {}; if (piece.mods[k]) delete piece.mods[k]; else piece.mods[k] = { shape: 0, rate: 1, depth: 30, phase: 0 }; apply(false); refreshHot(k); drawL(); };
        lfo.appendChild(on);
        if (!m) return;
        var seg = el('div', 'seg');
        DF.SHAPES.forEach(function (s, i) { var x = el('button', i === m.shape ? 'on' : '', s); x.type = 'button'; x.onclick = function () { m.shape = i; apply(false); drawL(); }; seg.appendChild(x); });
        lfo.appendChild(seg);
        [['rate', 1, 16, 'cycles per loop'], ['depth', 0, 100, '% of the range'], ['phase', 0, 255, 'start point']].forEach(function (d) {
          var r = el('div', 'btns'), lab = el('span', 'lab', d[0]), m1 = el('button', 'btn', '-'), v = el('span', 'val', m[d[0]]), p1 = el('button', 'btn', '+'), hint = el('span', 'note', d[3]);
          m1.type = p1.type = 'button';
          var stp = d[0] === 'rate' ? 1 : d[0] === 'depth' ? 5 : 16;
          m1.onclick = function () { m[d[0]] = Math.max(d[1], m[d[0]] - stp); v.textContent = m[d[0]]; apply(false); };
          p1.onclick = function () { m[d[0]] = Math.min(d[2], m[d[0]] + stp); v.textContent = m[d[0]]; apply(false); };
          r.appendChild(lab); r.appendChild(m1); r.appendChild(v); r.appendChild(p1); r.appendChild(hint); lfo.appendChild(r);
        });
      };
      drawL();
    }
    openSheet();
  }
  function openSheet() { var sh = $('sheet'); sh.hidden = false; sh.openedAt = performance.now(); setTimeout(function () { sh.classList.add('on'); }, 10); }
  function closeSheet() { var sh = $('sheet'); sh.classList.remove('on'); setTimeout(function () { sh.hidden = true; }, 200); }

  // ---------------------------------------------------------------- palette: stops strip, tap one to edit, presets, paste
  function paletteWidget(which) {
    var key = 'pal' + which, box = el('div', 'w pal'), head = el('div', 'lab', 'palette ' + which);
    var strip = el('div', 'stops'), ed = el('div', 'stopedit'), presets = el('div', 'chips'), acts = el('div', 'btns wrap');
    box.appendChild(head); box.appendChild(strip); box.appendChild(ed); box.appendChild(presets); box.appendChild(acts);
    var sel = -1;
    function stops() { return piece[key]; }
    function set(s) { if (s.length < 2 || s.length > 16) return; piece[key] = s; apply(false); draw(); }
    function draw() {
      strip.innerHTML = '';
      stops().forEach(function (h, i) {
        var b = el('button', 'stop' + (i === sel ? ' sel' : '')); b.type = 'button'; b.style.background = h; b.setAttribute('aria-label', 'colour ' + (i + 1) + ' ' + h);
        b.onclick = function () { sel = sel === i ? -1 : i; vib(4); draw(); };
        strip.appendChild(b);
      });
      ed.innerHTML = '';
      if (sel >= 0 && sel < stops().length) {
        var hex = plainInput(el('input')); hex.value = stops()[sel]; hex.setAttribute('aria-label', 'hex');
        hex.onchange = function () { var c = DF.colour.parseList(hex.value)[0]; if (c) { var a = stops().slice(); a[sel] = c; set(a); } };
        ed.appendChild(hex);
        // one HSV triple per selection: hue and saturation survive a trip through black or grey
        var hsv = DF.colour.rgbToHsv(DF.hex(stops()[sel]));
        [['hue', 0, 359, hsv[0]], ['saturation', 0, 100, hsv[1] * 100], ['value', 0, 100, hsv[2] * 100]].forEach(function (d, di) {
          ed.appendChild(miniFader(d[0], d[1], d[2], Math.round(d[3]), function (x) {
            hsv[di] = di === 0 ? x : x / 100;
            var a = stops().slice(); a[sel] = DF.colour.toHex(DF.colour.hsvToRgb(hsv[0], hsv[1], hsv[2])); piece[key] = a; apply(false);
            strip.children[sel].style.background = a[sel]; hex.value = a[sel];
          }));
        });
        var r = el('div', 'btns'), left = el('button', 'btn', '<'), right = el('button', 'btn', '>'), dup = el('button', 'btn', '+ copy'), del = el('button', 'btn', 'remove');
        left.type = right.type = dup.type = del.type = 'button'; left.setAttribute('aria-label', 'move left'); right.setAttribute('aria-label', 'move right');
        left.onclick = function () { if (sel > 0) { var a = stops().slice(), t = a[sel - 1]; a[sel - 1] = a[sel]; a[sel] = t; sel--; set(a); } };
        right.onclick = function () { if (sel < stops().length - 1) { var a = stops().slice(), t = a[sel + 1]; a[sel + 1] = a[sel]; a[sel] = t; sel++; set(a); } };
        dup.onclick = function () { var a = stops().slice(); a.splice(sel + 1, 0, a[sel]); sel++; set(a); };
        del.onclick = function () { var a = stops().slice(); a.splice(sel, 1); sel = Math.min(sel, a.length - 1); set(a); };
        dup.disabled = stops().length >= 16; del.disabled = stops().length <= 2;
        [left, right, dup, del].forEach(function (x) { r.appendChild(x); }); ed.appendChild(r);
      }
      presets.innerHTML = '';
      var saved = store.get('palettes', {});
      DF.PALETTE_NAMES.concat(Object.keys(saved)).forEach(function (n) {
        var c = el('button', 'chip'), sw = el('i', 'sw'); c.type = 'button';
        var st = DF.PRESETS[n] ? DF.PRESETS[n].stops : saved[n];
        sw.style.background = 'linear-gradient(90deg,' + st.map(function (h, i) { return h + ' ' + (i / st.length * 100) + '%,' + h + ' ' + ((i + 1) / st.length * 100) + '%'; }).join(',') + ')';
        c.appendChild(sw); c.appendChild(document.createTextNode(n));
        c.onclick = function () {
          clearTimeout(histT); commitHistory(); set(st.slice()); vib(5);
          if (which === 'A' && n === 'TD8') setDial('colMode', 2); else if (which === 'A' && piece.v.colMode === 2 && DF.PRESETS[n]) setDial('colMode', 0);
        };
        presets.appendChild(c);
      });
      acts.innerHTML = '';
      var rev = el('button', 'btn', 'reverse'), dl = el('button', 'btn', 'dark to light'), sv = el('button', 'btn', 'save palette'), paste = plainInput(el('input'));
      rev.type = dl.type = sv.type = 'button';
      rev.onclick = function () { set(stops().slice().reverse()); };
      dl.onclick = function () { set(DF.colour.sortByLight(stops())); };
      sv.onclick = function () { var s2 = store.get('palettes', {}); var n = 'mine ' + (Object.keys(s2).length + 1); s2[n] = stops().slice(); store.set('palettes', s2); toast('saved as ' + n); draw(); };
      paste.placeholder = 'paste hex codes'; paste.setAttribute('aria-label', 'paste hex codes');
      paste.addEventListener('change', function () { var l = DF.colour.parseList(paste.value); if (l.length >= 2) { set(l); toast(l.length + ' colours'); } else toast('need 2 or more colours'); paste.value = ''; });
      var fi = el('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.hidden = true;
      var img = el('button', 'btn', 'from image'); img.type = 'button'; img.onclick = function () { fi.click(); };
      fi.onchange = function () {
        var file = fi.files[0]; fi.value = '';
        if (file) createImageBitmap(file).then(function (bmp) { set(DF.colour.fromImage(bmp, Math.max(2, stops().length))); toast('palette from image'); }, function () { toast('could not read that image'); });
      };
      [rev, dl, sv, img, fi, paste].forEach(function (x) { acts.appendChild(x); });
    }
    draw(); return box;
  }
  function miniFader(name, min, max, v, on) {
    var row = el('div', 'w fader-row'), lab = el('span', 'lab', name), trk = el('div', 'track'), knob = el('i', 'knob'), fill = el('b', 'fill'), val = el('span', 'val', v);
    trk.appendChild(fill); trk.appendChild(knob); row.appendChild(lab); row.appendChild(trk); row.appendChild(val);
    function show() { var x = (v - min) / (max - min); knob.style.left = x * 100 + '%'; fill.style.width = x * 100 + '%'; val.textContent = v; }
    var st = null;
    trk.addEventListener('pointerdown', function (e) { st = { x: e.clientX, y: e.clientY, v: v, drag: false, w: Math.max(280, trk.getBoundingClientRect().width) }; });
    trk.addEventListener('pointermove', function (e) {
      if (!st) return; var dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.drag) { if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { st = null; return; } if (Math.abs(dx) < 6) return; st.drag = true; try { trk.setPointerCapture(e.pointerId); } catch (x) { } }
      var nv = Math.max(min, Math.min(max, Math.round(st.v + dx / st.w * (max - min)))); if (nv !== v) { v = nv; show(); on(v); }
    });
    trk.addEventListener('pointerup', function () { st = null; }); trk.addEventListener('pointercancel', function () { st = null; });
    trk.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    show(); return row;
  }

  // ---------------------------------------------------------------- saved pieces: select, then act. db when hosted, else this browser
  var savedList = [], savedSel = null, armed = null, armT = 0, migrated = false;
  // one retry for a passing hiccup; the rest is reported
  function once(fn) {
    return fn().catch(function (e) {
      var c = e && e.code;
      if (!c || c === 'unavailable') return new Promise(function (r) { setTimeout(r, 600 + Math.random() * 800); }).then(fn);
      throw e;
    });
  }
  var queue = {};
  var Saved = {
    list: function () {
      return dbReady.then(function () {
        // snapshots are frozen: copy each body before anything edits it
        if (DB) return once(function () { return DB.collection('pieces').orderBy('created', 'desc').get(); }).then(function (snap) {
          return snap.docs.map(function (d) { var x = Object.assign({}, d.data()); x.id = d.id; return x; });
        });
        return store.get('saved', []);
      });
    },
    // writes to one piece go one at a time, in order
    put: function (p) {
      var body = JSON.parse(JSON.stringify(p));
      return (queue[p.id] = (queue[p.id] || Promise.resolve()).catch(function () { }).then(function () {
        return dbReady.then(function () {
          if (DB) return once(function () { return DB.doc('pieces/' + p.id).set(body); });
          var l = store.get('saved', []).filter(function (x) { return x.id !== p.id; }); l.unshift(body); store.set('saved', l);
        });
      }));
    },
    del: function (id) {
      return dbReady.then(function () {
        if (DB) return once(function () { return DB.doc('pieces/' + id).delete(); });
        store.set('saved', store.get('saved', []).filter(function (x) { return x.id !== id; }));
      });
    },
    // pieces kept in this browser before the private page's db was there move into it, one by one
    migrate: function () {
      if (!DB || migrated) return Promise.resolve(); migrated = true;
      var l = store.get('saved', []);
      return l.reduce(function (pr, p) {
        return pr.then(function () { return DB.doc('pieces/' + p.id).set(p).then(function () { store.set('saved', store.get('saved', []).filter(function (x) { return x.id !== p.id; })); }, function () { }); });
      }, Promise.resolve());
    }
  };
  var thumbs = {}, thumbEngine = null;
  function thumbFor(state) {
    if (thumbs[state]) return thumbs[state];
    var d = DF.decodeState('#' + state.replace(/^#/, '')); if (!d.piece) return null;
    if (!thumbEngine || thumbEngine.gl.isContextLost()) thumbEngine = new DF.Engine(document.createElement('canvas'), { k: 1 });
    thumbEngine.setPiece(d.piece); thumbEngine.procF = -2; thumbEngine.frame(DF.peakFrame(d.piece));
    return (thumbs[state] = thumbEngine.canvas.toDataURL('image/png'));
  }
  function thumbOf(p, cb) {
    if (p.thumb) return cb(p.thumb);
    if (thumbs[p.state]) return cb(thumbs[p.state]);
    setTimeout(function () { try { var u = thumbFor(p.state); if (u) cb(u); } catch (e) { } }, 0);
  }
  function disarm() { armed = null; clearTimeout(armT); }
  function savedWidget() {
    var box = el('div', 'w saved'), top = el('div', 'btns'), grid = el('div', 'grid'), acts = el('div', 'acts');
    var quick = el('button', 'btn hi', 'save this piece'); quick.type = 'button';
    var where = el('span', 'note');
    function whereText() {
      where.textContent = DB ? 'kept in your private page (Claude can read your notes)' : !dbSettled ? 'connecting...' :
        PERSIST ? 'kept in this browser' : 'kept until this page closes (this browser blocks storage)';
    }
    whereText(); dbReady.then(function () { whereText(); });
    top.appendChild(quick); top.appendChild(where);
    box.appendChild(top); box.appendChild(grid); box.appendChild(acts);
    quick.onclick = function () {
      var st = DF.encodeState(piece), p = { id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), state: st, seed: piece.seed,
        created: Date.now(), verdict: '', note: '', star: false, device: /iPhone|iPad|Android/.test(navigator.userAgent) ? 'phone' : 'desktop' };
      try { p.thumb = thumbFor(st); } catch (e) { }
      if (!DB && !dbSettled) toast('saving...');
      Saved.put(p).then(function () { savedSel = p.id; toast('saved'); vib(12); draw(); }, function (e) { toast('could not save: ' + (e && (e.code || e.message) || e)); });
    };
    function draw() {
      disarm();
      Saved.list().then(function (l) {
        savedList = l.slice().sort(function (a, b) { return (b.star - a.star) || (b.created - a.created); });
        grid.innerHTML = '';
        if (!savedList.length) grid.appendChild(el('div', 'note', 'Nothing saved yet. Save a piece you like, then mark it keep / maybe / drop.'));
        savedList.forEach(function (p) {
          var t = el('button', 'thumb' + (p.id === savedSel ? ' sel' : '') + (p.star ? ' star' : '')); t.type = 'button';
          var im = el('img'); im.alt = p.seed.slice(0, 10); t.appendChild(im);
          t.appendChild(el('span', 'tag', (p.verdict || '') + (p.note ? ' *' : '')));
          thumbOf(p, function (u) { im.src = u; });
          t.onclick = function () { savedSel = savedSel === p.id ? null : p.id; disarm(); vib(4); draw(); };
          grid.appendChild(t);
        });
        drawActs();
      }, function (e) {
        grid.innerHTML = ''; acts.innerHTML = '';
        var c = e && e.code;
        if (c === 'revoked') { grid.appendChild(el('div', 'note', 'saved pieces are not available here')); return; }
        var retry = el('button', 'btn', 'could not reach your saved pieces - tap to retry'); retry.type = 'button'; retry.onclick = draw; grid.appendChild(retry);
      });
    }
    function fail(what, restore) { return function (e) { if (restore) restore(); toast('could not ' + what + ': ' + (e && (e.code || e.message) || e)); draw(); }; }
    function drawActs() {
      acts.innerHTML = '';
      var p = savedList.filter(function (x) { return x.id === savedSel; })[0]; if (!p) return;
      var armFor = function (what) { armed = { id: p.id, what: what }; clearTimeout(armT); armT = setTimeout(function () { armed = null; if (acts.isConnected) drawActs(); }, 3000); vib(8); drawActs(); };
      var isArmed = function (what) { return armed && armed.id === p.id && armed.what === what; };
      var r1 = el('div', 'btns wrap');
      var ld = el('button', 'btn hi', 'load'), st = el('button', 'btn' + (p.star ? ' gold' : ''), p.star ? 'starred' : 'star'),
          ow = el('button', 'btn', isArmed('ow') ? 'tap again to save over' : 'save here'),
          dl = el('button', 'btn', isArmed('del') ? 'tap again to delete' : 'delete');
      [ld, st, ow, dl].forEach(function (b) { b.type = 'button'; r1.appendChild(b); });
      ld.onclick = function () { disarm(); var d = DF.decodeState('#' + p.state); if (d.piece) { load(d.piece); toast('loaded'); } };
      st.onclick = function () { disarm(); var was = p.star; p.star = !p.star; Saved.put(p).then(draw, fail('star', function () { p.star = was; })); };
      ow.onclick = function () {
        var now = DF.encodeState(piece);
        if (now === p.state) { toast('already saved'); return; }
        if (!isArmed('ow')) return armFor('ow');
        disarm();
        var prev = { state: p.state, seed: p.seed, thumb: p.thumb };
        p.state = now; p.seed = piece.seed; p.updated = Date.now(); try { p.thumb = thumbFor(now); } catch (e) { }
        Saved.put(p).then(function () { toast('saved over'); draw(); }, fail('save over', function () { p.state = prev.state; p.seed = prev.seed; p.thumb = prev.thumb; }));
      };
      dl.onclick = function () {
        if (!isArmed('del')) return armFor('del');
        disarm(); Saved.del(p.id).then(function () { savedSel = null; draw(); }, fail('delete'));
      };
      var r2 = el('div', 'seg verdict');
      ['keep', 'maybe', 'drop'].forEach(function (v) {
        var b = el('button', p.verdict === v ? 'on' : '', v); b.type = 'button';
        b.onclick = function () { disarm(); var was = p.verdict; p.verdict = p.verdict === v ? '' : v; p.updated = Date.now(); Saved.put(p).then(draw, fail('save the verdict', function () { p.verdict = was; })); vib(6); };
        r2.appendChild(b);
      });
      var note = el('textarea'); note.rows = 2; note.placeholder = (IN_ARTIFACT ? 'a note for Claude' : 'a note') + ': what works, what does not'; note.value = p.note || ''; note.setAttribute('aria-label', 'note');
      note.setAttribute('autocorrect', 'on');
      var noteT = 0;
      var saveNote = function () { clearTimeout(noteT); if (note.value === (p.note || '')) return; p.note = note.value; p.updated = Date.now(); Saved.put(p).then(function () { toast('note saved'); }, fail('save the note')); };
      note.addEventListener('focus', disarm);
      note.addEventListener('input', function () { clearTimeout(noteT); noteT = setTimeout(saveNote, 900); });
      note.addEventListener('change', saveNote);
      acts.appendChild(r1); acts.appendChild(r2); acts.appendChild(note);
      acts.appendChild(el('div', 'note mono', p.seed));
    }
    dbReady.then(function (d) { if (d) Saved.migrate().then(draw); });
    draw(); return box;
  }

  // ---------------------------------------------------------------- export (desktop Chrome; PNG anywhere)
  function clone(p) { return JSON.parse(JSON.stringify(p)); }
  function out(msg) { var o = $('exportOut'); if (o) o.textContent = msg; toast(msg); }
  function exportEngine(p) {
    var cv = document.createElement('canvas'), dims = DF.gridSize(p.v), k = Math.max(1, Math.round(1080 / dims[0]));
    var e = new DF.Engine(cv, { k: k }); e.setPiece(p); return { e: e, cv: cv };
  }
  function fileTag(p) { return p.seed.slice(0, 10).replace(/[^A-Za-z0-9_-]+/g, '-'); }
  // inside the claude.ai viewer the host asks you to confirm the save; elsewhere a plain browser download
  async function saveFile(blob, name) {
    var dl = IN_ARTIFACT ? (DL || await dlReady) : null;
    if (dl) { await dl.save({ filename: name, data: blob }); return 'saved'; }
    if (IN_ARTIFACT && FRAMED) throw new Error('saving files is not available in this view');
    DF.saveBlob(blob, name); return 'download started';
  }
  async function exportMP4() {
    var btn = $('exportMp4'); if (!btn || btn.disabled) return; btn.disabled = true;
    var p = clone(piece), X = exportEngine(p), frames = clipFrames(p.v), rows = {};
    try {
      var r = await DF.exportMP4({
        canvas: X.cv, width: X.cv.width, height: X.cv.height, fps: 60, frames: frames,
        draw: function (i) { X.e.frame(i); if (p.v.voice === 1 && i % p.v.step === 0) rows[i] = X.e.readRow(X.e.rowForStep((i / p.v.step) % 16)); },
        audio: function () { out('rendering sound...'); return DF.renderSound(p, frames, rows); },
        onProgress: function (q) { var o = $('exportOut'); if (o) o.textContent = 'encoding ' + Math.round(q * 100) + '%'; }
      });
      var name = 'ditherfield_' + fileTag(p) + '_' + DF.stamp() + '.mp4';
      var how = await saveFile(r.blob, name);
      r.info.seconds = +(frames / 60).toFixed(2); r.info.name = name; window.DF_LAST_EXPORT = r.info;
      out(how + ': ' + name + ' (' + r.info.width + 'x' + r.info.height + ', ' + r.info.seconds + ' s)');
    } catch (e) { window.DF_LAST_EXPORT = { error: String(e && e.message || e) }; out('export failed: ' + (e && (e.code || e.message) || e)); }
    var lc = X.e.gl.getExtension('WEBGL_lose_context'); if (lc) lc.loseContext();
    btn.disabled = false;
  }
  function savePNG() {
    var p = clone(piece), X = exportEngine(p), n = Math.max(0, f - 1);
    X.e.frame(n);
    X.cv.toBlob(function (b) {
      var name = 'ditherfield_' + fileTag(p) + '_f' + n + '.png';
      saveFile(b, name).then(function (how) { out(how + ': ' + name); }, function (e) { out('could not save: ' + (e && (e.code || e.message) || e)); });
      var lc = X.e.gl.getExtension('WEBGL_lose_context'); if (lc) lc.loseContext();
    }, 'image/png');
  }
  function copyLink() {
    var link = (DF.PUBLIC_BASE || (IN_ARTIFACT ? '' : location.href.split('#')[0])) + '#' + DF.encodeState(piece);
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { out('link copied'); }, function () { out(link); });
    else out(link);
  }

  // ---------------------------------------------------------------- canvas, loop, sound, lost GPU
  function fit() {
    if (lost) return;
    var box = $('stage').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    var k = Math.max(1, Math.floor(Math.min(box.width * dpr / engine.W, box.height * dpr / engine.H)));
    engine.setScale(k);
    var cv = $('cv'); cv.style.width = (engine.W * k / dpr) + 'px'; cv.style.height = (engine.H * k / dpr) + 'px';
  }
  function togglePanel(open) {
    panelOpen = open == null ? !panelOpen : open;
    document.body.classList.toggle('full', !panelOpen);
    requestAnimationFrame(fit);
  }
  function syncSoundBtn() {
    var b = $('soundBtn'), on = live.running();
    b.classList.toggle('on', on); b.classList.toggle('wait', wantSound && !on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function startSound() {
    live.start(piece, f, function (k) { if (piece.v.voice === 1 && !lost) live.synth.setRow(engine.readRow(engine.rowForStep(k))); });
    live.ctx.onstatechange = syncSoundBtn;
    syncSoundBtn();
  }
  function toggleSound() {
    if (live.running()) { wantSound = false; live.stop(); t0 = performance.now() - f * 1000 / 60; }
    else { wantSound = true; startSound(); }
    syncSoundBtn(); vib(8);
  }
  function tick(now) {
    requestAnimationFrame(tick);
    if (lost || engine.gl.isContextLost()) { $('fps').textContent = 'resuming...'; return; }
    if (!playing) { if (dirty) { dirty = false; engine.frame(Math.max(0, f - 1)); } return; }
    var target = live.running() ? live.frameAt() : Math.floor((now - t0) * 60 / 1000);
    if (target < f) return;
    if (target - f > 30) {                                // a stall or an app switch: carry on from here, don't race
      if (live.running()) live.anchor(f); else t0 = now - f * 1000 / 60;
      target = f;
    }
    if (lastDraw) { rafTimes.push(now - lastDraw); if (rafTimes.length > 90) rafTimes.shift(); }
    lastDraw = now;
    f = Math.max(f, target);
    engine.frame(f); dirty = false;
    var step = Math.floor(f / piece.v.step) % 16;
    var cells = document.querySelectorAll('.lane .cell');
    for (var i = 0; i < cells.length; i++) cells[i].classList.toggle('now', +cells[i].dataset.step === step);
    f++;
  }
  function showFps() {
    if (lost || !rafTimes.length) return;
    var m = rafTimes.reduce(function (a, b) { return a + b; }, 0) / rafTimes.length;
    $('fps').textContent = playing ? Math.round(1000 / m) + ' fps' : 'paused';
  }
  // the GPU can be taken away (iOS does it to background pages): rebuild the engine when it comes back
  function rebuild(canvas) {
    var view = engine ? engine.view : 'final', k = engine ? engine.k : 3;
    engine = new DF.Engine(canvas || $('cv'), { k: k }); engine.view = view; window.DF_ENGINE = engine;
    engine.setPiece(piece); engine.procF = -2; lost = false; dirty = true; thumbEngine = null; thumbs = {};
    fit();
  }
  function watchCanvas(cv) {
    cv.addEventListener('webglcontextlost', function (e) { e.preventDefault(); lost = true; });
    cv.addEventListener('webglcontextrestored', function () { rebuild(cv); });
  }
  function recoverIfLost() {
    if (!(lost || (engine && engine.gl.isContextLost()))) return;
    var old = $('cv'), nc = old.cloneNode(false);             // a fresh canvas gets a fresh context
    old.parentNode.replaceChild(nc, old); watchCanvas(nc); rebuild(nc);
  }

  // ---------------------------------------------------------------- benchmark: 3 sort modes, 4 s each, results on screen
  var benching = false;
  async function bench() {
    if (benching) return; benching = true;
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var before = DF.encodeState(piece), wasPlaying = playing; playing = true;
    var p = DF.pieceFromSeed('0x3fa9c1d2e4b5a6978877665544332211ffeeddccbbaa99887766554433221100');
    p.v.stOn = 1; p.v.rgOn = 1; p.v.rgCount = 3; p.v.rgOrbit = 25; p.v.tyOn = 1; p.v.sortMax = 180; p.v.sortLo = 20; p.v.sortHi = 255; p.v.procPass = 4; p.seq.hits = 0;
    load(p);
    var gl = engine.gl, ri = gl.getExtension('WEBGL_debug_renderer_info');
    var res = { at: new Date().toISOString(), device: { ua: navigator.userAgent, dpr: window.devicePixelRatio, screen: screen.width + 'x' + screen.height,
      renderer: ri ? gl.getParameter(ri.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), host: IN_ARTIFACT ? 'claude.ai page' : location.protocol }, modes: {} };
    for (var m = 1; m <= 3; m++) {
      setDial('sortMode', m); toast('benchmark: ' + DF.PARAM.sortMode.opts[m]);
      await wait(800); rafTimes.length = 0; engine.timers.hist = {};
      await wait(4000);
      var ft = rafTimes.slice().sort(function (a, b) { return a - b; }), mean = ft.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, ft.length);
      var g = engine.timers.stats(), gpu = 0; Object.keys(g).forEach(function (k) { gpu += g[k].mean; });
      res.modes[DF.PARAM.sortMode.opts[m]] = { fps: +(1000 / mean).toFixed(1), frame_p95_ms: +(ft[Math.floor(ft.length * 0.95)] || 0).toFixed(1),
        gpu_ms: engine.timers.ext ? +gpu.toFixed(3) : null, grid: engine.W + 'x' + engine.H + ' x' + engine.k, visible: document.visibilityState };
    }
    window.DF_BENCH = res;
    var d = DF.decodeState('#' + before); if (d.piece) load(d.piece, true);
    playing = wasPlaying;
    // on screen, and kept: the db of the private page (Claude reads it) or the PC server when served from it
    var b = $('sheetBody'); b.innerHTML = ''; $('sheetTitle').textContent = 'benchmark';
    Object.keys(res.modes).forEach(function (k) { var x = res.modes[k]; b.appendChild(el('div', 'mono', k + ': ' + x.fps + ' fps, worst frames ' + x.frame_p95_ms + ' ms' + (x.gpu_ms != null ? ', gpu ' + x.gpu_ms + ' ms' : '') + ', ' + x.grid)); });
    b.appendChild(el('div', 'note', res.device.renderer + ', ' + res.device.screen + ' @' + res.device.dpr));
    var kept = el('div', 'note', ''); b.appendChild(kept);
    openSheet();
    var body = JSON.stringify(res, null, 1);
    var db = IN_ARTIFACT ? (DB || await dbReady) : null;
    if (db) db.doc('bench/b' + Date.now().toString(36)).set(res).then(function () { kept.textContent = 'kept for Claude'; }, function () { kept.textContent = 'could not keep the numbers'; });
    else fetch('report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function (r) { kept.textContent = r.ok ? 'sent to the PC' : ''; }, function () { });
    benching = false;
  }

  // ---------------------------------------------------------------- start
  async function start() {
    var BENCH = /[?&]bench/.test(location.search) || location.hash === '#bench';
    await DF.loadFonts();
    var dec = DF.decodeState(location.hash);
    if (!dec.piece) { var cur = store.get('current', null); if (cur) dec = DF.decodeState('#' + cur); }
    piece = dec.piece || DF.pieceFromSeed(DF.seed.random());
    engine = new DF.Engine($('cv'), { k: 3 }); watchCanvas($('cv'));
    window.DF_ENGINE = engine; window.DF_PIECE = function () { return piece; };
    window.DF_STUDIO = {
      show: function (seed, n, view) {
        if (seed) load(DF.pieceFromSeed(seed));
        if (view) engine.view = view;
        playing = false; $('playBtn').classList.remove('on');
        if (n < 0) n = DF.peakFrame(piece);
        engine.procF = -2; engine.frame(n); f = n + 1; dirty = false;
        return { seed: piece.seed, hash: engine.hash(), v: piece.v, frame: n, state: DF.encodeState(piece) };
      },
      load: function (hash) { var d = DF.decodeState(hash); if (d.piece) load(d.piece); return d.warning || 'ok'; },
      tab: function (id, sec) { tab = id; if (sec) sectionOf[id] = sec; render(); },
      lose: function () { var x = engine.gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); return !!x; },
      restore: function () { recoverIfLost(); }
    };
    histCur = DF.encodeState(piece);
    apply(true); render(); showUndo();
    if (dec.warning) toast(dec.warning);
    $('stage').addEventListener('click', function (e) { if (e.target.id === 'cv' || e.target.id === 'stage') togglePanel(); });
    $('soundBtn').onclick = toggleSound;
    $('undoBtn').onclick = undo;
    $('playBtn').onclick = function () {
      playing = !playing; $('playBtn').classList.toggle('on', playing);
      t0 = performance.now() - f * 1000 / 60; if (playing && live.running()) live.anchor(f);
      vib(6);
    };
    $('sheetClose').onclick = closeSheet;
    // the click that ends a long-press lands on the backdrop: ignore backdrop taps right after opening
    $('sheet').addEventListener('click', function (e) { if (e.target.id === 'sheet' && performance.now() - ($('sheet').openedAt || 0) > 500) closeSheet(); });
    window.addEventListener('resize', fit);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      syncSoundBtn();
      setTimeout(recoverIfLost, 1500);
    });
    window.addEventListener('pageshow', function () { setTimeout(recoverIfLost, 1500); });
    // sound you asked for comes back with your next tap (iOS suspends it when you leave the app)
    document.addEventListener('pointerdown', function () { if (wantSound && !live.running() && live.ctx) startSound(); }, true);
    document.addEventListener('touchstart', function () { }, { passive: true });       // lets iOS show :active
    if (!IN_ARTIFACT) window.addEventListener('hashchange', function () { var d = DF.decodeState(location.hash); if (d.piece && DF.encodeState(d.piece) !== DF.encodeState(piece)) load(d.piece); });
    t0 = performance.now();
    requestAnimationFrame(tick);
    setInterval(showFps, 700);
    if (BENCH) bench();
  }
  window.addEventListener('DOMContentLoaded', function () {
    start().catch(function (e) { $('fps').textContent = 'failed: ' + e.message; console.error(e); });
  });
})();
