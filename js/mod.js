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
  DF.hitTimeline = function (piece) {
    var v = piece.v, L = DF.loopFrames(v), st = v.step, hits = (piece.seq && piece.seq.hits) || 0, frames = [];
    if (!hits) return null;
    var starts = [];
    for (var b = 0; b < v.bars; b++) for (var s = 0; s < 16; s++) if (hits & (1 << s)) starts.push((b * 16 + s) * st);
    var len = Math.min(v.hitLen * st, L);
    for (var lf = 0; lf < L; lf++) {
      var last = -1, next = L;
      for (var i = 0; i < starts.length; i++) { if (starts[i] <= lf) last = starts[i]; else { next = starts[i]; break; } }
      // before the first hit of the loop, the previous loop's last hit is still sounding (it wraps)
      var d = last >= 0 ? lf - last : lf + (L - starts[starts.length - 1]);
      var seg = last >= 0 ? next - last : starts[0] + (L - starts[starts.length - 1]);
      frames.push({ d: d, seg: seg, len: Math.min(len, seg), wrapped: last < 0, untilLoopEnd: L - lf });
    }
    return frames;
  };
  // 0..4096 envelope of a hit: quick rise (first 25%), eased fall back to 0 by the end of the hit
  DF.hitEnv = function (h) {
    if (!h || h.d >= h.len) return 0;
    var rise = Math.max(1, Math.round(h.len / 4));
    if (h.d < rise) { var x = h.d * 4096 / rise; return Math.round(x * x * (3 * 4096 - 2 * x) / (4096 * 4096)); }
    var y = 4096 - (h.d - rise) * 4096 / (h.len - rise);
    return Math.round(y * y * (3 * 4096 - 2 * y) / (4096 * 4096));
  };
  // the frame where the sort is strongest (contact sheets, stills): the top of the first hit, or the end of the out phase
  DF.peakFrame = function (piece) {
    var v = piece.v, tl = DF.hitTimeline(piece), L = DF.loopFrames(v);
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
