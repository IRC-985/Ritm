// Спектральная модель плёнки (порт идей spektrafilm на JS).
// Здесь всё, что считается на CPU: таблицы для шейдеров и калибровка печати.
// Пиксельные операции повторены в cpuPixel() — эталон для проверки шейдеров.

export const NW = 81; // 380..780 нм, шаг 5

// ------------------------------------------------------------ загрузка
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

export async function loadData(base, fetchFn = fetch) {
  const [common, stocksFile, lutBuf] = await Promise.all([
    fetchFn(base + 'common.json').then((r) => r.json()),
    fetchFn(base + 'stocks.json').then((r) => r.json()),
    fetchFn(base + 'spectra_lut.bin').then((r) => r.arrayBuffer()),
  ]);
  const h = new Uint16Array(lutBuf);
  const table = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) table[i] = halfToFloat(i);
  const spectra = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) spectra[i] = table[h[i]];
  const stocks = {};
  for (const s of stocksFile.stocks) stocks[s.id] = s;
  return { common, spectra, N: common.lutN, stocks, license: stocksFile.license };
}

// ------------------------------------------------------------ матрицы 3x3
export const mat = {
  mul(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        r[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
    return r;
  },
  vec(a, v) {
    return [
      a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
      a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
      a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
    ];
  },
  inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
      A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
    ];
  },
  diag(v) { return [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]; },
};

export const PROPHOTO_TO_XYZ = [0.7976749, 0.1351917, 0.0313534, 0.2880402, 0.7118741, 0.0000857, 0, 0, 0.82521];
export const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
export const XYZ_TO_P3 = [2.4934969, -0.9313836, -0.4027108, -0.8294890, 1.7626641, 0.0236247, 0.0358458, -0.0761724, 0.9568845];
export const XYZ_TO_PROPHOTO = mat.inv(PROPHOTO_TO_XYZ);
const CAT16 = [0.401288, 0.650173, -0.051461, -0.250268, 1.204414, 0.045854, -0.002079, 0.048952, 0.953127];
const CAT16_INV = mat.inv(CAT16);
export const WHITE_D50 = [0.96422, 1.0, 0.82521];
export const WHITE_D65 = [0.95047, 1.0, 1.08883];

// Адаптация фон Криса в пространстве CAT16 (полная адаптация)
export function adaptation(srcWhite, dstWhite) {
  const s = mat.vec(CAT16, srcWhite), d = mat.vec(CAT16, dstWhite);
  return mat.mul(CAT16_INV, mat.mul(mat.diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), CAT16));
}

// ------------------------------------------------------------ спектры
export class Spectra {
  constructor(data) {
    this.d = data;
    this.wl = data.common.wl;
    this.cmf = data.common.cmf; // [81][3]
    this._ill = {};
  }

  planck(T) {
    const out = new Float64Array(NW);
    for (let i = 0; i < NW; i++) {
      const l = this.wl[i] * 1e-9;
      out[i] = 1 / (Math.pow(l, 5) * (Math.exp(0.0143877687 / (l * T)) - 1));
    }
    return normalize(out);
  }

  illuminant(name) {
    if (this._ill[name]) return this._ill[name];
    let v;
    if (name.startsWith('BB')) v = this.planck(+name.slice(2));
    else if (name === 'TH-KG3') {
      const bb = this.planck(3400), kg = this.d.common.KG3;
      v = normalize(bb.map((x, i) => x * kg[i]));
    } else if (name === 'T') v = Float64Array.from(this.d.common.illuminants.A);
    else if (name === 'K75P') v = Float64Array.from(this.d.common.K75P);
    else v = Float64Array.from(this.d.common.illuminants[name]);
    this._ill[name] = v;
    return v;
  }

  xyz(spec) {
    let X = 0, Y = 0, Z = 0;
    for (let i = 0; i < NW; i++) {
      X += spec[i] * this.cmf[i][0]; Y += spec[i] * this.cmf[i][1]; Z += spec[i] * this.cmf[i][2];
    }
    return [X, Y, Z];
  }

  whiteXYZ(name) { // нормирован Y=1
    const v = this.xyz(this.illuminant(name));
    return [v[0] / v[1], 1, v[2] / v[1]];
  }
}

