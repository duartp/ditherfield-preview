// ditherfield - sound. Small synthesised voices, no audio files. The same schedule() runs live (AudioContext with a
// look-ahead timer) and offline (OfflineAudioContext for the MP4), so the clip sounds like the studio.
// Sort hits get a low thump + a short noise sweep; notes on the 16 steps get the chosen voice.
(function () {
  var SCALES = [[0, 3, 5, 7, 10], [0, 2, 4, 7, 9], [0, 2, 3, 5, 7, 9, 10], [0, 1, 3, 5, 7, 8, 10], [0, 2, 4, 6, 8, 10]];
  function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function noteHz(v, n) {
    var sc = SCALES[v.scale] || SCALES[0], d = n - 1;
    return midiHz(v.root + 12 + sc[d % sc.length] + 12 * Math.floor(d / sc.length));
  }

  function Synth(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();          // a limiter: a sequencer stacks enough notes to clip
    this.comp.threshold.value = -10; this.comp.knee.value = 6; this.comp.ratio.value = 12;
    this.comp.attack.value = 0.003; this.comp.release.value = 0.12;
    this.master.connect(this.comp); this.comp.connect(ctx.destination);
    this.noise = this.makeNoise();
    this.rowWave = null;
  }
  Synth.prototype.makeNoise = function () {
    var ctx = this.ctx, n = ctx.sampleRate, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0), x = 22222;
    for (var i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; d[i] = (x / 4294967296) * 2 - 1; }   // fixed noise
    return b;
  };
  // a wavetable from one row of the picture: what you see is what you hear
  Synth.prototype.setRow = function (lumas) {
    if (!lumas || lumas.length < 8) { this.rowWave = null; return; }
    var N = 32, re = new Float32Array(N), im = new Float32Array(N), L = lumas.length;
    var mean = 0; for (var i = 0; i < L; i++) mean += lumas[i]; mean /= L;
    for (var k = 1; k < N; k++) {
      var a = 0, b = 0;
      for (var j = 0; j < L; j++) { var ph = 2 * Math.PI * k * j / L, s = (lumas[j] - mean) / 128; a += s * Math.cos(ph); b += s * Math.sin(ph); }
      re[k] = a / L; im[k] = b / L;
    }
    this.rowWave = this.ctx.createPeriodicWave(re, im);
  };
  Synth.prototype.note = function (t, hz, dur, v) {
    if (!(v.vol > 0)) return;                              // exponential ramps cannot target 0: at volume 0, no notes
    var ctx = this.ctx, g = ctx.createGain(), vol = v.vol / 100;
    g.connect(this.master);
    if (v.voice === 2) {                                   // bell: two partials, long decay
      [[1, 0.5], [2.76, 0.22]].forEach(function (p) {
        var o = ctx.createOscillator(), og = ctx.createGain(); o.type = 'sine'; o.frequency.value = hz * p[0];
        og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(p[1] * vol, t + 0.004);
        og.gain.exponentialRampToValueAtTime(0.0001, t + dur * 3);
        o.connect(og).connect(g); o.start(t); o.stop(t + dur * 3 + 0.05);
      });
      g.gain.value = 0.5;
      return;
    }
    var o = ctx.createOscillator(), f = ctx.createBiquadFilter();
    if (v.voice === 1 && this.rowWave) o.setPeriodicWave(this.rowWave); else o.type = 'square';
    o.frequency.value = hz;
    f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(hz * 12, t); f.frequency.exponentialRampToValueAtTime(hz * 1.5, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28 * vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.4);
    o.connect(f).connect(g); o.start(t); o.stop(t + dur * 1.4 + 0.05);
  };
  Synth.prototype.hit = function (t, len, v) {
    if (!(v.vol > 0)) return;
    var ctx = this.ctx, vol = v.vol / 100, th = v.thump / 100;
    if (th > 0) {                                           // low thump: sine falling 120 -> 42 Hz
      var o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine';
      o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9 * th * vol, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.25);
    }
    // the sweep: filtered noise rising while the pixels travel out, falling as they come home
    var n = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
    n.buffer = this.noise; bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(3200, t + len * 0.35);
    bp.frequency.exponentialRampToValueAtTime(300, t + len);
    ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(0.12 * vol, t + len * 0.3);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + len);
    n.connect(bp).connect(ng).connect(this.master); n.start(t, 0); n.stop(t + len + 0.02);
  };
  // schedule every step whose time falls in [from, to). t0 = audio time of frame 0. onStep(step, frame) lets the
  // caller read the picture (pixel row) just before a note.
  Synth.prototype.schedule = function (piece, t0, from, to, onStep) {
    var v = piece.v, stepDur = v.step / 60, seq = piece.seq || { hits: 0, notes: [] }, L = DF.loopFrames(v), vis = DF.soundedHits(piece);
    var first = Math.max(0, Math.ceil((from - t0) / stepDur - 1e-9)), last = Math.floor((to - t0) / stepDur - 1e-9);
    for (var s = first; s <= last; s++) {
      var t = t0 + s * stepDur; if (t < from - 1e-6 || t >= to) continue;
      var k = s % 16, fr = s * v.step;
      var ve = DF.effective(piece, fr);
      if (onStep) onStep(k, fr);
      if ((seq.hits & (1 << k)) && (!vis || vis[fr % L])) this.hit(t, Math.max(0.08, v.hitLen * stepDur), ve);
      var n = seq.notes && seq.notes[k];
      if (n) this.note(t, noteHz(ve, n), stepDur * 1.5, ve);
    }
    return last;
  };

  // live: start/stop on the real AudioContext; the studio reads frameAt() to keep the picture on the sound's clock
  // a looping silent sound file: on iPhone a playing <audio> moves Web Audio off the ringer channel, so the silent
  // switch no longer mutes it (navigator.audioSession does the same where it exists). It pauses other apps' music.
  function silentLoop() {
    var n = 4000, b = new ArrayBuffer(44 + n * 2), d = new DataView(b);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);
    d.setUint16(22, 1, true); d.setUint32(24, 8000, true); d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
    w(36, 'data'); d.setUint32(40, n * 2, true);
    var a = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
    a.loop = true; a.setAttribute('playsinline', ''); a.playsInline = true; a.disableRemotePlayback = true;
    return a;
  }
  DF.Live = function () { this.ctx = null; this.synth = null; this.t0 = 0; this.timer = 0; this.until = 0; this.unlock = null; };
  // call inside a tap: it creates / resumes the AudioContext and starts the silent loop within the gesture
  DF.Live.prototype.start = function (piece, frame, onStep) {
    var self = this;
    if (!this.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext; this.ctx = new AC({ latencyHint: 'interactive' });
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { }
      this.synth = new Synth(this.ctx);
      if (/iPhone|iPad|iPod/.test(navigator.userAgent)) try { this.unlock = silentLoop(); } catch (e) { }
    }
    if (this.unlock) this.unlock.play().catch(function () { });
    if (this.ctx.state !== 'running') this.ctx.resume();
    this.piece = piece; this.onStep = onStep;
    this.anchor(frame);
    clearInterval(this.timer);
    this.timer = setInterval(function () {
      var now = self.ctx.currentTime, to = now + 0.12, from = Math.max(self.until, now);   // never schedule the past
      if (to > from) { try { self.synth.schedule(self.piece, self.t0, from, to, self.onStep); } finally { self.until = to; } }
    }, 25);
  };
  // put frame `frame` at "now" on the sound clock (after a pause, an app switch or a stall)
  DF.Live.prototype.anchor = function (frame) { this.t0 = this.ctx.currentTime + 0.06 - frame / 60; this.until = this.ctx.currentTime + 0.05; };
  DF.Live.prototype.stop = function () { clearInterval(this.timer); this.timer = 0; if (this.unlock) this.unlock.pause(); if (this.ctx) this.ctx.suspend(); };
  DF.Live.prototype.running = function () { return !!this.timer && this.ctx && this.ctx.state === 'running'; };
  // the frame the listener is hearing now (output latency included where the browser reports it)
  DF.Live.prototype.frameAt = function () {
    var lat = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.max(0, Math.floor((this.ctx.currentTime - lat - this.t0) * 60));
  };

  // offline: the soundtrack for frames [0, frames) of a piece, as an AudioBuffer. rows: optional {step: lumas}.
  DF.renderSound = function (piece, frames, rows) {
    var sr = 48000, ctx = new OfflineAudioContext(2, Math.ceil(frames / 60 * sr), sr), syn = new Synth(ctx);
    syn.schedule(piece, 0, 0, frames / 60, function (k, fr) { if (rows && rows[fr]) syn.setRow(rows[fr]); });
    return ctx.startRendering();
  };
  DF.Synth = Synth; DF.noteHz = noteHz;
})();
