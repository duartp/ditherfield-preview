// ditherfield - shared namespace and small helpers.
// Classic scripts only: a page opened by double-click (file://) cannot load modules, fetch local files or start
// workers from a file path (measured in Chrome 152). Everything hangs off one global, DF.
var DF = window.DF || (window.DF = {});
DF.VERSION = '0.1.0';

// Save a Blob as a download. Works on file:// and https without a user gesture at that moment (measured).
DF.saveBlob = function (blob, name) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
};

// 20260923-2315 style stamp for file names (display only; never feeds the picture).
DF.stamp = function () {
  var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
};

DF.hex = function (h) {
  h = h.replace('#', '');
  return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
};

// Palettes the engine starts from. Stops run dark to light so neighbouring colours differ in brightness:
// X keeps colour at half resolution (4:2:0), so hue-only steps blur away, brightness steps survive.
DF.PRESETS = {
  TD8:   { mode: 'channel', stops: ['#000000', '#FF0000', '#00FF00', '#0000FF', '#00FFFF', '#FF00FF', '#FFFF00', '#FFFFFF'] },
  MONO:  { mode: 'ramp', stops: ['#000000', '#EFEDE6'] },
  HEAT:  { mode: 'ramp', stops: ['#000000', '#2B0F54', '#B3123B', '#F26B1D', '#FFE9A8'] },
  CYANO: { mode: 'ramp', stops: ['#0A1A3F', '#1D4E89', '#7FB2D9', '#EEF2EC'] },
  ACID:  { mode: 'ramp', stops: ['#000000', '#FF2E88', '#FFFFFF'] }
};

// Fonts for the TYPE source (all SIL OFL, see fonts/LICENSES.md). Loaded under private family names so a copy
// installed on this machine can never stand in for the bundled file.
DF.FONTS = [
  { name: 'Gloock', file: 'fonts/Gloock-Regular.ttf' },
  { name: 'Space Mono', file: 'fonts/SpaceMono-Bold.ttf' },
  { name: 'IBM Plex Mono', file: 'fonts/IBMPlexMono-SemiBold.ttf' },
  { name: 'DM Mono', file: 'fonts/DMMono-Medium.ttf' },
  { name: 'Fragment Mono', file: 'fonts/FragmentMono-Regular.ttf' },
  { name: 'Chivo Mono', file: 'fonts/ChivoMono-Bold.ttf' }
];
DF.fontFamily = function (i) { return 'dfFont' + i; };
// each font gets 4 s: a slow or failed file never holds up the first frame (type falls back until it arrives)
DF.loadFonts = function () {
  return Promise.all(DF.FONTS.map(function (f, i) {
    var face = new FontFace(DF.fontFamily(i), 'url(' + f.file + ')');
    var load = face.load().then(function (ff) { document.fonts.add(ff); f.ok = true; }, function (e) { f.ok = false; f.err = String(e); });
    return Promise.race([load, new Promise(function (r) { setTimeout(r, 4000); })]);
  }));
};