function normalize(v) {
  let s = 0;
  for (const x of v) s += x;
  s /= v.length;
  return v.map((x) => x / s);
}

// ------------------------------------------------------------ фильтры на объектив
// Приближённые кривые пропускания (по графикам Kodak Wratten).
function erfApprox(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const edge = (wl, c, w) => 0.5 * (1 + erfApprox((wl - c) / w));

export const LENS_FILTERS = {
  none: { name: 'Без фильтра', f: () => 1 },
  skylight: { name: 'Skylight 1A', f: (l) => (0.92 + 0.08 * edge(l, 560, 60)) * edge(l, 395, 8) },
  w81a: { name: '81A (тёплый)', f: (l) => 0.78 + 0.22 * edge(l, 500, 40) },
  w81ef: { name: '81EF (сильно тёплый)', f: (l) => 0.62 + 0.38 * edge(l, 510, 45) },
  w82a: { name: '82A (холодный)', f: (l) => 1 - 0.2 * edge(l, 560, 60) },
  w80a: { name: '80A (дневной на лампе)', f: (l) => Math.min(1, 0.95 - 0.7 * edge(l, 540, 40) + 0.25 * edge(l, 690, 20)) },
  w85b: { name: '85B (лампа на дневном)', f: (l) => 0.08 + 0.92 * edge(l, 545, 22) },
  yellow8: { name: 'Жёлтый №8 (K2)', f: (l) => 0.02 + 0.98 * edge(l, 478, 14) },
  orange21: { name: 'Оранжевый №21', f: (l) => 0.01 + 0.99 * edge(l, 548, 13) },
  red25: { name: 'Красный №25', f: (l) => 0.005 + 0.995 * edge(l, 594, 12) },
  green11: { name: 'Жёлто-зелёный №11', f: (l) => 0.05 + 0.75 * Math.exp(-0.5 * ((l - 540) / 45) ** 2) + 0.2 * edge(l, 650, 25) },
  blue47: { name: 'Синий №47', f: (l) => 0.01 + 0.85 * Math.exp(-0.5 * ((l - 440) / 30) ** 2) + 0.4 * edge(l, 700, 15) },
};

// ------------------------------------------------------------ плёнка
const LE0 = -3, LE1 = 4, NLE = 256;
export const LOGE = { min: LE0, max: LE1, n: NLE };

function erfWindow(wl, p) {
  const [cuv, suv, cir, sir] = p;
  const a = 0.5 * (1 + erfApprox((wl - cuv) / (suv * Math.SQRT2)));
  const b = 0.5 * (1 - erfApprox((wl - cir) / (sir * Math.SQRT2)));
  return a * b;
}

function interp1(x, xp, fp) { // xp возрастающий
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
  const t = (x - xp[lo]) / (xp[hi] - xp[lo] || 1);
  return fp[lo] + t * (fp[hi] - fp[lo]);
}

function gridLE() {
  const le = new Float64Array(NLE);
  for (let k = 0; k < NLE; k++) le[k] = LE0 + (LE1 - LE0) * k / (NLE - 1);
  return le;
}
const LEG = gridLE();

// ─── характеристические кривые без поправки на DIR-компоненты; канал c
function curveColumn(stock, c) {
  const col = new Float64Array(NLE);
  let mn = Infinity;
  for (let k = 0; k < NLE; k++) { const v = stock.curves[k][c]; col[k] = v ?? 0; if (v != null && v < mn) mn = v; }
  for (let k = 0; k < NLE; k++) col[k] -= mn;
  return col;
}

// Положение «на плёнке»: какой стороной кривая растёт
export const isPositive = (s) => s.type === 'positive';

export function couplerMatrix(stock, amount) {
  let same, rgb, gbr;
  if (stock.bw) {
    return [0.12 * amount, 0, 0, 0, 0.12 * amount, 0, 0, 0, 0.12 * amount];
  }
  if (isPositive(stock)) {
    same = [0.12, 0.08, 0.06]; rgb = [[0.12, 0.06], [0.08, 0.06], [0.06, 0.06]];
  } else {
    same = [0.336, 0.319, 0.273]; rgb = [[0.353, 0.302], [0.154, 0.353], [0.168, 0.226]];
  }
  const base = stock.id === 'fujifilm_velvia_50' ? 'fujifilm_velvia_100' : stock.id === 'agfa_ct_precisa_100' ? 'fujifilm_provia_100f' : stock.id;
  if (base === 'fujifilm_velvia_100') { same = [0.108, 0.072, 0.054]; rgb = [[0.108, 0.054], [0.072, 0.054], [0.054, 0.054]]; }
  if (base === 'fujifilm_provia_100f') { same = [0.156, 0.104, 0.078]; rgb = [[0.156, 0.078], [0.104, 0.078], [0.078, 0.078]]; }
  const k = (stock.couplers ?? 1) * amount;
  // строка — источник ингибитора, столбец — слой-получатель
  const M = [same[0], rgb[0][0], rgb[0][1], rgb[1][0], same[1], rgb[1][1], rgb[2][0], rgb[2][1], same[2]];
  return M.map((v) => v * k);
}

// Кривые для шейдера: D(logE) и D0(logE) — до DIR-компонент. Учитывает пуш/пулл.
export function filmCurves(stock, { push = 0, couplers = 1 } = {}) {
  const pos = isPositive(stock);
  const gamma = 1 + (pos ? 0.08 : 0.1) * push;
  const shift = 0.301 * 0.8 * push; // проявка частично возвращает недодержку
  const D = [0, 1, 2].map((c) => {
    const col = curveColumn(stock, c);
    const out = new Float64Array(NLE);
    for (let k = 0; k < NLE; k++) out[k] = interp1(gamma * (LEG[k] + shift), LEG, col);
    return out;
  });
  const dmax = D.map((col) => Math.max(...col));
  const M = couplerMatrix(stock, couplers);
  const D0 = [0, 1, 2].map(() => new Float64Array(NLE));
  for (let m = 0; m < 3; m++) {
    const le0 = new Float64Array(NLE);
    for (let k = 0; k < NLE; k++) {
      let a = 0;
      for (let j = 0; j < 3; j++) {
        const silver = pos ? dmax[j] - D[j][k] : D[j][k];
        a += silver * M[3 * j + m];
      }
      le0[k] = LEG[k] - a;
    }
    // гарантируем монотонность
    for (let k = 1; k < NLE; k++) if (le0[k] <= le0[k - 1]) le0[k] = le0[k - 1] + 1e-6;
    for (let k = 0; k < NLE; k++) D0[m][k] = interp1(LEG[k], le0, D[m]);
  }
  return { D, D0, dmax, M, positive: pos, exposureShift: -push * 0.301 };
}

// Дисперсия зерна как функция плотности (на 1 мкм² площади пикселя)
// grainVar(d)/A_px = дисперсия плотности в пикселе площадью A_px мкм².
export function grainTable(stock, curves, { size = 1 } = {}) {
  const NG = 256;
  const area0 = 0.2 * (stock.grain ?? 1) * size;
  const scaleC = stock.bw ? [2.4, 2.4, 2.4] : [1.6, 1.6, 3.2];
  const scaleL = [2.0, 1.0, 0.5];
  const uniformity = [0.97, 0.99, 0.97];
  const dmin = 0.03;
  const out = new Float32Array(NG * 4);
  const dmaxAll = [];
  for (let c = 0; c < 3; c++) {
    // слои: D(logE) для каждого подслоя
    const L = [0, 1, 2].map((l) => {
      const col = new Float64Array(NLE);
      for (let k = 0; k < NLE; k++) col[k] = stock.layers[k][l][c] ?? 0;
      return col;
    });
    const tot = curveColumn(stock, c);
    const dmaxL = L.map((col) => Math.max(...col));
    const sumMax = dmaxL.reduce((a, b) => a + b, 0);
    const frac = dmaxL.map((v) => v / sumMax);
    const dmax = curves.dmax[c];
    dmaxAll.push(dmax);
    // отсортированные пары (D_total, logE) для обратной интерполяции
    const pos = isPositive(stock);
    const xs = [], idx = [];
    for (let k = 0; k < NLE; k++) { xs.push(pos ? -tot[k] : tot[k]); idx.push(k); }
    for (let i = 0; i < NG; i++) {
      const d = (i / (NG - 1)) * dmax;
      let g = 0;
      for (let l = 0; l < 3; l++) {
        const dl = interp1(pos ? -d : d, xs, L[l]);
        const dminL = frac[l] * dmin;
        const dmaxl = dmaxL[l] + dminL;
        const pa = area0 * scaleC[c] * scaleL[l];
        const p = Math.min(1, (dl + dminL) / dmaxl);
        // var = d*od*(1-u p), od = dmax/N, N = A*frac/pa
        g += (dl + dminL) * dmaxl * (pa / Math.max(frac[l], 1e-6)) * (1 - uniformity[c] * p);
      }
      out[4 * i + c] = Math.sqrt(Math.max(g, 0));
    }
  }
  return { table: out, n: NG, dmax: dmaxAll };
}

// ------------------------------------------------------------ спектральный апсемплинг
function tri2quad(x, y) {
  const qy = y / Math.max(1 - x, 1e-10);
  const qx = (1 - x) * (1 - x);
  return [Math.min(Math.max(qx, 0), 1), Math.min(Math.max(qy, 0), 1)];
}

// Таблица «цветность -> экспозиция слоёв»: N x N x RGBA (float32)
// Индекс: [i (qx), j (qy)] -> (i*N + j)
export function filmTcLut(sp, stock, { lensFilter = 'none', sceneIllum } = {}) {
  const N = sp.d.N, spec = sp.d.spectra;
  const sens = [];
  const refName = stock.refIllum === 'T' ? 'A' : stock.refIllum;
  const ref = sp.illuminant(refName);
  for (let l = 0; l < NW; l++) sens.push([0, 1, 2].map((c) => Math.pow(10, stock.logSens[l][c])));
  // окно адаптации hanatos2025 (сохраняет баланс белого)
  if (stock.window && stock.window.length === 4) {
    const win = sp.wl.map((w) => erfWindow(w, stock.window));
    for (let c = 0; c < 3; c++) {
      let a = 0, b = 0;
      for (let l = 0; l < NW; l++) { a += sens[l][c] * ref[l] * win[l]; b += sens[l][c] * ref[l]; }
      const nrm = a / b;
      for (let l = 0; l < NW; l++) sens[l][c] *= win[l] / nrm;
    }
  }
  const lut = new Float32Array(N * N * 4);
  const fill = (S) => {
    for (let p = 0; p < N * N; p++) {
      const o = p * NW;
      let r = 0, g = 0, b = 0;
      for (let l = 0; l < NW; l++) {
        const s = spec[o + l];
        r += s * S[l][0]; g += s * S[l][1]; b += s * S[l][2];
      }
      lut[4 * p] = r; lut[4 * p + 1] = g; lut[4 * p + 2] = b; lut[4 * p + 3] = 1;
    }
  };
  fill(sens);
  // нормировка на средне-серый (18.4%) при освещении, на которое сбалансирована плёнка
  const inM = inputMatrix(sp, refName);
  const mid = tcSample(lut, N, mat.vec(inM, [0.184, 0.184, 0.184]));
  const k = mid.map((v) => 1 / v);
  // фильтр: общий множитель экспозиции (как поправка на кратность фильтра)
  const f = LENS_FILTERS[lensFilter] || LENS_FILTERS.none;
  if (lensFilter !== 'none') {
    const fv = sp.wl.map((w) => f.f(w));
    let a = 0, b = 0;
    for (let l = 0; l < NW; l++) { a += sens[l][1] * ref[l] * fv[l]; b += sens[l][1] * ref[l]; }
    const fn = a / b;
    for (let l = 0; l < NW; l++) for (let c = 0; c < 3; c++) sens[l][c] *= fv[l] / fn;
    fill(sens);
  }
  for (let p = 0; p < N * N; p++) for (let c = 0; c < 3; c++) lut[4 * p + c] *= k[c];
  return { lut, N, norm: mid, inMatrix: inputMatrix(sp, sceneIllum || refName) };
}

// ProPhoto (D50) -> XYZ при освещении сцены
export function inputMatrix(sp, illumName) {
  const w = sp.whiteXYZ(illumName === 'T' ? 'A' : illumName);
  return mat.mul(adaptation(WHITE_D50, w), PROPHOTO_TO_XYZ);
}

function tcSample(lut, N, xyz) {
  const b = xyz[0] + xyz[1] + xyz[2];
  if (!(b > 0)) return [0, 0, 0];
  const [qx, qy] = tri2quad(xyz[0] / b, xyz[1] / b);
  const fx = qx * (N - 1), fy = qy * (N - 1);
  const i0 = Math.min(Math.floor(fx), N - 2), j0 = Math.min(Math.floor(fy), N - 2);
  const tx = fx - i0, ty = fy - j0;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v00 = lut[4 * (i0 * N + j0) + c], v01 = lut[4 * (i0 * N + j0 + 1) + c];
    const v10 = lut[4 * ((i0 + 1) * N + j0) + c], v11 = lut[4 * ((i0 + 1) * N + j0 + 1) + c];
    out[c] = ((v00 * (1 - ty) + v01 * ty) * (1 - tx) + (v10 * (1 - ty) + v11 * ty) * tx) * b;
  }
  return out;
}

