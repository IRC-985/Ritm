// Конвейер на видеокарте: экспонирование -> рассеяние/ореол -> проявка (DIR + зерно) -> печать -> вывод
import * as SH from './shaders.js';
import { GLKit } from './gl.js';
import { LOGE } from './spectral.js';

export const FORMATS = {
  '35': { name: '35 мм (36×24)', mm: 36 },
  '645': { name: '6×4,5', mm: 56 },
  '66': { name: '6×6', mm: 56 },
  '67': { name: '6×7', mm: 70 },
  '45': { name: '4×5 дюйма', mm: 120 },
};

const HALATION_PRESET = {
  strong: [0.015, 0.005, 0.0],
  weak: [0.08, 0.02, 0.0],
  no: [0.3, 0.1, 0.015],
};

export class Pipeline {
  constructor(gl) {
    this.gl = gl;
    this.k = new GLKit(gl);
    const k = this.k;
    this.prog = {
      expose: k.program('expose', SH.EXPOSE),
      down: k.program('down', SH.DOWN),
      blur: k.program('blur', SH.BLUR),
      halation: k.program('halation', SH.HALATION),
      dev1: k.program('dev1', SH.DEVELOP1),
      dev2: k.program('dev2', SH.DEVELOP2),
      final: k.program('final', SH.FINAL),
      output: k.program('output', SH.OUTPUT),
      before: k.program('before', SH.BEFORE),
    };
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.t = {};
  }

