import {
  loadData, Spectra, buildProcess, mat, PROPHOTO_TO_XYZ, XYZ_TO_PROPHOTO, XYZ_TO_SRGB,
  adaptation, WHITE_D50, WHITE_D65, filmResponse, cpuPixel, srgbEncode,
} from './engine/spectral.js';
import { createGL, u16ToHalfTable, toHalf } from './engine/gl.js';
import { Pipeline, FORMATS } from './engine/pipeline.js';
import { decodeRaw, decodeImage, isRaw } from './raw/decode.js';
import { renderFull, encodeJpeg, encodeTiff16, shrinkU16 } from './export.js';
import { buildPanel, DEFAULTS } from './ui.js';
import { makeStampCanvas, stampText } from './stamp.js';
import { saveBlob } from './save.js';

const $ = (id) => document.getElementById(id);
const canvas = $('gl');
const panel = $('panel');

// ------------------------------------------------------------ состояние
const S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem('plenka.settings') || '{}')); } catch { /* нет хранилища */ }
let sp = null, data = null, pipe = null;
let img = null;          // { file, raw, meta, w, h, data(Uint16 RGB), half }
let P = null, chemKey = '', autoEV = 0;
let showBefore = false;
let zoom = null;         // null = вписать; иначе {cx, cy} — центр в пикселях рабочего изображения
let stampKey = '';
let WORK_MAX = 4096;     // рабочее разрешение для просмотра и лупы (не больше предела видеокарты)

function persist() {
  try { localStorage.setItem('plenka.settings', JSON.stringify(S)); } catch { /* приватный режим */ }
}

// ------------------------------------------------------------ интерфейс
function busy(text, progress) {
  const b = $('busy');
  if (text === false) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  $('busyText').textContent = text;
  let bar = b.querySelector('.progress');
  if (progress != null) {
    if (!bar) { bar = document.createElement('div'); bar.className = 'progress'; bar.appendChild(document.createElement('div')); b.appendChild(bar); }
    bar.firstChild.style.width = Math.round(progress * 100) + '%';
  } else if (bar) bar.remove();
}