// Отклик слоёв плёнки на свет заданного XYZ (в пространстве опорного освещения плёнки)
export function filmResponse(P, xyz) { return tcSample(P.tc.lut, P.tc.N, xyz); }

// ------------------------------------------------------------ печать и просмотр
// Дихроичные фильтры увеличителя (модель spektrafilm «custom»)
function dichroics(wl) {
  const e = [516, 500, 610, 607], t = [12, 8, 8, 8];
  const y = 0.5 * erfApprox((wl - e[0]) / t[0]) + 0.5;
  const m = wl <= 550 ? -0.5 * erfApprox((wl - e[1]) / t[1]) + 0.5 : 0.5 * erfApprox((wl - e[2]) / t[2]) + 0.5;
  const c = -0.5 * erfApprox((wl - e[3]) / t[3]) + 0.5;
  return [c, m, y];
}

export function enlargerLight(sp, cc /* [c,m,y] в единицах CC */, lamp = 'TH-KG3') {
  const L = sp.illuminant(lamp);
  const tv = cc.map((v) => Math.pow(10, -v / 100));
  return L.map((v, i) => {
    const f = dichroics(sp.wl[i]);
    let tot = 1;
    for (let k = 0; k < 3; k++) tot *= 1 - (1 - f[k]) * (1 - tv[k]);
    return v * tot;
  });
}

