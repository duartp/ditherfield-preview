// ditherfield - seeds, the dial list, and the generator that turns a seed into a piece.
// Every dial is a whole number: the same numbers give the same picture on every machine, and the URL can carry them
// as small integers. Speeds are counted in cycles per loop, so every piece loops perfectly.
(function () {
  // ---------------------------------------------------------------- seeds
  // Canonical form of whatever gets pasted (research 2026-09-23): hex hashes and EVM addresses lower-case, base58
  // (Solana, Tezos, fxhash) keeps its case, explorer URLs reduce to their hash, anything else is text (NFC, trimmed).
  var B58 = '[1-9A-HJ-NP-Za-km-z]';
  var RULES = [
    [/^(0x)?[0-9a-f]{64}$/i, function (s) { return '0x' + s.replace(/^0x/i, '').toLowerCase(); }],
    [/^0x[0-9a-f]{40}$/i, function (s) { return s.toLowerCase(); }],
    [/^[0-9a-f]{64}i\d+$/i, function (s) { return s.toLowerCase(); }],
    [/^(bc1|tb1)[0-9a-z]{8,87}$/i, function (s) { return s.toLowerCase(); }],
    [new RegExp('^o' + B58 + '{50}$'), null],
    [new RegExp('^(tz[1-4]|KT1)' + B58 + '{33}$'), null],
    [new RegExp('^' + B58 + '{32,90}$'), null]
  ];
  function canonical(input) {
    var s = String(input == null ? '' : input).normalize('NFC').trim();
    if (/^https?:\/\//i.test(s)) {
      var toks = s.split(/[\/?#=&]/).reverse();
      for (var t = 0; t < toks.length; t++) {
        for (var r = 0; r < RULES.length - 1; r++) if (RULES[r][0].test(toks[t])) return RULES[r][1] ? RULES[r][1](toks[t]) : toks[t];
      }
    }
    for (var i = 0; i < RULES.length; i++) if (RULES[i][0].test(s)) return RULES[i][1] ? RULES[i][1](s) : s;
    return s.replace(/\s+/g, ' ');
  }
  // cyrb128 (bryc): 128-bit seed hash over UTF-8 bytes. Math.imul / xor / shifts only, so it ports to any language.
  function cyrb128(str) {
    var b = new TextEncoder().encode(str);
    var h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (var i = 0, k; i < b.length; i++) {
      k = b[i];
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
  }
  function sfc32(a, b, c, d) {
    return function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      var t = (a + b | 0) + d | 0;
      d = d + 1 | 0; a = b ^ b >>> 9; b = c + (c << 3) | 0; c = (c << 21 | c >>> 11); c = c + t | 0;
      return t >>> 0;
    };
  }
  // Named streams: adding a new random choice later never shifts the ones that exist (frozen recipe, v1).
  function seedStreams(input) {
    var canon = canonical(input), root = cyrb128('ditherfield/v1:' + canon);
    return {
      canonical: canon,
      stream: function (name) {
        var h = cyrb128(name), g = sfc32(root[0] ^ h[0], root[1] ^ h[1], root[2] ^ h[2], root[3] ^ h[3]);
        for (var i = 0; i < 12; i++) g();
        var R = {
          u32: g,
          int: function (lo, hi) { return lo + (g() % (hi - lo + 1)); },
          chance: function (pct) { return (g() % 100) < pct; },
          pick: function (arr) { return arr[g() % arr.length]; },
          weighted: function (pairs) { // [[value, weight], ...]
            var tot = 0, i; for (i = 0; i < pairs.length; i++) tot += pairs[i][1];
            var x = g() % tot; for (i = 0; i < pairs.length; i++) { if (x < pairs[i][1]) return pairs[i][0]; x -= pairs[i][1]; }
            return pairs[0][0];
          }
        };
        return R;
      }
    };
  }
  // A fresh seed that looks like a real token hash (0x + 64 hex). getRandomValues works on file:// and plain http.
  function randomSeed() {
    var a = new Uint8Array(32); crypto.getRandomValues(a);
    return '0x' + Array.prototype.map.call(a, function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }
  DF.seed = { canonical: canonical, cyrb128: cyrb128, sfc32: sfc32, streams: seedStreams, random: randomSeed };

  // ---------------------------------------------------------------- dials
  // id: stable number for the URL (never reuse one). g: panel group. All values are integers.
  var BLEND = ['over', 'max', 'min', 'difference', 'add'];
  var P = [
    { id: 1,  k: 'aspect',   g: 'frame',   l: 'shape',            opts: ['4:5', '1:1', '9:16'], d: 0 },
    { id: 2,  k: 'grid',     g: 'frame',   l: 'grid width (px)',  opts: ['90', '108', '120', '135', '180', '216', '270', '360', '540'], d: 4 },
    { id: 3,  k: 'bars',     g: 'frame',   l: 'bars per loop',    min: 1, max: 8, st: 1, d: 2 },
    { id: 4,  k: 'step',     g: 'frame',   l: 'step (frames)',    min: 5, max: 15, st: 1, d: 8 },
    { id: 5,  k: 'clip',     g: 'frame',   l: 'clip length (s)',  min: 1, max: 60, st: 1, d: 8 },
    { id: 6,  k: 'clipWhole', g: 'frame',  l: 'clip ends',        opts: ['exactly', 'on a whole loop'], d: 1 },

    { id: 10, k: 'bg',       g: 'source',  l: 'ground',           min: 0, max: 255, st: 1, d: 0 },
    { id: 11, k: 'stOn',     g: 'stripes', l: 'stripes',          opts: ['off', 'on'], d: 1 },
    { id: 12, k: 'stAngle',  g: 'stripes', l: 'angle (deg)',      min: 0, max: 179, st: 1, d: 90 },
    { id: 13, k: 'stPeriod', g: 'stripes', l: 'period (px)',      min: 3, max: 240, st: 1, d: 24 },
    { id: 14, k: 'stSpeed',  g: 'stripes', l: 'speed (per loop)', min: -16, max: 16, st: 1, d: 1 },
    { id: 15, k: 'stGain',   g: 'stripes', l: 'contrast',         min: 16, max: 2048, st: 16, d: 256 },
    { id: 16, k: 'stCut',    g: 'stripes', l: 'cut below',        min: 0, max: 255, st: 1, d: 0 },
    { id: 17, k: 'stMode',   g: 'stripes', l: 'blend',            opts: BLEND, d: 0 },

    { id: 20, k: 'rgOn',     g: 'rings',   l: 'rings',            opts: ['off', 'on'], d: 1 },
    { id: 21, k: 'rgX',      g: 'rings',   l: 'centre x (%)',     min: 0, max: 100, st: 1, d: 50 },
    { id: 22, k: 'rgY',      g: 'rings',   l: 'centre y (%)',     min: 0, max: 100, st: 1, d: 50 },
    { id: 23, k: 'rgPeriod', g: 'rings',   l: 'period (px)',      min: 3, max: 240, st: 1, d: 20 },
    { id: 24, k: 'rgSpeed',  g: 'rings',   l: 'speed (per loop)', min: -16, max: 16, st: 1, d: 1 },
    { id: 25, k: 'rgGain',   g: 'rings',   l: 'contrast',         min: 16, max: 2048, st: 16, d: 256 },
    { id: 26, k: 'rgCut',    g: 'rings',   l: 'cut below',        min: 0, max: 255, st: 1, d: 0 },
    { id: 27, k: 'rgMode',   g: 'rings',   l: 'blend',            opts: BLEND, d: 3 },
    { id: 28, k: 'rgCount',  g: 'rings',   l: 'orbits',           min: 1, max: 4, st: 1, d: 1 },
    { id: 29, k: 'rgOrbit',  g: 'rings',   l: 'orbit size (%)',   min: 0, max: 60, st: 1, d: 0 },
    { id: 30, k: 'rgOrbSpd', g: 'rings',   l: 'orbit speed',      min: -8, max: 8, st: 1, d: 1 },

    { id: 40, k: 'tyOn',     g: 'type',    l: 'type',             opts: ['off', 'on'], d: 0 },
    { id: 41, k: 'tyFont',   g: 'type',    l: 'font',             opts: [], d: 0 },          // filled from DF.FONTS
    { id: 42, k: 'tySize',   g: 'type',    l: 'size (px)',        min: 8, max: 240, st: 1, d: 44 },
    { id: 43, k: 'tyX',      g: 'type',    l: 'x (%)',            min: 0, max: 100, st: 1, d: 50 },
    { id: 44, k: 'tyY',      g: 'type',    l: 'y (%)',            min: 0, max: 100, st: 1, d: 50 },
    { id: 45, k: 'tyTrack',  g: 'type',    l: 'tracking',         min: -20, max: 60, st: 1, d: 0 },
    { id: 46, k: 'tyVal',    g: 'type',    l: 'brightness',       min: 0, max: 255, st: 1, d: 255 },
    { id: 47, k: 'tyMode',   g: 'type',    l: 'mode',             opts: ['solid', 'cut out', 'invert'], d: 0 },
    // words split by '|' in the text: each part of the loop gets the next word, changed at the top of a sort hit
    { id: 48, k: 'tyMorph',  g: 'type',    l: 'morph words',      opts: ['off', 'on the beat'], d: 0 },
    // hold still: only the hits that change the word sort (and sound); the word stays still between them
    { id: 67, k: 'hitsBetween', g: 'type', l: 'between word changes', opts: ['sort too', 'hold still'], d: 0 },
    { id: 49, k: 'tyAlign',  g: 'type',    l: 'align',            opts: ['centre', 'left', 'right'], d: 0 },
    // first line stays: the first line sits at the position, the rest hang below (GOOD -> GOOD / NIGHT keeps GOOD put)
    { id: 39, k: 'tyStack',  g: 'type',    l: 'lines',            opts: ['centred block', 'first line stays'], d: 0 },

    { id: 50, k: 'sortMode', g: 'sort',    l: 'sort',             opts: ['off', 'filter', 'process', 'sweep'], d: 2 },
    { id: 51, k: 'sortAng',  g: 'sort',    l: 'direction (deg)',  min: 0, max: 359, st: 1, d: 270 },
    { id: 52, k: 'sortLo',   g: 'sort',    l: 'dark threshold',   min: 0, max: 255, st: 1, d: 40 },
    { id: 53, k: 'sortHi',   g: 'sort',    l: 'bright threshold', min: 0, max: 255, st: 1, d: 230 },
    { id: 54, k: 'sortMax',  g: 'sort',    l: 'longest run (px)', min: 2, max: 540, st: 1, d: 120 },
    { id: 55, k: 'sortBands',g: 'sort',    l: 'bands',            min: 1, max: 32, st: 1, d: 8 },
    { id: 56, k: 'sortSpread', g: 'sort',  l: 'band variation',   min: 0, max: 100, st: 1, d: 60 },
    { id: 57, k: 'sortAmt',  g: 'sort',    l: 'amount (%)',       min: 0, max: 100, st: 1, d: 100 },
    { id: 58, k: 'procOut',  g: 'sort',    l: 'process: out share (%)', min: 10, max: 90, st: 1, d: 50 },
    { id: 59, k: 'procPass', g: 'sort',    l: 'process: passes / frame', min: 1, max: 16, st: 1, d: 2 },
    { id: 60, k: 'sweepStag',g: 'sort',    l: 'sweep: stagger (%)', min: 0, max: 90, st: 1, d: 30 },
    { id: 61, k: 'sortTint', g: 'sort',    l: 'sorted pixels use', opts: ['same colours', 'palette B'], d: 0 },
    // each sort hit opens sort lines one by one (whole window, full length; share = hit envelope x this dial), so every
    // beat sorts visibly whatever the window dials say; they set the look between hits (engine.js findSpans)
    { id: 62, k: 'beatOpen', g: 'sort',    l: 'beat opens window (%)', min: 0, max: 100, st: 1, d: 100 },
    // the shape of each hit: how the sort goes out, and how the pixels come home (mod.js DF.ease)
    { id: 63, k: 'easeOut',  g: 'sort',    l: 'ease out (sorting)', opts: ['smooth', 'linear', 'snap', 'slow start', 'bounce', 'steps', 'overshoot'], d: 0 },
    // type motion (2026-09-25). Every default is the code path as it was: old pieces and links look the same.
    // lines open: one by one (the beat's random line order) or together (every line at once; the stagger then decides who
    // moves first, pixel by pixel, through the chosen ease - the ease becomes visible)
    { id: 65, k: 'openHow',  g: 'sort',    l: 'lines open',       opts: ['one by one', 'together'], d: 0 },
    // which pixels land first (and leave first): by brightness as always, or by where they live
    { id: 66, k: 'stagBy',   g: 'sort',    l: 'stagger: lands first', opts: ['bright first', 'left first', 'right first', 'top first', 'bottom first', 'centre out', 'edges in', 'random lines'], d: 0 },
    { id: 80, k: 'stagExit', g: 'sort',    l: 'leaves',           opts: ['same order', 'reverse', 'all at once'], d: 0 },
    // the shape of a hit: out share (the rise) and a hold at the top, fully sorted, before coming home
    { id: 68, k: 'hitHold',  g: 'sort',    l: 'hold sorted (%)',  min: 0, max: 60, st: 1, d: 0 },
    { id: 69, k: 'hitRise',  g: 'sort',    l: 'out share (%)',    min: 5, max: 90, st: 1, d: 25 },
    { id: 64, k: 'easeBack', g: 'sort',    l: 'ease back (coming home)', opts: ['smooth', 'linear', 'snap', 'slow start', 'bounce', 'steps', 'overshoot'], d: 0 },

    { id: 70, k: 'dither',   g: 'colour',  l: 'dither',           opts: ['bayer 2', 'bayer 4', 'bayer 8', 'blue noise'], d: 1 },
    { id: 71, k: 'colMode',  g: 'colour',  l: 'colour mode',      opts: ['gradient map', 'nearest colour', 'per channel'], d: 0 },
    { id: 72, k: 'palA',     g: 'colour',  l: 'palette A',        opts: [], d: 2 },          // preset names
    { id: 73, k: 'palB',     g: 'colour',  l: 'palette B',        opts: [], d: 4 },
    { id: 74, k: 'xfade',    g: 'colour',  l: 'A to B',           min: 0, max: 100, st: 1, d: 0 },
    { id: 75, k: 'cycle',    g: 'colour',  l: 'palette cycle (per loop)', min: -8, max: 8, st: 1, d: 0 },
    { id: 76, k: 'levels',   g: 'colour',  l: 'levels (per channel)', min: 2, max: 6, st: 1, d: 2 },
    { id: 77, k: 'spread',   g: 'colour',  l: 'dither spread',    min: 0, max: 255, st: 1, d: 96 },
    { id: 78, k: 'dithHome', g: 'colour',  l: 'dither pattern',   opts: ['fixed to screen', 'travels with pixels'], d: 0 },
    { id: 79, k: 'hue',      g: 'colour',  l: 'hue shift (deg)',  min: 0, max: 359, st: 1, d: 0 },

    { id: 100, k: 'hitLen',  g: 'sound',   l: 'sort hit length (steps)', min: 1, max: 16, st: 1, d: 4 },
    { id: 101, k: 'scale',   g: 'sound',   l: 'scale',            opts: ['minor pent', 'major pent', 'dorian', 'phrygian', 'whole tone'], d: 0 },
    { id: 102, k: 'root',    g: 'sound',   l: 'root note',        min: 36, max: 60, st: 1, d: 45 },
    { id: 103, k: 'voice',   g: 'sound',   l: 'voice',            opts: ['pluck', 'pixel row', 'bell'], d: 0 },
    { id: 104, k: 'vol',     g: 'sound',   l: 'volume',           min: 0, max: 100, st: 1, d: 70 },
    { id: 105, k: 'thump',   g: 'sound',   l: 'thump on hits',    min: 0, max: 100, st: 1, d: 60 },
    { id: 90, k: 'scan',     g: 'post',    l: 'scanlines',        min: 0, max: 100, st: 1, d: 0 },
    { id: 91, k: 'curve',    g: 'post',    l: 'tube curve',       min: 0, max: 100, st: 1, d: 0 },
    { id: 92, k: 'vignette', g: 'post',    l: 'vignette',         min: 0, max: 100, st: 1, d: 0 }
  ];
  DF.PARAMS = P;
  DF.PARAM = {}; P.forEach(function (p) { DF.PARAM[p.k] = p; });
  DF.PALETTE_NAMES = Object.keys(DF.PRESETS);
  DF.PARAM.palA.opts = DF.PALETTE_NAMES; DF.PARAM.palB.opts = DF.PALETTE_NAMES;
  DF.PARAM.tyFont.opts = DF.FONTS.map(function (f) { return f.name; });

  DF.defaults = function () {
    var v = {}; P.forEach(function (p) { v[p.k] = p.d; });
    return v;
  };
  DF.clampParam = function (k, x) {
    var p = DF.PARAM[k];
    if (p.opts) return Math.max(0, Math.min(p.opts.length - 1, Math.round(x)));
    return Math.max(p.min, Math.min(p.max, Math.round(x)));
  };

  // ---------------------------------------------------------------- the generator: seed -> piece
  // One named stream per concern. Taste lives here: which combinations are allowed and how often.
  DF.fromSeed = function (input) {
    var S = seedStreams(input), v = DF.defaults();
    // loop lengths that divide 8 s (480 frames): an 8 s clip is always whole loops, so it loops perfectly on X
    var f = S.stream('frame'), bs = f.weighted([[[1, 10], 20], [[3, 10], 15], [[1, 15], 15], [[2, 15], 10], [[3, 5], 15], [[2, 5], 10], [[5, 6], 15]]);
    v.bars = bs[0]; v.step = bs[1];
    var src = S.stream('source');
    v.bg = src.weighted([[0, 70], [src.int(0, 60), 30]]);
    v.stOn = 1; v.rgOn = 1;
    var which = src.weighted([['both', 50], ['stripes', 20], ['rings', 30]]);
    if (which === 'stripes') v.rgOn = 0; if (which === 'rings') v.stOn = 0;
    v.stAngle = src.weighted([[0, 20], [90, 30], [45, 10], [135, 10], [src.int(0, 179), 30]]);
    v.stPeriod = src.int(12, 56); v.stSpeed = src.pick([-2, -1, 1, 1, 2, 3]);
    v.stGain = src.pick([256, 384, 512, 768, 1024]); v.stCut = src.weighted([[0, 75], [src.int(60, 160), 25]]);
    v.stMode = src.weighted([[0, 60], [1, 15], [3, 25]]);
    v.rgX = src.int(20, 80); v.rgY = src.int(20, 80); v.rgPeriod = src.int(14, 60); v.rgSpeed = src.pick([-2, -1, 1, 2]);
    v.rgGain = src.pick([256, 384, 512, 768]); v.rgCut = src.weighted([[0, 80], [src.int(60, 160), 20]]);
    v.rgMode = src.weighted([[0, 30], [3, 45], [1, 15], [2, 10]]);
    if (!v.stOn && v.rgMode === 2) v.rgMode = 0;          // rings alone, 'min' over a dark ground = a black piece
    v.rgCount = src.weighted([[1, 45], [2, 30], [3, 20], [4, 5]]);
    v.rgOrbit = v.rgCount > 1 ? src.int(8, 40) : src.weighted([[0, 60], [src.int(5, 30), 40]]);
    v.rgOrbSpd = src.pick([-1, 1, 1, 2]);
    var ty = S.stream('type');
    // type is optional: a quarter of the seeds, monospaced only (Gloock stays in the menu), centred and small
    v.tyOn = ty.chance(25) ? 1 : 0; v.tyFont = ty.int(1, Math.max(1, (DF.FONTS || [1, 1]).length - 1));
    v.tySize = ty.int(18, 32); v.tyX = 50; v.tyY = 50; v.tyMode = ty.weighted([[0, 80], [2, 12], [1, 8]]);
    var so = S.stream('sort');
    v.sortMode = so.weighted([[2, 45], [1, 30], [3, 25]]);
    v.sortAng = so.weighted([[270, 30], [90, 25], [0, 15], [180, 15], [so.int(0, 359), 15]]);
    // stripes alone: sort across them (within 60 deg of their normal), never along them, where sorting changes nothing
    if (!v.rgOn) {
      var normal = (v.stAngle + (so.chance(50) ? 0 : 180)) % 360;
      v.sortAng = (normal + so.int(-60, 60) + 360) % 360;
    }
    // the sort is the subject: wide windows, long runs, enough passes that the travel reads
    // whites inside the window (they drip), darks below it (they hold the runs apart): the classic pixel sort
    v.sortLo = so.int(8, 70); v.sortHi = so.weighted([[255, 75], [so.int(200, 254), 25]]); v.sortMax = so.pick([60, 90, 120, 180, 240, 240]);
    v.sortBands = so.pick([1, 4, 6, 8, 12, 16]); v.sortSpread = so.int(0, 80); v.sortAmt = so.int(80, 100);
    v.procOut = so.int(40, 65); v.procPass = so.pick([3, 4, 6, 8]); v.sweepStag = so.int(0, 60);
    v.sortTint = so.chance(30) ? 1 : 0;
    var co = S.stream('colour');
    var pal = co.weighted([['HEAT', 25], ['CYANO', 20], ['ACID', 20], ['MONO', 20], ['TD8', 15]]);
    v.palA = DF.PALETTE_NAMES.indexOf(pal);
    v.palB = DF.PALETTE_NAMES.indexOf(co.pick(['ACID', 'HEAT', 'CYANO', 'MONO']));
    v.colMode = pal === 'TD8' ? 2 : 0;
    v.dither = co.weighted([[1, 50], [2, 25], [0, 10], [3, 15]]);
    v.cycle = co.weighted([[0, 70], [co.pick([-1, 1]), 30]]);
    var layerPal = [0, 0, 0, co.chance(35) ? 1 : 0];
    // the 16-step lanes: sort hits (a rhythm) and notes (a melody on the scale)
    var sq = S.stream('seq');
    var euclid = function (k, rot) { var m = 0; for (var i = 0; i < k; i++) m |= 1 << ((Math.floor(i * 16 / k) + rot) % 16); return m; };
    var hits = sq.weighted([[euclid(4, 0), 25], [euclid(3, 0), 15], [euclid(5, sq.int(0, 3)), 15], [euclid(2, 0), 15],
                            [euclid(7, sq.int(0, 3)), 10], [1, 10], [0, 10]]);
    var notes = [];
    var density = sq.int(25, 70);
    for (var i = 0; i < 16; i++) notes.push(sq.chance(density) ? sq.int(1, 8) : 0);
    // every piece has hits: the sort is how the beat shows (a seed that drew none gets four on the floor)
    if (!hits) hits = euclid(4, 0);
    if (hits & 1) notes[0] = notes[0] || 1;
    v.hitLen = sq.pick([4, 4, 6, 8, 8]); v.scale = sq.int(0, 4); v.root = sq.int(40, 52); v.voice = sq.weighted([[0, 50], [1, 30], [2, 20]]);
    // sometimes one LFO, gentle
    var mods = {}, md = S.stream('mods');
    if (md.chance(35)) {
      var k = md.pick(['hue', 'sortLo', 'rgPeriod', 'stPeriod', 'xfade', 'tyY', 'sortAmt']);
      mods[k] = { shape: md.pick([0, 0, 1, 4]), rate: md.pick([1, 1, 2]), depth: md.int(10, 40), phase: 0 };
    }
    var pA = DF.PRESETS[DF.PALETTE_NAMES[v.palA]].stops.slice(), pB = DF.PRESETS[DF.PALETTE_NAMES[v.palB]].stops.slice();
    return { seed: S.canonical, v: v, text: shortText(S.canonical), palA: pA, palB: pB, layerPal: layerPal,
             seq: { hits: hits, notes: notes }, mods: mods };
  };
  // The piece carries its own seed as text: a hash shows as 0x3fa9..., plain text as itself.
  function shortText(c) {
    if (/^0x[0-9a-f]{40,64}$/.test(c)) return c.slice(0, 6);
    return c.length > 12 ? c.slice(0, 12) : (c || 'ditherfield');
  }
})();
