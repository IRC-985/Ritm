// Небольшие помощники WebGL2

export function createGL(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', {
    antialias: false, depth: false, stencil: false, alpha: false,
    premultipliedAlpha: false, preserveDrawingBuffer: true, ...opts,
  });
  if (!gl) throw new Error('WebGL2 недоступен');
  const cbf = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
  if (!cbf) throw new Error('Видеокарта не поддерживает запись в float-текстуры');
  gl.getExtension('OES_texture_float_linear');
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return gl;
}

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export class GLKit {
  constructor(gl) {
    this.gl = gl;
    this.programs = new Map();
    this.pool = [];
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fbo = gl.createFramebuffer();
  }

  program(name, fs) {
    if (this.programs.has(name)) return this.programs.get(name);
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        const lines = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        throw new Error(`Шейдер ${name}: ${log}\n${lines}`);
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Линковка ${name}: ${gl.getProgramInfoLog(p)}`);
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
    const prog = { p, uniforms, name };
    this.programs.set(name, prog);
    return prog;
  }

  // Текстура float (RGBA16F) заданного размера
  texture(w, h, { data = null, type = 'half', filter = 'linear', internal } = {}) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (type === 'half') {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal || gl.RGBA16F, w, h, 0, gl.RGBA,
        data instanceof Uint16Array ? gl.HALF_FLOAT : gl.FLOAT, data);
    } else if (type === 'float') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    return { tex: t, w, h, type, target: gl.TEXTURE_2D };
  }

  texture3D(n, data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.FLOAT, data);
    return { tex: t, w: n, h: n, target: gl.TEXTURE_3D };
  }

  update3D(t, n, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, t.tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.FLOAT, data);
  }

  update2D(t, w, h, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA,
      data instanceof Uint16Array ? gl.HALF_FLOAT : gl.FLOAT, data);
    t.w = w; t.h = h;
  }

  // Временные рендер-цели: берём из пула по размеру
  acquire(w, h, kind = 'half') {
    const i = this.pool.findIndex((t) => t.w === w && t.h === h && t.kind === kind);
    if (i >= 0) return this.pool.splice(i, 1)[0];
    const t = this.texture(w, h, { type: kind === 'u8' ? 'u8' : 'half' });
    t.kind = kind;
    return t;
  }

  release(...ts) { for (const t of ts) if (t && t.kind) this.pool.push(t); }

  freeAll() {
    for (const t of this.pool) this.gl.deleteTexture(t.tex);
    this.pool = [];
  }

  delete(t) { if (t) this.gl.deleteTexture(t.tex); }

  // Нарисовать проход: prog, вход-текстуры {имя: tex}, uniform-ы, цель (null = экран)
  run(prog, target, textures = {}, uniforms = {}, viewport) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindVertexArray(this.vao);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const v = viewport || [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight];
      gl.viewport(...v);
    }
    let unit = 0;
    for (const [name, t] of Object.entries(textures)) {
      const u = prog.uniforms[name];
      if (!u) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(t.target || gl.TEXTURE_2D, t.tex);
      gl.uniform1i(u.loc, unit);
      unit++;
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const u = prog.uniforms[name];
      if (!u) continue;
      setUniform(gl, u, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  readPixels(target, x = 0, y = 0, w = target.w, h = target.h, float = false) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
    const out = float ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, out);
    return out;
  }
}

function setUniform(gl, u, v) {
  switch (u.type) {
    case gl.FLOAT: u.size > 1 ? gl.uniform1fv(u.loc, v) : gl.uniform1f(u.loc, v); break;
    case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
    case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, v); break;
    case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, true, v); break; // строки -> столбцы
    default: throw new Error('uniform type ' + u.type);
  }
}

// Таблица перевода float32 -> half (для загрузки исходника)
export function toHalf(f32) {
  const out = new Uint16Array(f32.length);
  const fv = new Float32Array(1), iv = new Uint32Array(fv.buffer);
  for (let i = 0; i < f32.length; i++) {
    fv[0] = f32[i];
    const x = iv[0];
    const sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 112;
    let m = x & 0x7fffff;
    if (e <= 0) { out[i] = sign; continue; }
    if (e >= 31) { out[i] = sign | 0x7bff; continue; }
    out[i] = sign | (e << 10) | ((m + 0x1000) >> 13);
  }
  return out;
}

// uint16 (0..65535) -> half, таблица на 65536 значений
let U16H = null;
export function u16ToHalfTable() {
  if (U16H) return U16H;
  const f = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) f[i] = i / 65535;
  U16H = toHalf(f);
  return U16H;
}