// спектральная плотность носителя для плотностей слоёв cmy
function spectralTransmit(stock, cmy, out) {
  const cd = stock.channelDensity, bd = stock.baseDensity;
  for (let l = 0; l < NW; l++) {
    const D = cmy[0] * cd[l][0] + cmy[1] * cd[l][1] + cmy[2] * cd[l][2] + bd[l];
    out[l] = Math.pow(10, -D);
  }
  return out;
}

// Плотности плёнки -> log10 экспозиции слоёв бумаги (без нормировки)
export function makeEnlarger(sp, film, paper, light) {
  const S = [];
  for (let l = 0; l < NW; l++) S.push([0, 1, 2].map((c) => Math.pow(10, paper.logSens[l][c])));
  const T = new Float64Array(NW);
  return (cmy) => {
    spectralTransmit(film, cmy, T);
    let r = 0, g = 0, b = 0;
    for (let l = 0; l < NW; l++) {
      const v = T[l] * light[l];
      r += v * S[l][0]; g += v * S[l][1]; b += v * S[l][2];
    }
    return [r, g, b];
  };
}

// Плотности носителя -> XYZ при просмотре (Y белого источника = 1)
export function makeViewer(sp, medium, illumName) {
  const L = sp.illuminant(illumName);
  let ny = 0;
  for (let l = 0; l < NW; l++) ny += L[l] * sp.cmf[l][1];
  const T = new Float64Array(NW);
  return (cmy) => {
    spectralTransmit(medium, cmy, T);
    let X = 0, Y = 0, Z = 0;
    for (let l = 0; l < NW; l++) {
      const v = T[l] * L[l];
      X += v * sp.cmf[l][0]; Y += v * sp.cmf[l][1]; Z += v * sp.cmf[l][2];
    }
    return [X / ny, Y / ny, Z / ny];
  };
}

