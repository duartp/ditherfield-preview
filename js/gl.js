// ditherfield - WebGL2 helpers.
// Rules that keep "same seed = same picture" (measured across 4 renderers): highp everywhere, texelFetch / NEAREST
// only, no antialias, GL dithering off, a fixed internal grid.
(function () {
  var GL = DF.GL = {};

  GL.context = function (canvas, extra) {
    var opts = { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false,
                 preserveDrawingBuffer: true, powerPreference: 'high-performance' };
    for (var k in extra) opts[k] = extra[k];
    var gl = canvas.getContext('webgl2', opts);
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    gl.disable(gl.DITHER);
    return gl;
  };

  GL.HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp usampler2D;\nprecision highp isampler2D;\n';

  // One big triangle that covers the screen; the fragment shader does the work.
  GL.VS = GL.HEADER + 'void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }';

  GL.program = function (gl, fsBody, vs) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(s);
        var lines = src.split('\n').map(function (l, i) { return (i + 1) + ': ' + l; }).join('\n');
        throw new Error('Shader failed to compile:\n' + log + '\n' + lines);
      }
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs || GL.VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsBody.indexOf('#version') === 0 ? fsBody : GL.HEADER + fsBody));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program failed to link: ' + gl.getProgramInfoLog(p));
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, info.name);
    }
    return { gl: gl, prog: p, u: u, vao: gl.createVertexArray() };
  };

  GL.draw = function (P, fbo, w, h) {
    var gl = P.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo || null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(P.prog);
    gl.bindVertexArray(P.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // RGBA8 texture from a canvas / image, NEAREST, top row of the source = texel row 0.
  GL.textureFrom = function (gl, src, tex) {
    tex = tex || gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };

  GL.bindTex = function (P, name, unit, tex) {
    var gl = P.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(P.u[name], unit);
  };
})();