function toast(msg, ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

const filmOf = () => data.stocks[S.film];
const paperId = () => {
  const f = filmOf();
  if (S.paper !== 'auto' && data.stocks[S.paper]) return S.paper;
  return f.targetPrint && data.stocks[f.targetPrint] ? f.targetPrint : (f.bw ? 'ilford_mg_fb' : 'kodak_portra_endura');
};

function neutralInfo() {
  const d = document.createElement('div');
  d.className = 'hint';
  if (P && P.neutral) {
    const n = P.neutral;
    d.textContent = filmOf().bw ? 'Экспозиция подобрана по серой карте.' :
      `Нейтральная фильтрация подобрана автоматически: M ${n.m.toFixed(0)}, Y ${n.y.toFixed(0)} CC. Ползунки выше — поправка к ней.`;
  }
  return d;
}

function rebuildPanel() {
  buildPanel(panel, data.stocks, S, onChange, { neutral: neutralInfo });
  const d = document.createElement('div');
  d.className = 'hint diag';
  d.style.padding = '12px 14px';
  const r = selfTest.result;
  d.textContent = r ? `Видеокарта: ${r.info}. Самопроверка: ${r.err < 0.08 && !r.glErr ? 'пройдена' : 'НЕ пройдена'} (${r.got.map((v) => v.toFixed(2)).join('/')} при ожидаемых ${r.exp.map((v) => v.toFixed(2)).join('/')}).` : '';
  panel.appendChild(d);
}

const CHEM_KEYS = ['film', 'paper', 'push', 'couplers', 'lensFilter', 'sceneIllum', 'paperContrast', 'filterC', 'filterM',
  'filterY', 'slideView', 'normWhite', 'flare', 'grainSize', 'outSpace', 'printExposure'];

function onChange(k, v, live) {
  if (k === '__reset') {
    const film = S.film;
    Object.assign(S, DEFAULTS, { film });
    persist();
    rebuildPanel();
    schedule();
    return;
  }
  if (k === 'highlight') v = +v;
  S[k] = v;
  if (!live) persist();
  if (k === 'film') { S.paper = 'auto'; S.push = 0; rebuildPanel(); }
  else if (k === 'paper') rebuildPanel();
  if (k === 'autoExposure') updateAutoEV();
  schedule();
  updateBadge();
}

function updateBadge() {
  if (!data) return;
  const f = filmOf();
  const neg = f.type !== 'positive';
  $('filmBadge').textContent = f.name + (neg ? ' → ' + data.stocks[paperId()].name : '') + (showBefore ? '  ·  ИСХОДНИК' : '');
}

// ------------------------------------------------------------ «химия»
function ensureChem() {
  const f = filmOf();
  const neg = f.type !== 'positive';
  const key = JSON.stringify([...CHEM_KEYS.map((k) => S[k]), paperId(), neg ? S.exposure : 0]);
  if (key === chemKey && P) return;
  chemKey = key;
  P = buildProcess(sp, {
    film: S.film, paper: paperId(), push: S.push, couplers: S.couplers, lensFilter: S.lensFilter,
    sceneIllum: S.sceneIllum === 'film' ? undefined : S.sceneIllum, exposure: S.exposure,
    paperContrast: S.paperContrast, filterC: S.filterC, filterM: S.filterM, filterY: S.filterY,
    printExposure: S.printExposure, slideView: S.slideView, normWhite: S.normWhite, flare: S.flare,
    grainSize: S.grainSize, outSpace: S.outSpace,
  });
  pipe.setProcess(P);
  stampKey = '';
  const nb = panel.querySelector('.sec .hint');
  if (neg && document.querySelector('details.sec')) {
    // обновить подсказку о нейтральной фильтрации
    const old = [...panel.querySelectorAll('.hint')].find((e) => e.textContent.startsWith('Нейтральная') || e.textContent.startsWith('Экспозиция подобрана'));
    if (old) old.replaceWith(neutralInfo());
  }
  void nb;
}

// Баланс белого: сдвиг по планковской кривой (майреды) и оттенок
function wbMatrix() {
  const ref = (() => { const v = sp.xyz(sp.planck(5003)); return [v[0] / v[1], 1, v[2] / v[1]]; })();
  const mired = 1e6 / 5003 - S.warmth;
  const v = sp.xyz(sp.planck(1e6 / Math.max(mired, 20)));
  const t = 1 + S.tint * 0.004;
  const src = [v[0] / v[1] / t, 1, v[2] / v[1] / t];
  return mat.mul(XYZ_TO_PROPHOTO, mat.mul(adaptation(src, ref), PROPHOTO_TO_XYZ));
}

function updateAutoEV() {
  if (!img) return;
  if (!S.autoExposure) { autoEV = 0; return; }
  // центрально-взвешенное среднее геометрическое яркости
  const { w, h, data: d } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
  let sl = 0, sw = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = 3 * (y * w + x);
    const Y = (0.288 * d[i] + 0.7119 * d[i + 1] + 0.0001 * d[i + 2]) / 65535;
    const dx = x / w - 0.5, dy = y / h - 0.5;
    const wt = Math.exp(-(dx * dx + dy * dy) / (2 * 0.3 * 0.3));
    sl += wt * Math.log(Math.max(Y, 1e-5));
    sw += wt;
  }
  const gm = Math.exp(sl / sw);
  autoEV = Math.max(-6, Math.min(10, Math.log2(0.184 / gm)));
}

function stampFor(scaleW, scaleH) {
  if (!S.dateStamp || !img) return null;
  const date = img.meta.timestamp ? new Date(img.meta.timestamp * 1000) : new Date();
  const text = stampText(date, S.dateStyle);
  const key = text + '|' + S.film;
  if (key !== stampKey) {
    const st = makeStampCanvas(text);
    pipe.setStamp(st.canvas);
    stampKey = key;
    stampFor.used = st.used / st.w;
  }
  // оранжевый светодиод (x≈0.60, y≈0.39), очень яркий
  const x = 0.6, y = 0.39, Yb = 6 * S.stampPower;
  const col = filmResponse(P, [Yb * x / y, Yb, Yb * (1 - x - y) / y]);
  const H = scaleH, W = scaleW;
  const sh = 0.045 * Math.min(W, H) * 1.3, sw = sh * 5;
  const rx = W - 0.05 * W - sw * stampFor.used, ry = H - 0.06 * H - sh;
  return { rect: [rx, ry, sw, sh], col };
}