function normCdf(z) { return 0.5 * (1 + erfApprox(z / Math.SQRT2)); }

// Кривые бумаги по параметрической модели (контраст = гамма-коэффициент)
export function paperCurves(paper, contrast = 1) {
  const D = [0, 1, 2].map(() => new Float64Array(NLE));
  if (paper.model) {
    const { centers, amplitudes, sigmas } = paper.model;
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < NLE; k++) {
        let s = 0;
        for (let i = 0; i < centers[c].length; i++)
          s += amplitudes[c][i] * normCdf((LEG[k] - centers[c][i] / contrast) / (sigmas[c][i] / contrast));
        D[c][k] = s;
      }
  } else {
    for (let c = 0; c < 3; c++) {
      const col = curveColumn(paper, c);
      for (let k = 0; k < NLE; k++) D[c][k] = interp1(LEG[k] * contrast, LEG, col);
    }
  }
  return D;
}

export function curveAt(D, x) {
  const f = (x - LE0) / (LE1 - LE0) * (NLE - 1);
  if (f <= 0) return D[0];
  if (f >= NLE - 1) return D[NLE - 1];
  const i = Math.floor(f), t = f - i;
  return D[i] * (1 - t) + D[i + 1] * t;
}

// ------------------------------------------------------------ 3D-таблицы
export const LUT3 = 33;

