// ditherfield - GLSL for every pass. Whole numbers wherever a decision is made (see js/gl.js for why).
// Sort passes follow the research bench (2026-09-23), where every sort was checked bit for bit against a CPU sort:
// integer 'digital lines' for any angle, spans found by a Hillis-Steele scan, segmented bitonic for the instant
// filter, odd-even transposition for the process, home-sort for the way back, and the hole-free blend sweep.
(function () {
  var H = DF.GL.HEADER;
  var SIN = 'const int SIN_T[257] = int[257](' + DF.SIN257.join(',') + ');\n' +
    'int isin(uint ph){ uint p = ph & 0xFFFFu; uint i = p >> 8u; int f = int(p & 0xFFu);' +
    ' int a = SIN_T[i]; int b = SIN_T[i + 1u]; return a + (((b - a) * f) >> 8); }\n' +
    'int icos(uint ph){ return isin(ph + 16384u); }\n' +
    'uint isqrt(uint n){ uint s = uint(sqrt(float(n))); while (s * s > n) s--; while ((s + 1u) * (s + 1u) <= n) s++; return s; }\n';

  // lines along the sort direction: u = position along the line, L = which line (exact integers, a bijection)
  var LINES =
    'uniform ivec2 uSize; uniform int uSlopeP; uniform bool uSwap;\n' +
    'int off(int u){ return (u * uSlopeP + 512) >> 10; }\n' +
    'int alongLen(){ return uSwap ? uSize.y : uSize.x; }\n' +
    'int crossLen(){ return uSwap ? uSize.x : uSize.y; }\n' +
    'ivec2 toLine(ivec2 p){ int u = uSwap ? p.y : p.x; int v = uSwap ? p.x : p.y; return ivec2(u, v - off(u)); }\n' +
    'bool toPix(int u, int L, out ivec2 p){ p = ivec2(0); if (u < 0 || u >= alongLen()) return false;' +
    ' int v = L + off(u); if (v < 0 || v >= crossLen()) return false; p = uSwap ? ivec2(v, u) : ivec2(u, v); return true; }\n';

  var S = DF.SHADERS = {};

  // ---- SOURCE: value 0..255 in r, layer id in g (0 ground, 1 stripes, 2 rings, 3 type)
  S.source = H + SIN + [
    'uniform ivec2 uSize;',
    'uniform int uBg;',
    'uniform int uStOn, uStGain, uStCut, uStMode; uniform uint uStC, uStS, uStPer, uStPh;',
    'uniform int uRgOn, uRgN, uRgGain, uRgCut, uRgMode, uRgOrbR; uniform ivec2 uRgC; uniform uint uRgPer, uRgPh, uRgOrbPh;',
    'uniform int uTyOn, uTyVal, uTyMode, uTyMix; uniform sampler2D uType, uType2;',
    'const int BY4[16] = int[16](0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);',
    'bool typeAt(ivec2 p){ ivec2 q = ivec2(p.x, uSize.y - 1 - p.y); bool b = uTyMix > 0 && BY4[(p.y & 3) * 4 + (p.x & 3)] * 256 + 128 < uTyMix;',
    '  return (b ? texelFetch(uType2, q, 0).r : texelFetch(uType, q, 0).r) > 0.5; }',
    'out uvec4 o;',
    'int shape(int s, int gain){ int v = (s + 32768) >> 8; v = (((v - 128) * gain) >> 8) + 128; return clamp(v, 0, 255); }',
    'int blend(int acc, int v, int mode){',
    '  if (mode == 1) return max(acc, v); if (mode == 2) return min(acc, v);',
    '  if (mode == 3) return abs(acc - v); if (mode == 4) return min(255, acc + v); return v; }',
    'void main(){',
    '  ivec2 p = ivec2(gl_FragCoord.xy); uint x = uint(p.x), y = uint(p.y);',
    '  int acc = uBg; int id = 0;',
    '  if (uStOn != 0) {',
    // signed projection in two's complement: only the low 16 bits of the phase matter, and uint wrap keeps them exact
    '    uint proj = x * uStC + y * uStS;',
    '    uint ph = ((proj * uStPer) >> 15) + uStPh;',
    '    int v = shape(isin(ph), uStGain);',
    '    if (v >= uStCut) { acc = blend(acc, v, uStMode); id = 1; }',
    '  }',
    '  if (uRgOn != 0) {',
    '    int sum = 0;',
    '    for (int k = 0; k < 4; k++) {',
    '      if (k >= uRgN) break;',
    '      uint a = uRgOrbPh + uint(k) * (65536u / uint(uRgN));',
    '      ivec2 c = uRgC + ivec2((uRgOrbR * icos(a)) >> 15, (uRgOrbR * isin(a)) >> 15);',   // Q4 px
    '      ivec2 d = p * 16 + 8 - c;',
    '      uint dist = isqrt(uint(d.x * d.x + d.y * d.y));',                                // Q4 px
    '      sum += isin(((dist * uRgPer) >> 4) - uRgPh);',
    '    }',
    '    int v = shape(sum / uRgN, uRgGain);',
    '    if (v >= uRgCut) { acc = blend(acc, v, uRgMode); id = 2; }',
    '  }',
    '  if (uTyOn != 0 && typeAt(p)) {',
    '    if (uTyMode == 1) acc = uBg; else if (uTyMode == 2) acc = 255 - acc; else acc = uTyVal;',
    '    id = 3;',
    '  }',
    '  o = uvec4(uint(acc), uint(id), 0u, 255u);',
    '}'
  ].join('\n');

  // a sort hit opens lines one by one (a fixed random order): a line whose hash is below uOpen (0..4096) sorts with
  // the window wide open (0..255) at full length. Mirrored in js/selftest.js (lineOpen).
  var OPEN = 'uniform int uOpen;\n' +
    'bool lineOpen(int L){ uint h = uint(L + 8192) * 2654435761u; h ^= h >> 16u; return int(h & 4095u) < uOpen; }\n';

  // ---- spans: runs of positions whose source value sits inside [lo, hi]; outside pixels are their own span
  S.spanInit = H + LINES + OPEN + [
    'uniform usampler2D uSrc; uniform int uLo, uHi; out ivec4 o;',
    'bool maskAt(int u, int L){ ivec2 p; if (!toPix(u, L, p)) return false; int v = int(texelFetch(uSrc, p, 0).r);',
    '  return lineOpen(L) || (v >= uLo && v <= uHi); }',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p); int u = uL.x, L = uL.y;',
    '  if (!maskAt(u, L)) { o = ivec4(u, u, 0, 0); return; }',
    '  o = ivec4(maskAt(u - 1, L) ? -1 : u, maskAt(u + 1, L) ? (1 << 30) : u, 0, 0); }'
  ].join('\n');
  S.spanScan = H + LINES + [
    'uniform isampler2D uSpan; uniform int uD; out ivec4 o;',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p); ivec2 v = texelFetch(uSpan, p, 0).xy; ivec2 q;',
    '  if (toPix(uL.x - uD, uL.y, q)) v.x = max(v.x, texelFetch(uSpan, q, 0).x);',
    '  if (toPix(uL.x + uD, uL.y, q)) v.y = min(v.y, texelFetch(uSpan, q, 0).y);',
    '  o = ivec4(v, 0, 0); }'
  ].join('\n');
  // longest run and per-band amount: long runs are cut into pieces of at most cap; a band at 0 does not sort
  S.spanCap = H + LINES + OPEN + [
    'uniform isampler2D uSpan; uniform int uMax, uBands, uLmin, uLspan, uOpenAmt; uniform int uBandAmt[32]; out ivec4 o;',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p); ivec2 sp = texelFetch(uSpan, p, 0).xy;',
    '  int band = clamp(((uL.y - uLmin) * uBands) / uLspan, 0, uBands - 1); int amt = lineOpen(uL.y) ? uOpenAmt : uBandAmt[band];',
    '  int cap = max(1, (uMax * amt) >> 8);',
    '  if (amt <= 0 || sp.y <= sp.x) { o = ivec4(uL.x, uL.x, 0, 0); return; }',
    '  int cs = sp.x + ((uL.x - sp.x) / cap) * cap;',
    '  o = ivec4(cs, min(sp.y, cs + cap - 1), 0, 0); }'
  ].join('\n');

  // ---- sort state: key = value << 16 | home (position along the line). Keys are unique, so every sort is exact.
  S.stateInit = H + LINES + [
    'uniform usampler2D uSrc; out uvec4 o;',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p);',
    '  o = uvec4((texelFetch(uSrc, p, 0).r << 16) | uint(uL.x), 0u, 0u, 0u); }'
  ].join('\n');
  // process mode: re-read each pixel's value at its HOME, so the source keeps moving under a sorted state
  S.refresh = H + LINES + [
    'uniform usampler2D uSrc, uState; out uvec4 o;',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p); uint home = texelFetch(uState, p, 0).x & 0xFFFFu;',
    '  ivec2 hp; toPix(int(home), uL.y, hp); o = uvec4((texelFetch(uSrc, hp, 0).r << 16) | home, 0u, 0u, 0u); }'
  ].join('\n');
  S.oddEven = H + LINES + [
    'uniform usampler2D uState; uniform isampler2D uSpan; uniform int uT; uniform bool uDesc, uHome; out uvec4 o;',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p); int u = uL.x; uint a = texelFetch(uState, p, 0).x;',
    // per-line parity phase: without it all lines swap in step and the picture shows vertical ribbing
    '  int ph = (((uL.y + 8192) * 40503) >> 9) & 1;',
    '  bool left = ((u + uT + ph) & 1) == 0; int pu = left ? u + 1 : u - 1;',
    '  ivec2 sp = uHome ? ivec2(-1, 1 << 30) : texelFetch(uSpan, p, 0).xy; ivec2 q;',
    '  if (pu < sp.x || pu > sp.y || !toPix(pu, uL.y, q)) { o = uvec4(a); return; }',
    '  uint b = texelFetch(uState, q, 0).x;',
    '  uint ka = uHome ? (a & 0xFFFFu) : a; uint kb = uHome ? (b & 0xFFFFu) : b;',
    '  bool asc = uHome || !uDesc;',
    '  bool takeB = (left == asc) ? (kb < ka) : (kb > ka);',
    '  o = uvec4(takeB ? b : a); }'
  ].join('\n');
  S.bitonic = H + LINES + [
    'uniform usampler2D uState; uniform isampler2D uSpan; uniform int uK, uJ; uniform bool uFlip, uDesc; out uvec4 o;',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p); uint a = texelFetch(uState, p, 0).x;',
    '  ivec2 sp = texelFetch(uSpan, p, 0).xy; int i = uL.x - sp.x; int n = sp.y - sp.x + 1;',
    '  int l = uFlip ? (i ^ ((1 << uK) - 1)) : (i ^ (1 << uJ)); ivec2 q;',
    '  if (l >= n || !toPix(sp.x + l, uL.y, q)) { o = uvec4(a); return; }',
    '  uint b = texelFetch(uState, q, 0).x; bool keepMin = (i < l) != uDesc;',
    '  o = uvec4(keepMin ? min(a, b) : max(a, b)); }'
  ].join('\n');
  // blend sweep: invert the sorted state (dest of each home) with one point per pixel...
  S.invVS = H + LINES + [
    'uniform usampler2D uState; flat out uint vV;',
    'void main(){ int id = gl_VertexID; ivec2 p = ivec2(id % uSize.x, id / uSize.x); ivec2 uL = toLine(p);',
    '  int h = int(texelFetch(uState, p, 0).x & 0xFFFFu); ivec2 q; toPix(h, uL.y, q); vV = uint(uL.x);',
    '  gl_PointSize = 1.0; gl_Position = vec4((vec2(q) + 0.5) / vec2(uSize) * 2.0 - 1.0, 0.0, 1.0); }'
  ].join('\n');
  S.invFS = H + 'flat in uint vV; out uvec4 o; void main(){ o = uvec4(vV, 0u, 0u, 0u); }';
  // ...then key = round(mix(home, dest, t) * 32): sorting by it is a permutation at every t, home at 0, sorted at 1
  // Together (uTogether): every line moves at once and each pixel runs on its own clock - the hit's phase minus a delay
  // from its rank ('lands first'), through the chosen ease (iease = mod.js DF.iease). Mirrored in selftest.js cpuSweep.
  S.blendInit = H + LINES + [
    'uniform usampler2D uDestOfHome, uSrc; uniform isampler2D uEase; out uvec4 o;',
    'uniform int uT, uStag, uTogether, uStagBy, uExit, uPh, uFall, uKind;',            // uT, uStag, uPh: 0..4096
    'int iease(int kind, int x){',
    '  if (kind == 0) return (x * x / 4096) * (3 * 4096 - 2 * x) / 4096;',
    '  if (kind == 1) return x;',
    '  if (kind == 5) return ((x * 4) >> 12) * 1024;',
    '  int row = kind == 2 ? 0 : kind == 3 ? 1 : kind == 4 ? 2 : 3;',
    '  int i = min(255, x >> 4); int a = texelFetch(uEase, ivec2(i, row), 0).r; int b = texelFetch(uEase, ivec2(i + 1, row), 0).r;',
    '  return a + (((b - a) * (x - i * 16)) >> 4); }',
    // lands first: a rank 0..255 of the home pixel (GL coordinates: y up), lower = earlier
    'int rankOf(ivec2 p, int lum, int L){ int W1 = max(1, uSize.x - 1), H1 = max(1, uSize.y - 1);',
    '  if (uStagBy == 1) return p.x * 255 / W1;',
    '  if (uStagBy == 2) return 255 - p.x * 255 / W1;',
    '  if (uStagBy == 3) return (uSize.y - 1 - p.y) * 255 / H1;',
    '  if (uStagBy == 4) return p.y * 255 / H1;',
    '  if (uStagBy == 5 || uStagBy == 6) { int c = max(abs(2 * p.x - uSize.x + 1) * 255 / W1, abs(2 * p.y - uSize.y + 1) * 255 / H1); return uStagBy == 5 ? c : 255 - c; }',
    '  if (uStagBy == 7) return int((uint(L + 8192) * 2246822519u) >> 24);',
    '  return 255 - lum; }',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p); int d = int(texelFetch(uDestOfHome, p, 0).x);',
    '  int lum = int(texelFetch(uSrc, p, 0).r); int r = rankOf(p, lum, uL.y);',
    '  if (uTogether == 0) {',
    '    int s = 255 - r;',                                                                  // bright first: s = lum, as always
    '    int ti = clamp(((uT - (uStag * s) / 255) * 4096) / max(1, 4096 - uStag), 0, 4096);',
    '    ti = (ti * ti / 4096) * (3 * 4096 - 2 * ti) / 4096;',                              // smoothstep, fixed point
    '    int k = (uL.x * 32 * (4096 - ti) + d * 32 * ti + 2048) / 4096;',
    '    o = uvec4((uint(k) << 16) | uint(uL.x), 0u, 0u, 0u); return; }',
    '  int s = uFall != 0 ? r : (uExit == 0 ? r : uExit == 1 ? 255 - r : 0);',
    '  int num = (uPh - (uStag * s) / 255) * 4096;',
    '  int lin = num <= 0 ? 0 : min(4096, num / max(1, 4096 - uStag));',
    '  int e = iease(uKind, lin); int ti = uFall != 0 ? 4096 - e : e;',                    // overshoot: ti a bit past 0 / 4096
    '  int k = (uL.x * 32 * (4096 - ti) + d * 32 * ti + 2048 + 16384 * alongLen()) / 4096;', // + 4 * along keeps it positive
    '  o = uvec4((uint(k) << 16) | uint(uL.x), 0u, 0u, 0u); }'
  ].join('\n');

  // ---- COLOUR + DITHER at the art grid: one art pixel = one dither cell
  S.colour = H + LINES + [
    'uniform usampler2D uSrc, uState; uniform int uSortOn, uDither, uColMode, uNA, uNB, uXfade, uLevels,',
    '  uSpread, uDithHome, uSortedPal, uCycA, uCycB; uniform vec3 uPalA[16], uPalB[16]; uniform ivec3 uPalAi[16], uPalBi[16];',
    'uniform int uLayerPal[4]; uniform sampler2D uBlue;',
    'const int B4[16] = int[16](0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);',
    'int thr(ivec2 q){',                                                             // 1..254
    '  if (uDither == 0) { int v = ((q.x ^ q.y) & 1) * 2 + (q.y & 1); return v * 64 + 32; }',
    '  if (uDither == 1) return B4[(q.y & 3) * 4 + (q.x & 3)] * 16 + 8;',
    '  if (uDither == 2) { int x = q.x & 7, y = q.y & 7, xr = x ^ y;',
    '    int v = ((xr & 1) << 5) | ((y & 1) << 4) | ((xr & 2) << 2) | ((y & 2) << 1) | ((xr & 4) >> 1) | ((y & 4) >> 2); return v * 4 + 2; }',
    '  return int(texelFetch(uBlue, q & 63, 0).r * 255.0 + 0.5); }',
    'out vec4 o;',
    'void main(){',
    '  ivec2 p = ivec2(gl_FragCoord.xy); ivec2 hp = p; bool moved = false;',
    '  if (uSortOn != 0) { ivec2 uL = toLine(p); int h = int(texelFetch(uState, p, 0).x & 0xFFFFu); toPix(h, uL.y, hp); moved = h != uL.x; }',
    '  uvec4 s = texelFetch(uSrc, hp, 0); int v = int(s.r); int id = int(s.g);',
    '  int t = thr(uDithHome != 0 ? hp : p);',
    '  int pal = (moved && uSortedPal >= 0) ? uSortedPal : uLayerPal[id];',
    '  if (uXfade > 0 && ((t * 256) / 255) < uXfade) pal = 1 - pal;',                      // dithered crossfade A <-> B
    '  int n = pal == 0 ? uNA : uNB;',
    '  vec3 c;',
    '  int sx = v * (n - 1); int i = sx / 255; int f = sx - i * 255; if (i >= n - 1) { i = n - 2; f = 255; }',
    '  if (uColMode == 0) {',                                                          // gradient map
    '    int idx = ((f * 256) / 255 > t) ? i + 1 : i;',
    '    idx = (idx + (pal == 0 ? uCycA : uCycB)) % n;',
    '    c = pal == 0 ? uPalA[idx] : uPalB[idx];',
    '  } else {',
    // modes 1 and 2 start from the smooth colour along the palette (no dither yet), in whole numbers
    '    ivec3 a = pal == 0 ? uPalAi[i] : uPalBi[i]; ivec3 b = pal == 0 ? uPalAi[i + 1] : uPalBi[i + 1];',
    '    ivec3 sm = (a * (255 - f) + b * f + 127) / 255;',
    '    if (uColMode == 1) {',                                                         // nearest palette colour
    '    ivec3 src = sm + ivec3(((t - 128) * uSpread) / 256);',
    '    int best = 0; int bd = 0x7fffffff;',
    '    for (int k = 0; k < 16; k++) { if (k >= n) break; ivec3 q = pal == 0 ? uPalAi[k] : uPalBi[k]; ivec3 d = src - q;',
    '      int e = 3 * d.r * d.r + 4 * d.g * d.g + 2 * d.b * d.b; if (e < bd) { bd = e; best = k; } }',
    '    c = pal == 0 ? uPalA[best] : uPalB[best];',
    '    } else {',                                                                    // per channel, L levels (TD look)
    '    int L1 = uLevels - 1; ivec3 q = (sm * L1 + t) / 255; c = vec3(q) / float(L1);',
    '    }',
    '  }',
    '  o = vec4(c, 1.0);',
    '}'
  ].join('\n');

  // views for the stage switch: raw source value, and sort state (where each pixel came from)
  S.viewSource = H + 'uniform usampler2D uSrc; out vec4 o; void main(){ float v = float(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r) / 255.0; o = vec4(v, v, v, 1.0); }';
  S.viewSorted = H + LINES + [
    'uniform usampler2D uSrc, uState; out vec4 o;',
    'void main(){ ivec2 p = ivec2(gl_FragCoord.xy); ivec2 uL = toLine(p); int h = int(texelFetch(uState, p, 0).x & 0xFFFFu); ivec2 q; toPix(h, uL.y, q);',
    '  float v = float(texelFetch(uSrc, q, 0).r) / 255.0; o = vec4(v, v, v, 1.0); }'
  ].join('\n');

  // ---- POST + whole-number upscale to the output size. Display only: never part of a seed's identity.
  S.post = H + [
    'uniform sampler2D uCol; uniform ivec2 uGrid; uniform int uK, uScan, uCurve, uVig; out vec4 o;',
    'void main(){',
    '  vec2 outSize = vec2(uGrid * uK); vec2 uv = gl_FragCoord.xy / outSize;',
    '  if (uCurve > 0) { vec2 c = uv * 2.0 - 1.0; c *= 1.0 + float(uCurve) / 100.0 * 0.12 * dot(c, c); uv = c * 0.5 + 0.5;',
    '    if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; } }',
    '  vec2 gp = uv * vec2(uGrid); ivec2 g = ivec2(floor(gp));',
    '  vec3 c = texelFetch(uCol, clamp(g, ivec2(0), uGrid - 1), 0).rgb;',
    // one scanline per art row, on its bottom third: the line pitch equals the cell, so X keeps it
    '  if (uScan > 0 && fract(gp.y) < 0.34) c *= 1.0 - float(uScan) / 100.0 * 0.7;',
    '  if (uVig > 0) { vec2 d = uv * 2.0 - 1.0; c *= clamp(1.0 - float(uVig) / 100.0 * 0.45 * dot(d, d), 0.0, 1.0); }',
    '  o = vec4(c, 1.0);',
    '}'
  ].join('\n');
})();
