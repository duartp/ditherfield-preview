// ditherfield - palette maths: hex lists, OKLab, hue shift, palette from an image.
// Palettes live in the piece as hex strings, so whatever is computed here (in floats) is frozen into the state:
// the picture itself only ever sees the stored whole-number colours.
(function () {
  var C = DF.colour = {};

  C.toHex = function (rgb) {
    return '#' + rgb.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join('').toUpperCase();
  };
  // every colour in a pasted text: #rrggbb, rrggbb, #rgb, rgb(r,g,b); in order, max 16
  C.parseList = function (text) {
    var out = [], m, re = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)|#?\b([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
    while ((m = re.exec(text)) && out.length < 16) {
      if (m[1]) out.push(C.toHex([+m[1], +m[2], +m[3]]));
      else { var h = m[4]; if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; out.push('#' + h.toUpperCase()); }
    }
    return out;
  };

  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function gam(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return c * 255; }
  C.oklab = function (rgb) {
    var r = lin(rgb[0]), g = lin(rgb[1]), b = lin(rgb[2]);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  };
  C.rgb = function (lab) {
    var l = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    var m = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    var s = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2];
    l = l * l * l; m = m * m * m; s = s * s * s;
    return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            gam(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  };
  C.luma = function (hex) { var c = DF.hex(hex); return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); };

  // rotate hue in OKLCH, keeping lightness (so the ramp's brightness steps - what survives X - stay the same)
  C.shiftHue = function (stops, deg) {
    if (!deg) return stops.slice();
    var a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    return stops.map(function (h) {
      var L = C.oklab(DF.hex(h));
      return C.toHex(C.rgb([L[0], L[1] * ca - L[2] * sa, L[1] * sa + L[2] * ca]));
    });
  };
  C.sortByLight = function (stops) {
    return stops.slice().sort(function (x, y) { return C.oklab(DF.hex(x))[0] - C.oklab(DF.hex(y))[0]; });
  };

  // HSV <-> RGB for the picker
  C.hsvToRgb = function (h, s, v) {
    var f = function (n) { var k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5) * 255, f(3) * 255, f(1) * 255];
  };
  C.rgbToHsv = function (rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    return [h, mx ? d / mx : 0, mx];
  };

  // palette from an image: 5-bit histogram -> median cut in OKLab -> 10 rounds of k-means -> dark to light.
  // No randomness anywhere, so the same image always gives the same palette.
  C.fromImage = function (img, k) {
    k = Math.max(2, Math.min(16, k || 6));
    var cv = document.createElement('canvas'), sc = Math.min(1, 128 / Math.max(img.width, img.height));
    cv.width = Math.max(1, Math.round(img.width * sc)); cv.height = Math.max(1, Math.round(img.height * sc));
    var g = cv.getContext('2d'); g.drawImage(img, 0, 0, cv.width, cv.height);
    var px = g.getImageData(0, 0, cv.width, cv.height).data, hist = new Map();
    for (var i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      var key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
    var pts = [];
    hist.forEach(function (w, key) {
      var rgb = [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4];
      pts.push({ lab: C.oklab(rgb), w: w, key: key });
    });
    pts.sort(function (a, b) { return a.key - b.key; });
    var boxes = [pts];
    while (boxes.length < k) {
      var bi = -1, best = -1, axis = 0;
      boxes.forEach(function (b, idx) {
        if (b.length < 2) return;
        var tw = 0; b.forEach(function (p) { tw += p.w; });
        for (var ax = 0; ax < 3; ax++) {
          var lo = Infinity, hi = -Infinity; b.forEach(function (p) { lo = Math.min(lo, p.lab[ax]); hi = Math.max(hi, p.lab[ax]); });
          var score = (hi - lo) * Math.sqrt(tw);
          if (score > best) { best = score; bi = idx; axis = ax; }
        }
      });
      if (bi < 0) break;
      var box = boxes[bi].slice().sort(function (p, q) { return p.lab[axis] - q.lab[axis] || p.key - q.key; });
      var total = 0; box.forEach(function (p) { total += p.w; });
      var acc = 0, cut = 1;
      for (var j = 0; j < box.length - 1; j++) { acc += box[j].w; if (acc >= total / 2) { cut = j + 1; break; } }
      boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
    }
    var cents = boxes.map(function (b) {
      var s = [0, 0, 0], tw = 0; b.forEach(function (p) { for (var a = 0; a < 3; a++) s[a] += p.lab[a] * p.w; tw += p.w; });
      return s.map(function (v) { return v / tw; });
    });
    for (var it = 0; it < 10; it++) {
      var sum = cents.map(function () { return [0, 0, 0, 0]; });
      pts.forEach(function (p) {
        var bi2 = 0, bd = Infinity;
        cents.forEach(function (c, ci) { var d = (p.lab[0] - c[0]) ** 2 + (p.lab[1] - c[1]) ** 2 + (p.lab[2] - c[2]) ** 2; if (d < bd) { bd = d; bi2 = ci; } });
        for (var a = 0; a < 3; a++) sum[bi2][a] += p.lab[a] * p.w; sum[bi2][3] += p.w;
      });
      cents = cents.map(function (c, ci) { return sum[ci][3] ? [sum[ci][0] / sum[ci][3], sum[ci][1] / sum[ci][3], sum[ci][2] / sum[ci][3]] : c; });
    }
    cents.sort(function (a, b) { return a[0] - b[0]; });
    return cents.map(function (c) { return C.toHex(C.rgb(c)); });
  };
})();