function processOpts(w, h, fullW, fullH) {
  return {
    s: S,
    expMul: Math.pow(2, autoEV + S.exposure),
    inMatrix: mat.mul(P.tc.inMatrix, wbMatrix()),
    stamp: stampFor(fullW, fullH),
  };
}

// ------------------------------------------------------------ отрисовка
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    try { draw(); } catch (e) {
      console.error(e);
      if (!schedule.reported) { schedule.reported = true; toast('Ошибка отрисовки: ' + e.message + '. ' + gpuInfo(), 15000); }
    }
  });
}

function draw() {
  if (!img || !pipe) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const gl = pipe.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, cw, ch);
  gl.clearColor(0.047, 0.04, 0.03, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  ensureChem();
  const film = filmOf();
  const mm = FORMATS[S.format].mm;
  let ow, oh, srcRect, geo, pxUm, vp, fullW, fullH;
  if (!zoom) {
    const sc = Math.min(cw / img.w, ch / img.h, 1);
    ow = Math.max(1, Math.round(img.w * sc)); oh = Math.max(1, Math.round(img.h * sc));
    const fit = Math.min(cw / ow, ch / oh);
    const dw = Math.round(ow * fit), dh = Math.round(oh * fit);
    vp = [Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh];
    srcRect = [0, 0, 1, 1];
    geo = [0, 0, ow, oh];
    fullW = ow; fullH = oh;
    pxUm = mm * 1000 / Math.max(ow, oh);
  } else {
    ow = Math.min(cw, img.w); oh = Math.min(ch, img.h);
    zoom.cx = Math.max(ow / 2, Math.min(img.w - ow / 2, zoom.cx));
    zoom.cy = Math.max(oh / 2, Math.min(img.h - oh / 2, zoom.cy));
    const x0 = Math.round(zoom.cx - ow / 2), y0 = Math.round(zoom.cy - oh / 2);
    srcRect = [x0 / img.w, y0 / img.h, ow / img.w, oh / img.h];
    geo = [x0, y0, img.w, img.h];
    fullW = img.w; fullH = img.h;
    pxUm = mm * 1000 / Math.max(img.w, img.h);
    vp = [Math.round((cw - ow) / 2), Math.round((ch - oh) / 2), ow, oh];
  }
  draw.vp = vp; draw.ow = ow; draw.oh = oh; draw.srcRect = srcRect;
  if (showBefore) {
    const M = mat.mul(XYZ_TO_SRGB, mat.mul(adaptation(WHITE_D50, WHITE_D65), PROPHOTO_TO_XYZ));
    pipe.before(null, {
      M: mat.mul(M, wbMatrix()), expMul: Math.pow(2, autoEV + S.exposure),
      view: [srcRect[0], srcRect[1] + srcRect[3], srcRect[2], -srcRect[3]], viewport: vp,
    });
    return;
  }
  const o = processOpts(ow, oh, fullW, fullH);
  const res = pipe.process({ ...o, w: ow, h: oh, geo, srcRect, pxUm });
  pipe.output(res, null, { sharp: S.sharpen, view: [0, 1, 1, -1], viewport: vp });
  pipe.releaseResult(res);
  void film;
}

// ------------------------------------------------------------ открытие
async function openFile(file) {
  try {
    busy('Чтение файла…');
    let dec;
    const raw = isRaw(file.name);
    if (raw) {
      busy('Декодирование RAW…');
      dec = await decodeRaw(await file.arrayBuffer(), { half: true, maxSize: WORK_MAX, highlight: S.highlight });
    } else {
      dec = await decodeImage(file, WORK_MAX);
    }
    const T = u16ToHalfTable();
    const n = dec.w * dec.h;
    const half = new Uint16Array(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      half[4 * i] = T[dec.data[j]]; half[4 * i + 1] = T[dec.data[j + 1]]; half[4 * i + 2] = T[dec.data[j + 2]]; half[4 * i + 3] = 0x3c00;
    }
    img = { file, raw, meta: dec.meta, w: dec.w, h: dec.h, data: dec.data };
    pipe.setSource(half, dec.w, dec.h);
    zoom = null;
    updateAutoEV();
    $('empty').classList.add('hidden');
    $('btnExport').disabled = false;
    const m = dec.meta;
    const parts = [file.name];
    if (m.make) parts.push(`${m.make} ${m.model}`);
    if (m.iso) parts.push(`ISO ${m.iso}`);
    if (m.shutter) parts.push(m.shutter >= 1 ? `${m.shutter} с` : `1/${Math.round(1 / m.shutter)}`);
    if (m.aperture) parts.push(`f/${m.aperture}`);
    $('fileInfo').textContent = parts.join(' · ');
    busy(false);
    schedule();
  } catch (e) {
    busy(false);
    console.error(e);
    toast('Не удалось открыть: ' + e.message, 6000);
  }
}