// Таблица: плотности (сетка от lo до hi по каждому каналу) -> log10(f(cmy))
export function bake3D(fn, lo, hi, n = LUT3) {
  const out = new Float32Array(n * n * n * 4);
  const cmy = [0, 0, 0];
  let p = 0;
  for (let z = 0; z < n; z++) {
    cmy[2] = lo[2] + (hi[2] - lo[2]) * z / (n - 1);
    for (let y = 0; y < n; y++) {
      cmy[1] = lo[1] + (hi[1] - lo[1]) * y / (n - 1);
      for (let x = 0; x < n; x++) {
        cmy[0] = lo[0] + (hi[0] - lo[0]) * x / (n - 1);
        const v = fn(cmy);
        out[p++] = Math.log10(Math.max(v[0], 1e-10));
        out[p++] = Math.log10(Math.max(v[1], 1e-10));
        out[p++] = Math.log10(Math.max(v[2], 1e-10));
        out[p++] = 1;
      }
    }
  }
  return { data: out, n, lo, hi };
}

// Быстрая 3D-таблица для спектральных сумм: out_k = sum_l 10^-(D_spec(l)) * W[l][k]
export function bakeSpectral(stock, W, lo, hi, n = LUT3) {
  const cd = stock.channelDensity, bd = stock.baseDensity;
  const out = new Float32Array(n * n * n * 4);
  const axis = (ch) => {
    const a = new Float64Array(n * NW);
    for (let i = 0; i < n; i++) {
      const d = lo[ch] + (hi[ch] - lo[ch]) * i / (n - 1);
      for (let l = 0; l < NW; l++) a[i * NW + l] = Math.pow(10, -d * cd[l][ch]);
    }
    return a;
  };
  const A0 = axis(0), A1 = axis(1), A2 = axis(2);
  const base = new Float64Array(NW);
  for (let l = 0; l < NW; l++) base[l] = Math.pow(10, -bd[l]);
  const Wf = new Float64Array(NW * 3);
  for (let l = 0; l < NW; l++) for (let k = 0; k < 3; k++) Wf[l * 3 + k] = W[l][k];
  const T = new Float64Array(NW);
  let p = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) {
    for (let l = 0; l < NW; l++) T[l] = A2[z * NW + l] * A1[y * NW + l] * base[l];
    for (let x = 0; x < n; x++) {
      let o0 = 0, o1 = 0, o2 = 0;
      const ax = x * NW;
      for (let l = 0; l < NW; l++) {
        const v = T[l] * A0[ax + l];
        o0 += v * Wf[3 * l]; o1 += v * Wf[3 * l + 1]; o2 += v * Wf[3 * l + 2];
      }
      out[p++] = Math.log10(Math.max(o0, 1e-10));
      out[p++] = Math.log10(Math.max(o1, 1e-10));
      out[p++] = Math.log10(Math.max(o2, 1e-10));
      out[p++] = 1;
    }
  }
  return { data: out, n, lo, hi };
}

