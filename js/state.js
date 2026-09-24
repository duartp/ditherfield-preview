// ditherfield - the whole piece in the address: #h=<seed>&s=<state>.
// h is the seed in its canonical form (a hash stays readable in the link). s is a small versioned binary record,
// base64url, holding only what differs from the seed's own piece: changed dials, palettes, layer palettes, text,
// LFOs, the 16-step lanes. A CRC guards it; a damaged s falls back to the seed alone. Unknown sections are skipped,
// so older pages can still open newer links. Measured sizes (research): 94-608 characters for real states.
// FROZEN for v1 once the first link is public: DF.fromSeed, dial ids and ranges. A change means a new version byte.
(function () {
  var VERSION = 1;
  var T = { DIALS: 1, PAL_A: 2, PAL_B: 3, LAYERS: 4, TEXT: 5, MODS: 6, SEQ: 7 };

  function Writer() { this.b = []; }
  Writer.prototype.u8 = function (x) { this.b.push(x & 255); };
  Writer.prototype.vu = function (x) { x = x >>> 0; while (x >= 128) { this.b.push((x & 127) | 128); x >>>= 7; } this.b.push(x); };
  Writer.prototype.vs = function (x) { this.vu(((x << 1) ^ (x >> 31)) >>> 0); };           // zigzag
  Writer.prototype.bytes = function (a) { for (var i = 0; i < a.length; i++) this.b.push(a[i] & 255); };
  function Reader(b) { this.b = b; this.i = 0; }
  Reader.prototype.u8 = function () { if (this.i >= this.b.length) throw new Error('short'); return this.b[this.i++]; };
  Reader.prototype.vu = function () { var x = 0, s = 0, c; do { c = this.u8(); x |= (c & 127) << s; s += 7; } while (c & 128); return x >>> 0; };
  Reader.prototype.vs = function () { var z = this.vu(); return (z >>> 1) ^ -(z & 1); };

  function crc16(b) {
    var c = 0xFFFF;
    for (var i = 0; i < b.length; i++) { c ^= b[i] << 8; for (var k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; }
    return c;
  }
  function b64u(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64u(str) { var s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function palBytes(p) { var a = [p.length]; p.forEach(function (h) { a.push.apply(a, DF.hex(h)); }); return a; }
  function samePal(a, b) { return a && b && a.length === b.length && a.every(function (h, i) { return h.toUpperCase() === b[i].toUpperCase(); }); }
  function section(w, tag, fill) { var inner = new Writer(); fill(inner); if (!inner.b.length && tag !== T.MODS) return; w.u8(tag); w.vu(inner.b.length); w.bytes(inner.b); }

  DF.encodeState = function (piece) {
    var base = DF.pieceFromSeed(piece.seed), w = new Writer(), v = piece.v;
    w.u8(VERSION);
    section(w, T.DIALS, function (x) {
      DF.PARAMS.forEach(function (p) { if (v[p.k] !== base.v[p.k]) { x.vu(p.id); x.vs(v[p.k]); } });
    });
    if (!samePal(piece.palA, base.palA)) section(w, T.PAL_A, function (x) { x.bytes(palBytes(piece.palA)); });
    if (!samePal(piece.palB, base.palB)) section(w, T.PAL_B, function (x) { x.bytes(palBytes(piece.palB)); });
    var lp = piece.layerPal || [0, 0, 0, 0], blp = base.layerPal || [0, 0, 0, 0];
    if (lp.join() !== blp.join()) section(w, T.LAYERS, function (x) { x.u8(lp[0] | lp[1] << 1 | lp[2] << 2 | lp[3] << 3); });
    if ((piece.text || '') !== (base.text || '')) section(w, T.TEXT, function (x) { x.bytes(new TextEncoder().encode(piece.text || '')); });
    if (JSON.stringify(piece.mods || {}) !== JSON.stringify(base.mods || {})) {
      w.u8(T.MODS); var inner = new Writer(), keys = Object.keys(piece.mods || {});
      inner.u8(keys.length);
      keys.forEach(function (k) { var m = piece.mods[k]; inner.vu(DF.PARAM[k].id); inner.u8(m.shape); inner.u8(m.rate); inner.u8(m.depth); inner.u8(m.phase); });
      w.vu(inner.b.length); w.bytes(inner.b);
    }
    var sq = piece.seq || { hits: 0, notes: [] }, bs = base.seq || { hits: 0, notes: [] };
    if (sq.hits !== bs.hits || (sq.notes || []).join() !== (bs.notes || []).join()) section(w, T.SEQ, function (x) {
      x.u8(sq.hits & 255); x.u8(sq.hits >> 8 & 255);
      for (var i = 0; i < 16; i += 2) x.u8(((sq.notes[i] || 0) & 15) | (((sq.notes[i + 1] || 0) & 15) << 4));
    });
    if (w.b.length === 1) return 'h=' + encodeURIComponent(piece.seed).replace(/%3A/gi, ':');
    var c = crc16(w.b); w.u8(c >> 8); w.u8(c);
    return 'h=' + encodeURIComponent(piece.seed).replace(/%3A/gi, ':') + '&s=' + b64u(w.b);
  };

  // returns { piece, warning }
  DF.decodeState = function (hash) {
    var q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    var seed = q.get('h'); if (!seed) return { piece: null };
    var piece = DF.pieceFromSeed(seed), s = q.get('s');
    if (!s) return { piece: piece };
    try {
      var b = unb64u(s);
      if (b.length < 3 || crc16(b.subarray(0, b.length - 2)) !== ((b[b.length - 2] << 8) | b[b.length - 1])) throw new Error('the link was cut or changed (checksum)');
      var r = new Reader(b.subarray(0, b.length - 2)), ver = r.u8();
      if (ver !== VERSION) throw new Error('made with a newer version (' + ver + ')');
      var byId = {}; DF.PARAMS.forEach(function (p) { byId[p.id] = p; });
      while (r.i < r.b.length) {
        var tag = r.u8(), len = r.vu(), end = r.i + len, x = new Reader(r.b.subarray(r.i, end));
        if (tag === T.DIALS) while (x.i < x.b.length) { var p = byId[x.vu()], val = x.vs(); if (p) piece.v[p.k] = DF.clampParam(p.k, val); }
        else if (tag === T.PAL_A || tag === T.PAL_B) {
          var n = x.u8(), pal = []; for (var i = 0; i < n; i++) pal.push(DF.colour.toHex([x.u8(), x.u8(), x.u8()]));
          if (n >= 2) piece[tag === T.PAL_A ? 'palA' : 'palB'] = pal;
        } else if (tag === T.LAYERS) { var m = x.u8(); piece.layerPal = [m & 1, m >> 1 & 1, m >> 2 & 1, m >> 3 & 1]; }
        else if (tag === T.TEXT) piece.text = new TextDecoder().decode(x.b);
        else if (tag === T.MODS) {
          var cnt = x.u8(); piece.mods = {};
          for (var j = 0; j < cnt; j++) { var pp = byId[x.vu()], mm = { shape: x.u8(), rate: x.u8(), depth: x.u8(), phase: x.u8() }; if (pp) piece.mods[pp.k] = mm; }
        } else if (tag === T.SEQ) {
          var hits = x.u8() | (x.u8() << 8), notes = [];
          for (var k = 0; k < 8; k++) { var nb = x.u8(); notes.push(nb & 15, nb >> 4); }
          piece.seq = { hits: hits, notes: notes };
        }
        r.i = end;                                                          // unknown tags are skipped
      }
      return { piece: piece };
    } catch (e) {
      return { piece: DF.pieceFromSeed(seed), warning: 'Opened the seed only: ' + e.message };
    }
  };

  DF.pieceFromSeed = function (seed) {
    var p = DF.fromSeed(seed);
    p.salt = DF.seed.cyrb128('ditherfield/v1:' + p.seed)[0];
    return p;
  };
})();
