// ditherfield - frame-exact MP4 export (H.264 + AAC), rendered frame by frame, not recorded live.
// Why not MediaRecorder: in Chrome 152 its MP4 is fragmented with empty sample tables and frame timing that follows
// the screen's refresh (measured), plain 'video/mp4' silently gives VP9 + Opus, and X reportedly rejects such files.
// Here every frame i is drawn at t = i / fps, handed to the hardware encoder with an exact timestamp, and written as
// a progressive MP4 (ftyp, moov, mdat - index at the front) by mp4-muxer 5.2.2 (vendor/, MIT).
(function () {
  // H.264 High profile; the level follows the macroblock rate (Annex A) so strict decoders don't complain.
  function avcCodec(w, h, fps) {
    var mbs = Math.ceil(w / 16) * Math.ceil(h / 16), rate = mbs * fps;
    var levels = [[0x28, 8192, 245760], [0x2A, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
    for (var i = 0; i < levels.length; i++) {
      if (mbs <= levels[i][1] && rate <= levels[i][2]) return 'avc1.6400' + levels[i][0].toString(16).toUpperCase().padStart(2, '0');
    }
    return 'avc1.640034';
  }
  DF.avcCodec = avcCodec;

  async function supportedConfig(cfg) {
    var tries = ['prefer-hardware', 'no-preference'];
    for (var i = 0; i < tries.length; i++) {
      cfg.hardwareAcceleration = tries[i];
      var r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return r.config;
    }
    throw new Error('This browser cannot encode ' + cfg.codec + ' at ' + cfg.width + 'x' + cfg.height + '.');
  }

  async function encodeAudio(buf, muxer, bitrate) {
    var failure = null;
    var enc = new AudioEncoder({
      output: function (chunk, meta) { muxer.addAudioChunk(chunk, meta); },
      error: function (e) { failure = e; }
    });
    var cfg = { codec: 'mp4a.40.2', sampleRate: buf.sampleRate, numberOfChannels: buf.numberOfChannels, bitrate: bitrate || 192000 };
    var sup = await AudioEncoder.isConfigSupported(cfg);
    if (!sup.supported) throw new Error('This browser cannot encode AAC audio.');
    enc.configure(cfg);
    var step = 4800, chs = buf.numberOfChannels;
    for (var off = 0; off < buf.length; off += step) {
      var n = Math.min(step, buf.length - off), data = new Float32Array(n * chs);
      for (var c = 0; c < chs; c++) data.set(buf.getChannelData(c).subarray(off, off + n), c * n);
      var ad = new AudioData({ format: 'f32-planar', sampleRate: buf.sampleRate, numberOfFrames: n,
                               numberOfChannels: chs, timestamp: Math.round(off * 1e6 / buf.sampleRate), data: data });
      enc.encode(ad);
      ad.close();
      if (failure) throw failure;
    }
    await enc.flush();
    enc.close();
    if (failure) throw failure;
  }

  // o = { canvas, width, height, fps, frames, draw(i), audio: 48 kHz stereo AudioBuffer or async () => AudioBuffer,
  //       videoBitrate, onProgress(0..1) }
  // draw(i) must draw frame i onto canvas synchronously. Returns { blob, info }.
  DF.exportMP4 = async function (o) {
    if (!('VideoEncoder' in window)) throw new Error('No WebCodecs video encoder here. Use desktop Chrome.');
    var t0 = performance.now();
    var cfg = await supportedConfig({
      codec: avcCodec(o.width, o.height, o.fps), width: o.width, height: o.height, framerate: o.fps,
      bitrate: o.videoBitrate || 24e6, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' }
    });
    var target = new Mp4Muxer.ArrayBufferTarget();
    var muxer = new Mp4Muxer.Muxer({
      target: target,
      video: { codec: 'avc', width: o.width, height: o.height, frameRate: o.fps },
      audio: o.audio ? { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset'
    });
    var failure = null, chunks = 0, keys = 0;
    var venc = new VideoEncoder({
      output: function (chunk, meta) { chunks++; if (chunk.type === 'key') keys++; muxer.addVideoChunk(chunk, meta); },
      error: function (e) { failure = e; }
    });
    venc.configure(cfg);
    var us = 1e6 / o.fps, gop = o.fps * 2;
    function dequeued() { return new Promise(function (r) { venc.addEventListener('dequeue', r, { once: true }); }); }
    for (var i = 0; i < o.frames; i++) {
      if (failure) throw failure;
      o.draw(i);
      var vf = new VideoFrame(o.canvas, { timestamp: Math.round(i * us), duration: Math.round(us) });
      venc.encode(vf, { keyFrame: i % gop === 0 });
      vf.close();
      while (venc.encodeQueueSize > 6) await dequeued();
      if (o.onProgress && i % 15 === 0) o.onProgress(i / o.frames);
    }
    await venc.flush();
    venc.close();
    if (failure) throw failure;
    if (o.audio) {
      // audio may be a function: it is rendered after the frames, so it can use what the frames produced (pixel rows)
      var buf = typeof o.audio === 'function' ? await o.audio() : o.audio;
      await encodeAudio(buf, muxer, o.audioBitrate);
    }
    muxer.finalize();
    var blob = new Blob([target.buffer], { type: 'video/mp4' });
    var info = { codec: cfg.codec, hw: cfg.hardwareAcceleration, frames: o.frames, chunks: chunks, keyframes: keys,
                 fps: o.fps, width: o.width, height: o.height, bytes: blob.size,
                 mbps: +(blob.size * 8 / (o.frames / o.fps) / 1e6).toFixed(2), ms: Math.round(performance.now() - t0) };
    if (o.onProgress) o.onProgress(1);
    return { blob: blob, info: info };
  };
})();