export function enlargerWeights(paper, light) {
  const W = [];
  for (let l = 0; l < NW; l++) W.push([0, 1, 2].map((c) => light[l] * Math.pow(10, paper.logSens[l][c])));
  return W;
}

export function viewWeights(sp, illumName) {
  const L = sp.illuminant(illumName);
  let ny = 0;
  for (let l = 0; l < NW; l++) ny += L[l] * sp.cmf[l][1];
  const W = [];
  for (let l = 0; l < NW; l++) W.push([0, 1, 2].map((k) => L[l] * sp.cmf[l][k] / ny));
  return W;
}

// ------------------------------------------------------------ сборка всей «химии»
// Возвращает всё, что нужно шейдерам, + функцию cpuPixel для проверки.
export function buildProcess(sp, s) {
  const film = sp.d.stocks[s.film];
  const pos = isPositive(film);
  const curves = filmCurves(film, { push: s.push, couplers: s.couplers });
  const tc = filmTcLut(sp, film, { lensFilter: s.lensFilter, sceneIllum: s.sceneIllum });
  const grain = grainTable(film, curves, { size: s.grainSize });
  const filmLo = [-0.15, -0.15, -0.15];
  const filmHi = curves.dmax.map((v) => v + 0.15);
  const res = { film, positive: pos, curves, tc, grain, filmLo, filmHi, bw: !!film.bw };

  const outM = s.outSpace === 'p3' ? XYZ_TO_P3 : XYZ_TO_SRGB;
  if (pos) {
    // слайд: просмотр на просвет или проектором
    const illum = s.slideView === 'projector' ? 'BB3300' : film.viewIllum;
    const view = makeViewer(sp, film, illum);
    res.view = bakeSpectral(film, viewWeights(sp, illum), filmLo, filmHi);
    const white = view([0, 0, 0]);
    res.whiteScale = s.normWhite ? 0.97 / white[1] : 1;
    res.flare = (s.slideView === 'projector' ? 0.006 : 0.0015) * (s.flare ?? 1);
    res.outMatrix = mat.mul(outM, adaptation(sp.whiteXYZ(illum), WHITE_D65));
    res.illumXYZ = sp.whiteXYZ(illum);
    res.viewFn = view;
  } else {
    const paper = sp.d.stocks[s.paper];
    const light0 = enlargerLight(sp, [0, 0, 0]);
    const viewIllum = paper.viewIllum || 'D50';
    const view = makeViewer(sp, paper, viewIllum);
    const pc = paperCurves(paper, s.paperContrast);
    // плотность негатива для серого 18.4% (с учётом экспозиции и пуша)
    const midLog = Math.log10(Math.pow(2, s.exposure || 0)) + curves.exposureShift;
    const midD = [0, 1, 2].map((c) => curveAt(curves.D[c], midLog));
    const white = view([0, 0, 0]);
    const target = [0.184 * white[1] * sp.whiteXYZ(viewIllum)[0], 0.184 * white[1], 0.184 * white[1] * sp.whiteXYZ(viewIllum)[2]];
    const evalPrint = (logExp, m, y) => {
      const enl = makeEnlarger(sp, film, paper, enlargerLight(sp, [0, m, y]));
      const raw = enl(midD);
      const dens = raw.map((v, c) => curveAt(pc[c], Math.log10(v) + logExp));
      return view(dens);
    };
    // калибровка: экспозиция печати и фильтрация M/Y так, чтобы серый был нейтральным 18%
    const resid = (x) => evalPrint(...x).map((v, i) => Math.log10(Math.max(v, 1e-12) / target[i]));
    let x = film.bw ? [0, 0, 0] : [0, 60, 50];
    {
      const raw = makeEnlarger(sp, film, paper, enlargerLight(sp, [0, x[1], x[2]]))(midD);
      x[0] = -Math.log10(raw[1]);
    }
    const free = film.bw ? [0] : [0, 1, 2];
    const hs = [0.005, 0.5, 0.5];
    let r = resid(x), err = Math.hypot(...r), lambda = 1e-3;
    for (let it = 0; it < 60 && err > 1e-5; it++) {
      const J = free.map((k) => {
        const xx = x.slice(); xx[k] += hs[k];
        return resid(xx).map((v, i) => (v - r[i]) / hs[k]);
      });
      const n = free.length;
      // (J J^T + λ diag) dx = -J r
      const A = [], g = [];
      for (let a = 0; a < n; a++) {
        g.push(-J[a].reduce((s, v, i) => s + v * r[i], 0));
        for (let b = 0; b < n; b++) A.push(J[a].reduce((s, v, i) => s + v * J[b][i], 0));
      }
      let improved = false;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const AA = A.slice();
        for (let a = 0; a < n; a++) AA[a * n + a] *= 1 + lambda;
        const dx = n === 1 ? [g[0] / AA[0]] : mat.vec(mat.inv(AA), g);
        const xn = x.slice();
        free.forEach((k, a) => { xn[k] += dx[a]; });
        xn[1] = Math.max(0, Math.min(170, xn[1])); xn[2] = Math.max(0, Math.min(170, xn[2]));
        const rn = resid(xn), en = Math.hypot(...rn);
        if (en < err && Number.isFinite(en)) { x = xn; r = rn; err = en; lambda = Math.max(lambda / 3, 1e-7); improved = true; }
        else lambda *= 10;
      }
      if (!improved) break;
    }
    if (film.bw) { // ч/б: нейтральность обеспечена, подгоняем только Y
      x[1] = 0; x[2] = 0;
    }
    res.neutral = { logExp: x[0], m: x[1], y: x[2] };
    const cc = [s.filterC || 0, x[1] + (s.filterM || 0), x[2] + (s.filterY || 0)];
    const enl = makeEnlarger(sp, film, paper, enlargerLight(sp, cc));
    res.enlarger = bakeSpectral(film, enlargerWeights(paper, enlargerLight(sp, cc)), filmLo, filmHi);
    res.printLogExp = x[0] + (s.printExposure || 0) * 0.301;
    res.paperCurves = pc;
    const pdmax = pc.map((col) => Math.max(...col));
    res.paperLo = [-0.05, -0.05, -0.05];
    res.paperHi = pdmax.map((v) => v + 0.05);
    res.view = bakeSpectral(paper, viewWeights(sp, viewIllum), res.paperLo, res.paperHi);
    res.whiteScale = s.normWhite ? 0.97 / white[1] : 1;
    res.flare = 0.0003 * (s.flare ?? 1) * 10;
    res.outMatrix = mat.mul(outM, adaptation(sp.whiteXYZ(viewIllum), WHITE_D65));
    res.illumXYZ = sp.whiteXYZ(viewIllum);
    res.enlFn = enl; res.viewFn = view; res.paper = paper;
  }
  return res;
}