// ------------------------------------------------------------ экспорт
async function exportImage() {
  if (!img) return;
  const t0 = performance.now();
  try {
    busy('Декодирование в полном размере…');
    let full;
    const half = S.exportSize === 'half';
    if (img.raw) full = await decodeRaw(await img.file.arrayBuffer(), { half, highlight: S.highlight });
    else full = await decodeImage(img.file, 0);
    if (!img.raw && half) {
      full = { ...full, ...shrinkU16(full.data, full.w, full.h, Math.max(full.w, full.h) / 2) };
    }
    const bits = S.exportFormat === 'tiff' ? 16 : 8;
    busy('Проявка и печать…', 0);
    ensureChem();
    const opts = processOpts(full.w, full.h, full.w, full.h);
    const out = await renderFull(pipe, full, { opts, filmMm: FORMATS[S.format].mm, sharp: S.sharpen }, {
      bits, onProgress: (p) => busy('Проявка и печать…', p),
    });
    const base = img.file.name.replace(/\.[^.]+$/, '');
    const fname = `${base}_${S.film}.${bits === 16 ? 'tif' : 'jpg'}`;
    busy('Сохранение…');
    const blob = bits === 16 ? encodeTiff16(out, full.w, full.h) : await encodeJpeg(out, full.w, full.h, S.jpegQuality, S.outSpace === 'p3');
    full = null;
    const msg = await saveBlob(blob, fname);
    toast(`${msg} (${((performance.now() - t0) / 1000).toFixed(1)} с)`);
  } catch (e) {
    console.error(e);
    toast('Ошибка сохранения: ' + e.message, 7000);
  } finally {
    // вернуть рабочее изображение в видеопамять
    const T = u16ToHalfTable();
    const n = img.w * img.h;
    const halfData = new Uint16Array(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      halfData[4 * i] = T[img.data[j]]; halfData[4 * i + 1] = T[img.data[j + 1]]; halfData[4 * i + 2] = T[img.data[j + 2]]; halfData[4 * i + 3] = 0x3c00;
    }
    pipe.setSource(halfData, img.w, img.h);
    pipe.k.freeAll();
    busy(false);
    schedule();
  }
}

