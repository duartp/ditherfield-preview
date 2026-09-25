// ditherfield - modulation and the step clock. Everything here is a pure function of (piece, frame), so the live
// studio, the phone and the MP4 export compute exactly the same values. Rates count cycles per loop: loops stay exact.
(function () {
  DF.SHAPES = ['sine', 'triangle', 'saw', 'square', 'steps'];
  // dials an LFO may drive (the ones read fresh every frame; geometry and modes stay put)
  DF.MODULATABLE = ['bg', 'stPeriod', 'stGain', 'stCut', 'rgX', 'rgY', 'rgPeriod', 'rgGain', 'rgCut', 'rgOrbit',
    'tySize', 'tyX', 'tyY', 'tyTrack', 'tyVal', 'sortLo', 'sortHi', 'sortMax', 'sortSpread', 'sortAmt', 'sweepStag', 'beatOpen',
    'xfade', 'spread', 'hue', 'scan', 'vignette', 'stAngle'];

  function hash32(x) { x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return (x ^ (x >>> 16)) >>> 0; }
  // wave value in -32767..32767 at 16-bit phase ph, whole numbers only
  function wave(shape, ph, cycleIndex, salt) {
    ph &= 0xFFFF;
    if (shape === 0) return DF.isin(ph);
    if (shape === 1) return ph < 32768 ? ph * 2 - 32767 : 32767 - (ph - 32768) * 2;
    if (shape === 2) return ph - 32768 + (ph >= 32768 ? 1 : 0);
    if (shape === 3) return ph < 32768 ? 32767 : -32767;
    return (hash32(cycleIndex * 7919 + salt) % 65535) - 32767;          // steps: a held random value per cycle
  }

  DF.loopFrames = function (v) { return v.bars * 16 * v.step; };

  // piece.mods = { dialKey: { shape, rate (cycles per loop), depth (0..100, % of the dial range), phase (0..255) } }
  DF.effective = function (piece, f) {
    var v = piece.v, mods = piece.mods;
    if (!mods || !Object.keys(mods).length) return v;
    var L = DF.loopFrames(v), lf = ((f % L) + L) % L, out = {};
    for (var k in v) out[k] = v[k];
    Object.keys(mods).forEach(function (k, i) {
      var m = mods[k], P = DF.PARAM[k]; if (!P || P.opts) return;
      var cyc = m.rate * lf, ph = Math.floor(cyc * 65536 / L) + m.phase * 256, ci = Math.floor(cyc / L);
      var w = wave(m.shape, ph, ci, i * 131 + 7);
      var half = (P.max - P.min) * m.depth / 200;
      out[k] = Math.max(P.min, Math.min(P.max, Math.round(v[k] + half * w / 32767)));
    });
    return out;
  };

  // The 16-step lanes. piece.seq = { hits: 16-bit mask (sort hits), notes: [16] (0 = rest, 1..10 = scale step) }.
  // For every loop frame: how long since the last sort hit, and how long this hit lasts. Hits repeat every bar.
  // only: an explicit list of loop-frame starts instead of the lane's (the morph's 'hold still' keeps only its changes)
  DF.hitTimeline = function (piece, only) {
    var v = piece.v, L = DF.loopFrames(v), st = v.step, hits = (piece.seq && piece.seq.hits) || 0, frames = [];
    var starts = [];
    if (only) starts = only.slice().sort(function (a, b) { return a - b; });
    else { if (!hits) return null; for (var b = 0; b < v.bars; b++) for (var s = 0; s < 16; s++) if (hits & (1 << s)) starts.push((b * 16 + s) * st); }
    if (!starts.length) return null;
    var len = Math.min(v.hitLen * st, L);
    for (var lf = 0; lf < L; lf++) {
      var last = -1, next = L;
      for (var i = 0; i < starts.length; i++) { if (starts[i] <= lf) last = starts[i]; else { next = starts[i]; break; } }
      // before the first hit of the loop, the previous loop's last hit is still sounding (it wraps)
      var d = last >= 0 ? lf - last : lf + (L - starts[starts.length - 1]);
      // (an explicit list - 'hold still' - clips the last hit at the loop end on both sides of the seam, so the loop closes)
      var seg = last >= 0 ? next - last : (only ? L : starts[0] + L) - starts[starts.length - 1];
      var hl = Math.min(len, seg), sh = DF.hitShape(hl, v);
      frames.push({ d: d, seg: seg, len: hl, wrapped: last < 0, untilLoopEnd: L - lf, eo: v.easeOut || 0, eb: v.easeBack || 0, ri: sh.rise, ho: sh.hold });
    }
    return frames;
  };
  // easing, x 0..4096 -> 0..4096: 0 smooth (smoothstep), 1 linear, 2 snap, 3 slow start, 4 bounce (tables.js), 5 steps
  DF.ease = function (kind, x) {
    x = Math.max(0, Math.min(4096, x));
    if (!kind) return Math.round(x * x * (3 * 4096 - 2 * x) / (4096 * 4096));
    if (kind === 1) return Math.round(x);
    if (kind === 5) return Math.floor(x * 4 / 4096) * 1024;
    var T = DF.EASE_T[kind], i = Math.min(255, Math.floor(x / 16));
    return Math.round(T[i] + (T[i + 1] - T[i]) * (x - i * 16) / 16);
  };
  // integer easing (x, result 0..4096; overshoot goes above): the sweep shader's iease, byte for byte (shaders.js)
  DF.iease = function (kind, x) {
    if (!kind) return Math.floor(Math.floor(x * x / 4096) * (3 * 4096 - 2 * x) / 4096);
    if (kind === 1) return x;
    if (kind === 5) return ((x * 4) >> 12) * 1024;
    var T = DF.EASE_T[kind], i = Math.min(255, x >> 4), a = T[i];
    return a + (((T[i + 1] - a) * (x - i * 16)) >> 4);
  };
  // a hit of len frames: the rise (out share; 25% = round(len/4), as always) and a hold at the top before the fall
  DF.hitShape = function (len, v) {
    var rise = Math.max(1, Math.min(len - 1, Math.round(len * (v.hitRise == null ? 25 : v.hitRise) / 100)));
    var hold = v.hitHold ? Math.max(0, Math.min(len - rise - 1, Math.round(len * v.hitHold / 100))) : 0;
    return { rise: rise, hold: hold };
  };
  // process mode's hold: its out phase is half the hit, so the hold is cut to leave a quarter for the way home
  DF.procHold = function (len, v) {
    if (!v.hitHold) return 0;
    var outPart = Math.max(1, Math.round(len / 2));
    return Math.max(0, Math.min(Math.round(len * v.hitHold / 100), len - outPart - Math.max(1, Math.round(len / 4))));
  };
  // 0..4096 envelope of a hit: rise (eased by easeOut), hold at the top, fall back to 0 by the end of the hit (easeBack)
  DF.hitEnv = function (h) {
    if (!h || h.d >= h.len) return 0;
    var rise = h.ri || Math.max(1, Math.round(h.len / 4)), hold = h.ho || 0, e;
    if (h.d < rise) e = DF.ease(h.eo || 0, h.d * 4096 / rise);
    else if (h.d < rise + hold) return 4096;
    else if (!h.eb) { var y = 4096 - (h.d - rise - hold) * 4096 / (h.len - rise - hold); e = Math.round(y * y * (3 * 4096 - 2 * y) / (4096 * 4096)); }
    else e = 4096 - DF.ease(h.eb, (h.d - rise - hold) * 4096 / (h.len - rise - hold));
    return Math.max(0, Math.min(4096, e));
  };
  // where a hit is, for the 'together' sweep: phase 0..4096 through the rise (fall 0) or the fall (fall 1), and its ease
  DF.hitPhase = function (h) {
    if (!h || h.d >= h.len) return { ph: 0, fall: 0, kind: 0 };
    var rise = h.ri || Math.max(1, Math.round(h.len / 4)), hold = h.ho || 0;
    if (h.d < rise) return { ph: Math.floor(h.d * 4096 / rise), fall: 0, kind: h.eo || 0 };
    if (h.d < rise + hold) return { ph: 4096, fall: 0, kind: h.eo || 0 };
    return { ph: Math.floor((h.d - rise - hold) * 4096 / (h.len - rise - hold)), fall: 1, kind: h.eb || 0 };
  };
  // Type morph: the text holds words split by '|'. With type on and 'morph words' on, the loop is cut into one part per
  // word and the first hit of each part changes the word at its top (sweep / filter: the peak of the envelope; process:
  // the first frame home), while the frame is sorted: the pixels come home as the next word. Returns
  // { words, at: word index for every loop frame } or null.
  // a word '_' is nothing: an empty frame to reveal from (it counts as a word)
  DF.morphWords = function (piece) {
    var v = piece.v; if (!v.tyOn || !v.tyMorph) return null;
    var w = (piece.text || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    return w.length >= 2 ? w : null;
  };
  // the words editor's model <-> the text the address carries: slots { w: 'GOOD / NIGHT', n: times it stays }
  // (words are kept exactly as written - split and trimmed like morphWords - so nothing is rewritten unless edited)
  DF.textToWords = function (text) {
    var out = [];
    String(text || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (w) {
      if (out.length && out[out.length - 1].w === w) out[out.length - 1].n++; else out.push({ w: w, n: 1 });
    });
    return out;
  };
  DF.wordsToText = function (slots) {
    var all = [];
    slots.forEach(function (s) { var w = String(s.w || '').trim(); if (!w) return; for (var i = 0; i < Math.max(1, s.n || 1); i++) all.push(w); });
    return all.join(' | ');
  };
  DF.morphTimeline = function (piece) {
    var words = DF.morphWords(piece), tl = words && DF.hitTimeline(piece); if (!tl) return null;
    var v = piece.v, L = tl.length, K = words.length, starts = [], picks = [], events = [], used = {}, skipped = [], lf;
    for (lf = 0; lf < L; lf++) if (tl[lf].d === 0 && !tl[lf].wrapped) starts.push(lf);
    for (var k = 0; k < K; k++) {
      var seg = Math.round(k * L / K / v.step) * v.step, s = -1;
      for (var i = 0; i < starts.length; i++) if (starts[i] >= seg) { s = starts[i]; break; }
      if (s < 0) s = starts[0];                       // no hit left in this loop: the first one (it wraps)
      if (used[s]) { skipped.push(k); continue; }     // two parts on the same hit: the later word is skipped
      used[s] = 1; picks.push({ s: s, k: k });
    }
    if (v.hitsBetween) {
      // hold still: a change to the same word is no change; only the real changes sort, on their own timeline
      picks.sort(function (a, b) { return a.s - b.s; });
      var real = picks.filter(function (p, n) { return words[p.k] !== words[picks[(n + picks.length - 1) % picks.length].k]; });
      if (!real.length) {
        // no real change left (one word, or every word the same): the word holds still - nothing sorts, nothing sounds
        var z = new Array(L).fill(0), still = [];
        for (lf = 0; lf < L; lf++) still.push({ d: L, seg: L, len: 0, wrapped: true, untilLoopEnd: L - lf, eo: 0, eb: 0, ri: 1, ho: 0 });
        return { words: words, at: z, a: z.slice(), b: z.slice(), mix: z.slice(), changes: [], skipped: skipped, tl: still };
      }
      picks = real;
      tl = DF.hitTimeline(piece, picks.map(function (p) { return p.s; }));
    }
    picks.forEach(function (p) {
      // the change sits in the middle of the hold at the top (no hold: at the top), the dissolve fills the hold
      var h = tl[p.s], len = h.len, off, w;
      if (v.sortMode === 2) { var hf = DF.procHold(len, v); off = Math.max(1, Math.round(len / 2)) + Math.floor(hf / 2); w = hf > 0 ? Math.max(1, Math.floor(hf / 2)) : Math.max(1, Math.round(len / 8)); }
      else if (v.sortMode) { off = h.ri + Math.floor(h.ho / 2); w = h.ho > 0 ? Math.max(1, Math.floor(h.ho / 2)) : Math.max(1, Math.round(len / 8)); }
      else { off = 0; w = Math.max(1, Math.round(len / 8)); }
      events.push([(p.s + off) % L, p.k, len, w]);
    });
    events.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var at = new Array(L), e = 0, cur = events[events.length - 1][1];     // before the first change: the loop's last word
    for (lf = 0; lf < L; lf++) { while (e < events.length && events[e][0] <= lf) cur = events[e++][1]; at[lf] = cur; }
    // around each change the source dissolves from one word to the next (Bayer-dithered): sorting a mix gives piles
    // between the two sizes, so the drips grow and shrink instead of popping. Window: len/8 either side of the top.
    var A = at.slice(), B = at.slice(), mix = new Array(L).fill(0);
    events.forEach(function (ev, n) {
      var prev = events[(n + events.length - 1) % events.length][1], c = ev[0], w = ev[3];
      for (var j = 0; j < 2 * w; j++) {
        var f = ((c - w + j) % L + L) % L, m = Math.round((j + 0.5) * 4096 / (2 * w));
        A[f] = prev; B[f] = ev[1]; mix[f] = m; at[f] = m >= 2048 ? ev[1] : prev;
      }
    });
    return { words: words, at: at, a: A, b: B, mix: mix, changes: events, skipped: skipped, tl: v.hitsBetween ? tl : null };
  };
  // the hits the picture uses: the morph's own under 'hold still', else the lane's
  DF.visualTimeline = function (piece) { var m = DF.morphTimeline(piece); return (m && m.tl) || DF.hitTimeline(piece); };
  // 'hold still': only the hits that sort may sound (every sounded beat sorts). Loop frames of those starts, or null = all.
  var sounded = { key: null, val: null };
  DF.soundedHits = function (piece) {
    var v = piece.v; if (!v.hitsBetween || !v.tyOn || !v.tyMorph) return null;
    var key = [piece.text, v.bars, v.step, v.hitLen, v.hitRise, v.hitHold, v.sortMode, piece.seq && piece.seq.hits].join('|');
    if (sounded.key !== key) {
      var m = DF.morphTimeline(piece), set = null;
      if (m && m.tl) { set = {}; m.tl.forEach(function (h, lf) { if (h.d === 0 && !h.wrapped) set[lf] = 1; }); }
      sounded = { key: key, val: set };
    }
    return sounded.val;
  };

  // the frame where the sort is strongest (contact sheets, stills): the top of the first hit, or the end of the out phase
  DF.peakFrame = function (piece) {
    var v = piece.v, tl = DF.visualTimeline(piece), L = DF.loopFrames(v);
    if (v.sortMode === 0) return Math.floor(L / 3);
    if (tl) {
      var best = 0, bi = 0;
      for (var i = 0; i < L; i++) {
        // process: the last out-phase frame (stepProcess: d < outPart travels, d = outPart already runs home)
        var h = tl[i], e = v.sortMode === 2 ? (h.wrapped ? 0 : (h.d < Math.max(1, Math.round(h.len / 2)) ? h.d + 1 : 0)) : DF.hitEnv(h);
        if (e > best) { best = e; bi = i; }
      }
      return bi;
    }
    return Math.max(0, Math.floor(L * v.procOut / 100) - 1);
  };
})();