// Эталон одного пикселя (без пространственных эффектов и зерна).
export function cpuPixel(sp, P, rgbProPhoto, exposureEV = 0) {
  const xyz = mat.vec(P.tc.inMatrix, rgbProPhoto);
  const raw = tcSample(P.tc.lut, P.tc.N, xyz).map((v) => v * Math.pow(2, exposureEV));
  const logE = raw.map((v) => Math.log10(Math.max(v, 1e-10)) + P.curves.exposureShift);
  const Di = logE.map((x, c) => curveAt(P.curves.D[c], x));
  // DIR-компоненты для равномерного поля (эквивалент бесконечного размытия)
  const M = P.curves.M, dmax = P.curves.dmax;
  const silver = Di.map((d, j) => (P.positive ? dmax[j] - d : d));
  const D = [0, 1, 2].map((m) => {
    let a = 0;
    for (let j = 0; j < 3; j++) a += silver[j] * M[3 * j + m];
    return curveAt(P.curves.D0[m], logE[m] - a);
  });
  let XYZ;
  if (P.positive) XYZ = P.viewFn(D);
  else {
    const praw = P.enlFn(D);
    const pd = praw.map((v, c) => curveAt(P.paperCurves[c], Math.log10(Math.max(v, 1e-10)) + P.printLogExp));
    XYZ = P.viewFn(pd);
  }
  XYZ = XYZ.map((v, i) => v + P.flare * P.illumXYZ[i]).map((v) => v * P.whiteScale);
  return mat.vec(P.outMatrix, XYZ);
}

export const srgbEncode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