// ------------------------------------------------------------ жесты
function setupInput() {
  const fi = $('fileInput');
  const open = () => fi.click();
  $('btnOpen').onclick = open;
  $('btnOpen2').onclick = open;
  fi.onchange = () => { if (fi.files[0]) openFile(fi.files[0]); fi.value = ''; };
  $('btnExport').onclick = exportImage;
  const bb = $('btnBefore');
  const setBefore = (v) => { showBefore = v; bb.classList.toggle('on', v); updateBadge(); schedule(); };
  bb.addEventListener('pointerdown', (e) => { e.preventDefault(); setBefore(true); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) bb.addEventListener(ev, () => setBefore(false));
  window.addEventListener('keydown', (e) => { if (e.key === '\\' && !e.repeat) setBefore(true); });
  window.addEventListener('keyup', (e) => { if (e.key === '\\') setBefore(false); });
  const viewer = $('viewer');
  viewer.addEventListener('dragover', (e) => e.preventDefault());
  viewer.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
  // лупа 1:1 и перемещение
  const toImage = (e) => {
    const r = canvas.getBoundingClientRect();
    const dpr = canvas.width / r.width;
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    const [vx, vy, vw, vh] = draw.vp || [0, 0, 1, 1];
    if (!zoom) return { x: (px - vx) / vw * img.w, y: (py - vy) / vh * img.h };
    return { x: zoom.cx - draw.ow / 2 + (px - vx), y: zoom.cy - draw.oh / 2 + (py - vy) };
  };
  const toggleZoom = (e) => {
    if (!img) return;
    if (zoom) zoom = null;
    else { const p = e ? toImage(e) : { x: img.w / 2, y: img.h / 2 }; zoom = { cx: p.x, cy: p.y }; }
    $('btnZoom').classList.toggle('on', !!zoom);
    schedule();
  };
  $('btnZoom').onclick = () => toggleZoom(null);
  viewer.addEventListener('dblclick', toggleZoom);
  let drag = null, lastTap = 0;
  viewer.addEventListener('pointerdown', (e) => {
    const now = Date.now();
    if (e.pointerType !== 'mouse' && now - lastTap < 300) { toggleZoom(e); lastTap = 0; return; }
    lastTap = now;
    if (zoom) { drag = { x: e.clientX, y: e.clientY, cx: zoom.cx, cy: zoom.cy }; viewer.setPointerCapture(e.pointerId); }
  });
  viewer.addEventListener('pointermove', (e) => {
    if (!drag || !zoom) return;
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    zoom.cx = drag.cx - (e.clientX - drag.x) * dpr;
    zoom.cy = drag.cy - (e.clientY - drag.y) * dpr;
    schedule();
  });
  viewer.addEventListener('pointerup', () => { drag = null; });
  new ResizeObserver(() => schedule()).observe(viewer);
}

// ------------------------------------------------------------ самопроверка видеокарты
function gpuInfo() {
  const gl = pipe.gl;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const flags = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear']
    .filter((e) => gl.getSupportedExtensions().includes(e)).join(', ');
  return `${r}; макс. текстура ${pipe.maxTex}; ${flags}`;
}

function selfTest() {
  try {
    ensureChem();
    const w = 64, h = 48, g = 0.184;
    const f = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { f[4 * i] = g; f[4 * i + 1] = g; f[4 * i + 2] = g; f[4 * i + 3] = 1; }
    pipe.setSource(toHalf(f), w, h);
    const s0 = { ...S, grain: 0, halation: 0, scatter: 0, vignette: 0, boost: 0, sharpen: 0, saturation: 1 };
    const res = pipe.process({ s: s0, expMul: 1, inMatrix: P.tc.inMatrix, w, h, pxUm: 36000 / w });
    const t = pipe.k.acquire(w, h, 'u8');
    pipe.output(res, t, { sharp: 0, encode: true });
    pipe.releaseResult(res);
    const px = pipe.k.readPixels(t, w / 2, h / 2, 1, 1);
    pipe.k.release(t);
    const got = [px[0], px[1], px[2]].map((v) => v / 255);
    const exp = cpuPixel(sp, P, [g, g, g], 0).map((v) => srgbEncode(Math.min(1, Math.max(0, v))));
    const err = Math.max(...got.map((v, i) => Math.abs(v - exp[i])));
    const glErr = pipe.gl.getError();
    selfTest.result = { got, exp, err, glErr, info: gpuInfo() };
    if (err > 0.08 || glErr) {
      const msg = `Самопроверка видеокарты не прошла: получено ${got.map((v) => v.toFixed(2)).join('/')}, ожидалось ${exp.map((v) => v.toFixed(2)).join('/')}` +
        (glErr ? `, ошибка WebGL ${glErr}` : '') + `. ${gpuInfo()}`;
      console.warn(msg);
      $('empty').querySelector('.empty-sub').textContent = msg;
      toast(msg, 15000);
    }
  } catch (e) {
    const msg = 'Самопроверка видеокарты: ' + e.message + '. ' + (pipe ? gpuInfo() : '');
    console.warn(msg);
    $('empty').querySelector('.empty-sub').textContent = msg;
    toast(msg, 15000);
  }
}

// ------------------------------------------------------------ запуск
async function start() {
  try {
    busy('Загрузка данных плёнок…');
    data = await loadData(new URL('data/', document.baseURI).href);
    sp = new Spectra(data);
    if (!data.stocks[S.film]) S.film = DEFAULTS.film;
    pipe = new Pipeline(createGL(canvas));
    WORK_MAX = Math.min(4096, pipe.maxTex);
    rebuildPanel();
    updateBadge();
    setupInput();
    busy(false);
    selfTest();
    rebuildPanel();
    window.__plenka = { S, openFile, exportImage, get P() { return P; }, schedule, onChange, selfTest };
  } catch (e) {
    console.error(e);
    busy(false);
    $('empty').querySelector('.empty-title').textContent = 'Ошибка запуска';
    $('empty').querySelector('.empty-sub').textContent = e.message;
  }
}

start();
