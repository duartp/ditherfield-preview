// ditherfield - the engine. One piece = seed + dial values + text. frame(f) draws frame f (60 per second of piece
// time); the process sort keeps state between frames, so frames must come in order (a jump re-simulates from the
// start of the loop, which makes any frame reproducible). Stages: SOURCE -> SORT -> COLOUR/DITHER -> POST + upscale.
(function () {
  var GL = DF.GL, SH = DF.SHADERS;

  function Timers(gl) {
    this.gl = gl; this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = []; this.hist = {}; this.cur = null;
  }
  Timers.prototype.begin = function (name) {
    if (!this.ext) return;
    var q = this.gl.createQuery(); this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q); this.cur = { q: q, name: name };
  };
  Timers.prototype.end = function () {
    if (!this.ext || !this.cur) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.pending.push(this.cur); this.cur = null;
  };
  Timers.prototype.poll = function () {
    if (!this.ext) return;
    var gl = this.gl, disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT), keep = [];
    for (var i = 0; i < this.pending.length; i++) {
      var p = this.pending[i];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { keep.push(p); continue; }
      if (!disjoint) {
        var ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6, h = this.hist[p.name] || (this.hist[p.name] = []);
        h.push(ms); if (h.length > 120) h.shift();
      }
      gl.deleteQuery(p.q);
    }
    this.pending = keep.length > 64 ? keep.slice(-64) : keep;
  };
  Timers.prototype.stats = function () {
    var out = {};
    for (var k in this.hist) {
      var h = this.hist[k].slice().sort(function (a, b) { return a - b; });
      if (!h.length) continue;
      var mean = h.reduce(function (a, b) { return a + b; }, 0) / h.length;
      out[k] = { mean: mean, p95: h[Math.min(h.length - 1, Math.floor(h.length * 0.95))] };
    }
    return out;
  };

  function hash32(x) { // small integer mix for per-band variation (deterministic, JS integer ops only)
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return (x ^ (x >>> 16)) >>> 0;
  }
  function phase(cycles, lf, L) { // cycles per loop -> 16-bit phase at loop frame lf, exact
    var p = Math.floor(cycles * 65536 * lf / L) % 65536; return p < 0 ? p + 65536 : p;
  }
  // the axis the sort runs along, as an integer slope (tan table), plus which end the bright pixels travel to
  function sortGeom(deg) {
    deg = ((deg % 360) + 360) % 360;
    var a = deg % 180, t;
    if (a <= 45 || a >= 135) { t = a <= 45 ? a : a - 180; return { swap: false, slope: t >= 0 ? DF.TAN1024[t] : -DF.TAN1024[-t], desc: deg > 90 && deg < 270 }; }
    t = 90 - a; return { swap: true, slope: t >= 0 ? DF.TAN1024[t] : -DF.TAN1024[-t], desc: deg > 180 };
  }
  DF.gridSize = function (v) {
    var W = +DF.PARAM.grid.opts[v.grid];
    var H = v.aspect === 0 ? Math.round(W * 5 / 4) : v.aspect === 1 ? W : Math.round(W * 16 / 9);
    return [W, H];
  };

  function Engine(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas; this.k = opts.k || 3; this.view = 'final';
    var gl = this.gl = GL.context(canvas);
    var P = this.P = {};
    ['source', 'spanInit', 'spanScan', 'spanCap', 'stateInit', 'refresh', 'oddEven', 'bitonic', 'blendInit', 'colour',
     'viewSource', 'viewSorted', 'post'].forEach(function (k) { P[k] = GL.program(gl, SH[k]); });
    P.inv = GL.program(gl, SH.invFS, SH.invVS);
    this.timers = new Timers(gl);
    this.blue = this.texture(64, 64, gl.R8, gl.RED, gl.UNSIGNED_BYTE,
      Uint8Array.from(atob(DF.BLUE64), function (c) { return c.charCodeAt(0); }));
    // the easing tables for the sweep shader (rows: snap, slow start, bounce, overshoot), whole numbers
    var ET = new Int32Array(257 * 4); [2, 3, 4, 6].forEach(function (k, r) { ET.set(DF.EASE_T[k], r * 257); });
    this.easeTex = this.texture(257, 4, gl.R32I, gl.RED_INTEGER, gl.INT, ET);
    this.typeCanvas = document.createElement('canvas');
    this.typeTex = null; this.typeTexs = []; this.typeKey = '';
    this.W = 0; this.H = 0; this.procF = -2; this.passCount = 0;
  }

  Engine.prototype.texture = function (w, h, internal, format, type, data) {
    var gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { t: t, w: w, h: h };
  };
  Engine.prototype.target = function (internal, format, type) {
    var gl = this.gl, T = this.texture(this.W, this.H, internal, format, type);
    T.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('A render target is not supported here.');
    return T;
  };
  Engine.prototype.allocate = function () {
    var gl = this.gl, self = this;
    ['src', 'spanA', 'spanB', 'spanC', 'whole', 'stA', 'stB', 'doh', 'col'].forEach(function (k) {   // free the old ones first
      var T = self[k]; if (T) { gl.deleteFramebuffer(T.fb); gl.deleteTexture(T.t); self[k] = null; }
    });
    this.src = this.target(gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE);
    this.spanA = this.target(gl.RG32I, gl.RG_INTEGER, gl.INT);
    this.spanB = this.target(gl.RG32I, gl.RG_INTEGER, gl.INT);
    this.spanC = this.target(gl.RG32I, gl.RG_INTEGER, gl.INT);
    this.whole = this.target(gl.RG32I, gl.RG_INTEGER, gl.INT);
    this.stA = this.target(gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT);
    this.stB = this.target(gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT);
    this.doh = this.target(gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT);
    this.col = this.target(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.st = this.stA; this.stO = this.stB;
  };

  // piece = { seed, v: dial values, text, salt }
  Engine.prototype.setPiece = function (piece) {
    var v = piece.v, dims = DF.gridSize(v), g = sortGeom(v.sortAng);
    var resized = dims[0] !== this.W || dims[1] !== this.H;
    var geomChanged = resized || !this.geom || g.swap !== this.geom.swap || g.slope !== this.geom.slope;
    this.piece = piece; this.v = v;
    if (resized) { this.W = dims[0]; this.H = dims[1]; this.allocate(); }
    this.setScale(this.k);
    this.geom = g;
    this.L = DF.loopFrames(v);
    this.morph = DF.morphTimeline(piece);
    this.timeline = (this.morph && this.morph.tl) || DF.hitTimeline(piece);
    var along = g.swap ? this.H : this.W, cross = g.swap ? this.W : this.H;
    var off = function (u) { return (u * g.slope + 512) >> 10; };
    var o0 = off(0), o1 = off(along - 1);
    this.Lmin = 0 - Math.max(o0, o1); this.Lspan = (cross - 1 - Math.min(o0, o1)) - this.Lmin + 1;
    this.along = along;
    this.outFrames = Math.max(1, Math.floor(this.L * v.procOut / 100));
    this.backFrames = Math.max(1, this.L - this.outFrames);
    this.passBack = Math.max(v.procPass, Math.ceil(along / this.backFrames));
    this.palKey = null;
    if (geomChanged) {
      this.buildWhole();
      // live (the studio): pixels restart from home at once, exact again from the next loop start. Fresh engines
      // (export, thumbnails, stills) have procF -2 and simulate from frame 0, so exports are never affected.
      if (this.procF >= 0 && !resized) { this.initState(); this.passCount = 0; } else this.procF = -2;
    }
    this.applyLive(v);
  };
  // per-frame values (after LFOs): band amounts, palettes with the hue shift, the type raster
  Engine.prototype.applyLive = function (v) {
    this.v = v;
    var salt = this.piece.salt >>> 0, amt = Math.round(v.sortAmt * 256 / 100), bands = [];
    for (var b = 0; b < 32; b++) {
      var r = hash32((b + 1) ^ salt) & 255;
      bands.push(Math.round(amt * (25600 - v.sortSpread * r) / 25600));
    }
    this.bandBase = bands;
    var piece = this.piece;
    var A = (piece.palA || DF.PRESETS[DF.PALETTE_NAMES[v.palA]].stops).slice(0, 16);
    var B = (piece.palB || DF.PRESETS[DF.PALETTE_NAMES[v.palB]].stops).slice(0, 16);
    var key = A.join() + '|' + B.join() + '|' + v.hue;
    if (key !== this.palKey) {
      this.palKey = key;
      this.pal = v.hue && DF.colour ? [DF.colour.shiftHue(A, v.hue), DF.colour.shiftHue(B, v.hue)] : [A, B];
    }
    this.updateType();
  };
  Engine.prototype.setScale = function (k) {
    this.k = k;
    if (this.canvas.width !== this.W * k || this.canvas.height !== this.H * k) {
      this.canvas.width = this.W * k; this.canvas.height = this.H * k;
      if (this.drawn) this.present();                     // resizing clears a canvas: draw the last frame again
    }
  };
  // the last computed frame, drawn again at the current size (post + upscale only)
  Engine.prototype.present = function () {
    if (!this.col || this.gl.isContextLost()) return;
    var v = this.v, self = this;
    this.run('post', null, { uCol: this.col }, function (gl, u) {
      gl.uniform2i(u.uGrid, self.W, self.H); gl.uniform1i(u.uK, self.k);
      gl.uniform1i(u.uScan, v.scan); gl.uniform1i(u.uCurve, v.curve); gl.uniform1i(u.uVig, v.vignette);
    });
  };

  // ---------------------------------------------------------------- pass plumbing
  Engine.prototype.run = function (name, out, texs, set, draw) {
    var gl = this.gl, P = this.P[name], u = P.u, unit = 0;
    gl.useProgram(P.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    gl.viewport(0, 0, out ? out.w : this.canvas.width, out ? out.h : this.canvas.height);
    for (var t in texs) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texs[t].t);
      if (u[t]) gl.uniform1i(u[t], unit); unit++;
    }
    if (u.uSize) gl.uniform2i(u.uSize, this.W, this.H);
    if (u.uSlopeP) gl.uniform1i(u.uSlopeP, this.geom.slope);
    if (u.uSwap) gl.uniform1i(u.uSwap, this.geom.swap ? 1 : 0);
    if (set) set(gl, u);
    gl.bindVertexArray(P.vao);
    if (draw) draw(); else gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  Engine.prototype.swapState = function () { var t = this.st; this.st = this.stO; this.stO = t; };

  // spans for the whole line (every position masked): what the blend sweep sorts over
  Engine.prototype.buildWhole = function () {
    // lo 0 / hi 255 masks every position, so each span is the whole line (whatever the source holds)
    var a = this.whole, b = this.spanB;
    this.run('spanInit', a, { uSrc: this.src }, function (gl, u) { gl.uniform1i(u.uLo, 0); gl.uniform1i(u.uHi, 255); gl.uniform1i(u.uOpen, 0); });
    for (var d = 1; d < this.along; d <<= 1) {
      this.run('spanScan', b, { uSpan: a }, function (gl, u) { gl.uniform1i(u.uD, d); });
      var t = a; a = b; b = t;
    }
    this.whole = a; this.spanB = b;
  };
  // how far the beat opens the window at loop frame lf: 0..4096 (the hit envelope times the beatOpen dial)
  // (lines open 'together': the whole hit opens every line at once; the sweep's stagger does the rest)
  Engine.prototype.openAt = function (lf) {
    var v = this.v; if (!this.timeline || !v.beatOpen) return 0;
    var h = this.timeline[lf];
    if (v.openHow) return h.d < h.len ? Math.round(4096 * v.beatOpen / 100) : 0;
    return Math.round(DF.hitEnv(h) * v.beatOpen / 100);
  };
  // mult scales every band's amount (filter: the hit envelope). open (0..4096) is the share of lines the beat has
  // opened: those sort everything (window 0..255) at full length, so a hit always sorts, and a half-open beat opens
  // half the lines (sources are mostly pure black and white: widening the thresholds would only show at the very top).
  // The values used are kept for the self-test's CPU sort.
  Engine.prototype.findSpans = function (mult, open) {
    var v = this.v, self = this, m = mult == null ? 4096 : mult, o = open || 0, oAmt = Math.round(256 * m / 4096);
    var bands = new Int32Array(this.bandBase.map(function (a) { return Math.round(a * m / 4096); }));
    this.spanOpen = o; this.spanOpenAmt = oAmt; this.spanBands = bands;
    this.run('spanInit', this.spanA, { uSrc: this.src }, function (gl, u) { gl.uniform1i(u.uLo, v.sortLo); gl.uniform1i(u.uHi, v.sortHi); gl.uniform1i(u.uOpen, o); });
    var a = this.spanA, b = this.spanB;
    for (var d = 1; d < this.along; d <<= 1) {
      this.run('spanScan', b, { uSpan: a }, function (gl, u) { gl.uniform1i(u.uD, d); });
      var t = a; a = b; b = t;
    }
    this.run('spanCap', this.spanC, { uSpan: a }, function (gl, u) {
      gl.uniform1i(u.uMax, v.sortMax); gl.uniform1i(u.uBands, v.sortBands);
      gl.uniform1i(u.uLmin, self.Lmin); gl.uniform1i(u.uLspan, self.Lspan);
      gl.uniform1iv(u.uBandAmt, bands); gl.uniform1i(u.uOpen, o); gl.uniform1i(u.uOpenAmt, oAmt);
    });
    this.span = this.spanC;
  };
  Engine.prototype.initState = function () {
    this.run('stateInit', this.st, { uSrc: this.src });
  };
  Engine.prototype.bitonic = function (span, maxLen, desc) {
    var m = Math.ceil(Math.log2(Math.max(2, maxLen)));
    desc = desc ? 1 : 0;
    for (var k = 1; k <= m; k++) {
      for (var j = k - 1; j >= 0; j--) {
        var flip = j === k - 1;
        this.run('bitonic', this.stO, { uState: this.st, uSpan: span }, function (gl, u) {
          gl.uniform1i(u.uK, k); gl.uniform1i(u.uJ, j); gl.uniform1i(u.uFlip, flip ? 1 : 0); gl.uniform1i(u.uDesc, desc);
        });
        this.swapState();
      }
    }
  };
  Engine.prototype.oddEven = function (home) {
    var t = this.passCount++, desc = this.geom.desc ? 1 : 0;
    this.run('oddEven', this.stO, { uState: this.st, uSpan: this.span }, function (gl, u) {
      gl.uniform1i(u.uT, t); gl.uniform1i(u.uDesc, desc); gl.uniform1i(u.uHome, home ? 1 : 0);
    });
    this.swapState();
  };

  // ---------------------------------------------------------------- stages
  Engine.prototype.renderSource = function (lf) {
    var v = this.v, L = this.L, W = this.W, H = this.H, self = this;
    var ang = v.stAngle * 65536 / 360 | 0;
    var c = DF.isin(ang + 16384), s = DF.isin(ang);
    var m = this.morph; this.word = m ? m.at[lf] : 0;
    var ta = m ? this.typeTexs[m.a[lf]] : this.typeTex, tb = m ? this.typeTexs[m.b[lf]] : this.typeTex, mix = m ? m.mix[lf] : 0;
    this.run('source', this.src, { uType: ta, uType2: tb }, function (gl, u) {
      gl.uniform1i(u.uBg, v.bg);
      gl.uniform1i(u.uStOn, v.stOn); gl.uniform1i(u.uStGain, v.stGain); gl.uniform1i(u.uStCut, v.stCut); gl.uniform1i(u.uStMode, v.stMode);
      gl.uniform1ui(u.uStC, c >>> 0); gl.uniform1ui(u.uStS, s >>> 0);
      gl.uniform1ui(u.uStPer, Math.round(65536 / v.stPeriod)); gl.uniform1ui(u.uStPh, phase(v.stSpeed, lf, L));
      gl.uniform1i(u.uRgOn, v.rgOn); gl.uniform1i(u.uRgN, v.rgCount); gl.uniform1i(u.uRgGain, v.rgGain);
      gl.uniform1i(u.uRgCut, v.rgCut); gl.uniform1i(u.uRgMode, v.rgMode);
      gl.uniform1i(u.uRgOrbR, Math.round(Math.min(W, H) * 16 * v.rgOrbit / 100));
      gl.uniform2i(u.uRgC, Math.round(W * 16 * v.rgX / 100), Math.round(H * 16 * (100 - v.rgY) / 100));
      gl.uniform1ui(u.uRgPer, Math.round(65536 / v.rgPeriod)); gl.uniform1ui(u.uRgPh, phase(v.rgSpeed, lf, L));
      gl.uniform1ui(u.uRgOrbPh, phase(v.rgOrbSpd, lf, L));
      gl.uniform1i(u.uTyOn, v.tyOn); gl.uniform1i(u.uTyVal, v.tyVal); gl.uniform1i(u.uTyMode, v.tyMode); gl.uniform1i(u.uTyMix, mix);
    });
  };

  // the type raster: one texture per word when morphing (else the whole text), all at one size so words don't jump
  Engine.prototype.updateType = function () {
    var v = this.v, self = this, wordsOn = !!(v.tyOn && v.tyMorph);
    // words mode with nothing to morph (one word, a lone '_', no hits): the first real word, never the raw 'A | B' text
    var list = !this.morph && wordsOn ? (this.piece.text || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean) : null;
    var words = this.morph ? this.morph.words : list ? [list.filter(function (w) { return w !== '_'; })[0] || (list.length ? '_' : '')] : [this.piece.text || ''];
    var key = [words.join('|'), v.tyFont, v.tySize, v.tyX, v.tyY, v.tyTrack, v.tyAlign, v.tyStack, this.W, this.H].join('|');
    if (key === this.typeKey && this.typeTex) return;
    this.typeKey = key;
    var c = this.typeCanvas; c.width = this.W; c.height = this.H;
    var g = c.getContext('2d');
    g.textAlign = ['center', 'left', 'right'][v.tyAlign || 0]; g.textBaseline = 'middle';
    g.font = v.tySize + 'px ' + DF.fontFamily(v.tyFont);
    if ('letterSpacing' in g) g.letterSpacing = v.tyTrack + 'px';
    // a word '_' (morph only) is nothing: a black frame, left out of the fit
    var blank = function (w) { return wordsOn && w === '_'; };
    var sets = words.map(function (w) { return blank(w) ? [] : w.split(/\n|\s*\/\s*/); }), size = v.tySize;
    // shrink to fit: the widest line of any word stays inside 92% of the frame
    var widest = Math.max.apply(null, [0].concat([].concat.apply([], sets).map(function (ln) { return g.measureText(ln).width; })));
    if (widest > this.W * 0.92) { size = Math.max(6, Math.floor(size * this.W * 0.92 / widest)); g.font = size + 'px ' + DF.fontFamily(v.tyFont); }
    var lh = Math.round(size * 0.95), x = Math.round(this.W * v.tyX / 100);
    var old = this.typeTexs;
    this.typeTexs = sets.map(function (lines, i) {
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#fff';
      var y0 = v.tyStack ? Math.round(self.H * v.tyY / 100) : Math.round(self.H * v.tyY / 100 - (lines.length - 1) * lh / 2);
      lines.forEach(function (ln, j) { g.fillText(ln, x, y0 + j * lh); });
      return { t: GL.textureFrom(self.gl, c, old[i] ? old[i].t : null) };
    });
    for (var i = this.typeTexs.length; i < old.length; i++) this.gl.deleteTexture(old[i].t);
    this.typeTex = this.typeTexs[0];
  };

  // the process: out-phase odd-even passes (pixels travel), back-phase home-sort (they land home); reset each loop
  Engine.prototype.stepProcess = function (f) {
    var lf = f % this.L, v = this.v, home = false, n;
    this.findSpans(null, this.openAt(lf));
    if (lf === 0) { this.initState(); this.passCount = 0; }
    else { this.run('refresh', this.stO, { uSrc: this.src, uState: this.st }); this.swapState(); }
    if (this.timeline) {
      // each sort hit: pixels travel out for half the hit, then come home before the next hit or the loop end
      // (hold sorted: a pause at the top with no passes; the way home is then shorter)
      var h = this.timeline[lf], outPart = Math.max(1, Math.round(h.len / 2)), hf = DF.procHold(h.len, v);
      if (h.wrapped) n = 0;
      else if (h.d < outPart) n = v.procPass;
      else if (h.d < outPart + hf) n = 0;
      else { home = true; n = Math.max(v.procPass, Math.ceil(this.along / Math.max(1, Math.min(h.seg, h.d + h.untilLoopEnd) - outPart - hf))); }
    } else { home = lf >= this.outFrames; n = home ? this.passBack : v.procPass; }
    for (var i = 0; i < n; i++) this.oddEven(home);
    this.procF = f;
  };
  Engine.prototype.sweep = function (lf) {
    var v = this.v, T;
    if (this.timeline) T = DF.hitEnv(this.timeline[lf]);
    else T = lf < this.outFrames ? Math.round(lf * 4096 / this.outFrames) : Math.round((this.L - lf) * 4096 / this.backFrames);
    this.findSpans(null, this.openAt(lf)); this.initState(); this.bitonic(this.span, Math.min(v.sortMax, this.along), this.geom.desc);
    var n = this.W * this.H, gl = this.gl;
    this.run('inv', this.doh, { uState: this.st }, null, function () { gl.drawArrays(gl.POINTS, 0, n); });
    var tog = v.openHow && this.timeline ? 1 : 0, hp = tog ? DF.hitPhase(this.timeline[lf]) : { ph: 0, fall: 0, kind: 0 };
    this.run('blendInit', this.st, { uDestOfHome: this.doh, uSrc: this.src, uEase: this.easeTex }, function (gl, u) {
      gl.uniform1i(u.uT, T); gl.uniform1i(u.uStag, Math.round(v.sweepStag * 4096 / 100));
      gl.uniform1i(u.uTogether, tog); gl.uniform1i(u.uStagBy, v.stagBy || 0); gl.uniform1i(u.uExit, v.stagExit || 0);
      gl.uniform1i(u.uPh, hp.ph); gl.uniform1i(u.uFall, hp.fall); gl.uniform1i(u.uKind, hp.kind);
    });
    this.blend = { tog: tog, ph: hp.ph, fall: hp.fall, kind: hp.kind, T: T };   // for the self-test's CPU sweep
    this.bitonic(this.whole, this.along, false);      // interpolated positions: always ascending
  };

  Engine.prototype.colour = function (lf) {
    var v = this.v, pal = this.pal, gl = this.gl, sortOn = v.sortMode !== 0 ? 1 : 0, self = this;
    function flat(stops, ints) {
      var a = ints ? new Int32Array(48) : new Float32Array(48);
      stops.forEach(function (h, i) { var c = DF.hex(h); for (var j = 0; j < 3; j++) a[i * 3 + j] = ints ? c[j] : c[j] / 255; });
      return a;
    }
    var nA = Math.max(2, pal[0].length), nB = Math.max(2, pal[1].length);
    var cyc = function (n) { var c = Math.floor(v.cycle * n * lf / this.L) % n; return c < 0 ? c + n : c; }.bind(this);
    this.run('colour', this.col, { uSrc: this.src, uState: this.st, uBlue: this.blue }, function (gl, u) {
      gl.uniform1i(u.uSortOn, sortOn); gl.uniform1i(u.uDither, v.dither); gl.uniform1i(u.uColMode, v.colMode);
      gl.uniform1i(u.uNA, nA); gl.uniform1i(u.uNB, nB);
      gl.uniform1i(u.uXfade, Math.round(v.xfade * 256 / 100)); gl.uniform1i(u.uLevels, v.levels);
      gl.uniform1i(u.uSpread, v.spread); gl.uniform1i(u.uDithHome, v.dithHome);
      gl.uniform1i(u.uSortedPal, v.sortTint ? 1 : -1); gl.uniform1i(u.uCycA, cyc(nA)); gl.uniform1i(u.uCycB, cyc(nB));
      gl.uniform3fv(u.uPalA, flat(pal[0])); gl.uniform3fv(u.uPalB, flat(pal[1]));
      gl.uniform3iv(u.uPalAi, flat(pal[0], true)); gl.uniform3iv(u.uPalBi, flat(pal[1], true));
      gl.uniform1iv(u.uLayerPal, new Int32Array(self.piece.layerPal || [0, 0, 0, 0]));
    });
  };

  // draw frame f. Returns nothing; timings accumulate in this.timers.
  Engine.prototype.frame = function (f) {
    var lf = f % this.L, T = this.timers;
    var ve = DF.effective(this.piece, f); if (ve !== this.v) this.applyLive(ve);
    var v = this.v;
    T.poll();
    if (v.sortMode === 2 && f !== this.procF + 1) {
      // missed frames: step them (no drawing); a jump backwards or into another loop re-simulates from the loop start,
      // so the state always matches an uninterrupted run from frame 0
      var start = (this.procF >= f - lf && this.procF < f) ? this.procF + 1 : f - lf;
      for (var g = start; g < f; g++) { this.applyLive(DF.effective(this.piece, g)); this.renderSource(g % this.L); this.stepProcess(g); }
      this.applyLive(ve);
    }
    T.begin('source'); this.renderSource(lf); T.end();
    T.begin('sort');
    if (v.sortMode === 1) {
      this.findSpans(this.timeline ? DF.hitEnv(this.timeline[lf]) : 4096, this.openAt(lf));
      this.initState(); this.bitonic(this.span, Math.min(v.sortMax, this.along), this.geom.desc);
    }
    else if (v.sortMode === 2) this.stepProcess(f);
    else if (v.sortMode === 3) this.sweep(lf);
    T.end();
    T.begin('colour');
    if (this.view === 'source') this.run('viewSource', this.col, { uSrc: this.src });
    else if (this.view === 'sorted' && v.sortMode) this.run('viewSorted', this.col, { uSrc: this.src, uState: this.st });
    else this.colour(lf);
    T.end();
    var self = this;
    T.begin('post'); this.present(); T.end();
    this.drawn = true;
  };

  // FNV-1a over the art-grid colours of the current frame: 'same seed, same picture' can be checked on any device.
  Engine.prototype.hash = function () {
    var gl = this.gl, a = new Uint8Array(this.W * this.H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.col.fb);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, a);
    var h = 0x811c9dc5;
    for (var i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  };

  // brightness of one screen row (0 = top) of the current frame: the pixel-row voice plays it as a waveform
  Engine.prototype.readRow = function (row) {
    var gl = this.gl, y = this.H - 1 - Math.max(0, Math.min(this.H - 1, row)), a = new Uint8Array(this.W * 4), out = new Array(this.W);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.col.fb);
    gl.readPixels(0, y, this.W, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
    for (var i = 0; i < this.W; i++) out[i] = (a[i * 4] * 77 + a[i * 4 + 1] * 150 + a[i * 4 + 2] * 29) >> 8;
    return out;
  };
  Engine.prototype.rowForStep = function (k) { return Math.floor((k + 0.5) * this.H / 16); };

  // integer sine from the literal table, same as the shader's isin()
  DF.isin = function (ph) {
    var p = ph & 0xFFFF, i = p >> 8, f = p & 0xFF, a = DF.SIN257[i], b = DF.SIN257[i + 1];
    return a + (((b - a) * f) >> 8);
  };
  DF.Engine = Engine;
})();