  // Загрузить «химию» (результат buildProcess)
  setProcess(P) {
    const k = this.k;
    this.P = P;
    const N = P.tc.N;
    if (!this.t.tc) this.t.tc = k.texture(N, N, { data: P.tc.lut });
    else k.update2D(this.t.tc, N, N, P.tc.lut);
    const cur = new Float32Array(256 * 2 * 4);
    for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) {
      cur[4 * i + c] = P.curves.D[c][i];
      cur[4 * (256 + i) + c] = P.curves.D0[c][i];
    }
    if (!this.t.curves) this.t.curves = k.texture(256, 2, { data: cur });
    else k.update2D(this.t.curves, 256, 2, cur);
    if (!this.t.grain) this.t.grain = k.texture(256, 1, { data: P.grain.table });
    else k.update2D(this.t.grain, 256, 1, P.grain.table);
    const n = P.view.n;
    if (!this.t.view) this.t.view = k.texture3D(n, P.view.data);
    else k.update3D(this.t.view, n, P.view.data);
    if (P.enlarger) {
      if (!this.t.enl) this.t.enl = k.texture3D(n, P.enlarger.data);
      else k.update3D(this.t.enl, n, P.enlarger.data);
      const pc = new Float32Array(256 * 4);
      for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) pc[4 * i + c] = P.paperCurves[c][i];
      if (!this.t.paper) this.t.paper = k.texture(256, 1, { data: pc });
      else k.update2D(this.t.paper, 256, 1, pc);
    }
    if (!this.t.enl) this.t.enl = k.texture3D(2, new Float32Array(32));
    if (!this.t.paper) this.t.paper = k.texture(256, 1, { data: new Float32Array(1024) });
  }

  setStamp(canvas) {
    const gl = this.gl;
    if (!this.t.stamp) this.t.stamp = this.k.texture(canvas.width, canvas.height, { type: 'u8' });
    gl.bindTexture(gl.TEXTURE_2D, this.t.stamp.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  }

  // Исходник: half-float RGBA
  setSource(half, w, h, { mipmap = true } = {}) {
    const gl = this.gl;
    if (this.t.src && this.t.src.w === w && this.t.src.h === h) {
      gl.bindTexture(gl.TEXTURE_2D, this.t.src.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, half);
    } else {
      if (this.t.src) this.k.delete(this.t.src);
      this.t.src = this.k.texture(w, h, { data: half });
    }
    if (mipmap) {
      gl.bindTexture(gl.TEXTURE_2D, this.t.src.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.srcW = w; this.srcH = h;
  }

  // Гауссово размытие с пирамидой уменьшения. levels — кэш уровней для данного входа.
  _blur(levels, sigma) {
    const k = this.k;
    if (sigma < 0.25) return { tex: levels[0], own: false };
    let L = 0;
    while (sigma / (1 << L) > 4 && L < 6) L++;
    for (let i = levels.length; i <= L; i++) {
      const prev = levels[i - 1];
      const t = k.acquire(Math.max(1, Math.ceil(prev.w / 2)), Math.max(1, Math.ceil(prev.h / 2)));
      k.run(this.prog.down, t, { uTex: prev });
      levels.push(t);
    }
    const src = levels[L];
    const s = Math.sqrt(Math.max(sigma * sigma / (1 << (2 * L)) - (L ? 0.25 : 0), 0.04));
    const tmp = k.acquire(src.w, src.h), out = k.acquire(src.w, src.h);
    k.run(this.prog.blur, tmp, { uTex: src }, { uDir: [1 / src.w, 0], uSigma: s });
    k.run(this.prog.blur, out, { uTex: tmp }, { uDir: [0, 1 / src.h], uSigma: s });
    k.release(tmp);
    return { tex: out, own: true };
  }

  _releaseLevels(levels) { this.k.release(...levels.slice(1)); }

  /**
   * Обработка в линейный RGB вывода.
   * o: { w, h, geo:[x,y,W,H] (пиксели этого масштаба), pxUm, s (настройки), expMul, inMatrix }
   */
  process(o) {
    const k = this.k, P = this.P, s = o.s, pr = this.prog;
    const { w, h } = o;
    const geo = o.geo || [0, 0, w, h];
    const film = P.film;
    // 1. экспонирование
    const E0 = k.acquire(w, h);
    k.run(pr.expose, E0, { uSrc: this.t.src, uTc: this.t.tc, uStamp: this.t.stamp || this.t.tc }, {
      uIn: o.inMatrix, uTcN: P.tc.N, uExp: o.expMul,
      uVig: [s.vignette || 0, 0.75, 0.45, 0], uGeo: geo, uSize: [w, h], uBoost: s.boost || 0,
      uSrcRect: o.srcRect || [0, 0, 1, 1],
      uStampRect: o.stamp ? o.stamp.rect : [0, 0, 0, 0], uStampCol: o.stamp ? o.stamp.col : [0, 0, 0],
    });
    const G = o.globals; // крупные размытия, посчитанные по всему кадру (для тайлов)
    const grect = o.grect || [0, 0, 1, 1];
    const keep = o.keep ? {} : null;
    // 2. рассеяние и ореол
    let E2 = E0;
    const scatter = s.scatter ?? 1;
    const halAmt = s.halation ?? 1;
    if (scatter > 0 || halAmt > 0) {
      const lv = [E0];
      const px = o.pxUm;
      const hs = s.halationSize ?? 1;
      const sh = (film.use === 'cine' ? 50 : 65) * hs / px;
      const core = this._blur(lv, 1.93 / px);
      const t1 = this._blur(lv, 0.8 * 9.37 / px), t2 = this._blur(lv, 1.88 * 9.37 / px);
      const ext = (t) => ({ tex: t, own: false });
      const h1 = G ? ext(G.h1) : this._blur(lv, sh);
      const h2 = G ? ext(G.h2) : this._blur(lv, sh * Math.SQRT2);
      const h3 = G ? ext(G.h3) : this._blur(lv, sh * Math.sqrt(3));
      if (keep) { keep.h1 = h1.tex; keep.h2 = h2.tex; keep.h3 = h3.tex; h1.own = h2.own = h3.own = false; }
      const preset = HALATION_PRESET[film.antihalation] || HALATION_PRESET.strong;
      E2 = k.acquire(w, h);
      k.run(pr.halation, E2, {
        uE0: E0, uCore: core.tex, uTail1: t1.tex, uTail2: t2.tex, uH1: h1.tex, uH2: h2.tex, uH3: h3.tex,
      }, {
        uScatter: [scatter, scatter, scatter], uTailW: [0.78, 0.65, 0.67],
        uHal: preset.map((v) => v * halAmt), uHW: [1 / 1.75, 0.5 / 1.75, 0.25 / 1.75], uGRect: grect,
      });
      for (const b of [core, t1, t2, h1, h2, h3]) if (b.own) k.release(b.tex);
      if (keep) { // уровни пирамиды могут быть самими размытиями — не отдаём их в пул
        const kept = new Set([keep.h1, keep.h2, keep.h3]);
        k.release(...lv.slice(1).filter((t) => !kept.has(t)));
      } else this._releaseLevels(lv);
      if (!(keep && (keep.h1 === E0 || keep.h2 === E0 || keep.h3 === E0))) k.release(E0);
    }
    // 3. первичная проявка -> ингибиторы
    const curveU = { uCurveRows: 2, uLE: [LOGE.min, LOGE.max], uShift: P.curves.exposureShift };
    const corr = k.acquire(w, h);
    k.run(pr.dev1, corr, { uE: E2, uCurves: this.t.curves }, {
      ...curveU, uM: P.curves.M, uDmax: P.curves.dmax, uPositive: P.positive ? 1 : 0,
    });
    const lc = [corr];
    const cg = this._blur(lc, 20 / o.pxUm);
    const ct1 = G ? { tex: G.ct1, own: false } : this._blur(lc, 0.8 * 200 / o.pxUm);
    const ct2 = G ? { tex: G.ct2, own: false } : this._blur(lc, 1.88 * 200 / o.pxUm);
    if (keep) { keep.ct1 = ct1.tex; keep.ct2 = ct2.tex; ct1.own = ct2.own = false; }
    // 4. проявка с зерном
    const D = k.acquire(w, h);
    const grainAmt = (s.grain ?? 1) / o.pxUm; // 1/sqrt(площади пикселя)
    const cloud = 1.0 * (s.grainSize ?? 1) / o.pxUm;
    k.run(pr.dev2, D, {
      uE: E2, uCorrG: cg.tex, uCorrT1: ct1.tex, uCorrT2: ct2.tex, uGrain: this.t.grain, uCurves: this.t.curves,
    }, {
      ...curveU, uDmax: P.curves.dmax, uTailW: 0.06, uGrainAmt: grainAmt,
      uGrainSigma: Math.sqrt(0.65 * 0.65 + cloud * cloud), uMono: P.bw ? 1 : 0, uCorr: 1 - (s.grainColor ?? 0.6),
      uGeo: geo, uSize: [w, h], uSeed: o.seed ?? 17, uGRect: grect,
    });
    for (const b of [cg, ct1, ct2]) if (b.own) k.release(b.tex);
    if (keep) {
      const kept = new Set([keep.ct1, keep.ct2]);
      k.release(...lc.slice(1).filter((t) => !kept.has(t)));
      if (!kept.has(corr)) k.release(corr);
      if (![keep.h1, keep.h2, keep.h3].includes(E2)) k.release(E2);
    } else {
      this._releaseLevels(lc);
      k.release(corr, E2);
    }
    // 5. печать и просмотр
    const rgb = k.acquire(w, h);
    const neg = !P.positive;
    k.run(pr.final, rgb, { uD: D, uEnl: this.t.enl, uView: this.t.view, uPaper: this.t.paper }, {
      uFilmLo: P.filmLo, uFilmHi: P.filmHi,
      uViewLo: neg ? P.paperLo : P.filmLo, uViewHi: neg ? P.paperHi : P.filmHi,
      uNeg: neg ? 1 : 0, uPrintExp: neg ? P.printLogExp : 0, uLE: [LOGE.min, LOGE.max],
      uLutN: P.view.n, uFlare: P.illumXYZ.map((v) => v * P.flare), uWhite: P.whiteScale,
      uOut: P.outMatrix, uSat: s.saturation ?? 1,
    });
    k.release(D);
    // размытие для резкости скана
    const lr = [rgb];
    const bl = this._blur(lr, s.sharpRadius ?? 1.0);
    this._releaseLevels(lr);
    return { rgb, blur: bl.tex, ownBlur: bl.own, globals: keep };
  }

  // Вывести результат (на экран или в 8-битную текстуру)
  output(res, target, { sharp = 0.5, view = [0, 0, 1, 1], viewport, encode = true } = {}) {
    this.k.run(this.prog.output, target, { uRGB: res.rgb, uBlur: res.blur }, {
      uSharp: sharp, uEncode: encode ? 1 : 0, uView: view,
    }, viewport);
  }

  before(target, { M, expMul, view = [0, 0, 1, 1], viewport }) {
    this.k.run(this.prog.before, target, { uSrc: this.t.src }, { uM: M, uExp: expMul, uView: view }, viewport);
  }

  releaseResult(res) {
    this.k.release(res.rgb);
    if (res.ownBlur) this.k.release(res.blur);
  }

  releaseGlobals(g) {
    if (!g) return;
    const seen = new Set();
    for (const t of Object.values(g)) if (t && !seen.has(t)) { seen.add(t); this.k.release(t); }
  }
}
