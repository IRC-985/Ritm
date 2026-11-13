// Экспорт в полном разрешении: обработка тайлами + общий проход для крупных размытий
import { u16ToHalfTable } from './engine/gl.js';

// Uint16 RGB (фрагмент) -> half RGBA
export function regionToHalf(src, W, x0, y0, w, h) {
  const T = u16ToHalfTable();
  const out = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    let s = 3 * ((y0 + y) * W + x0), d = 4 * y * w;
    for (let x = 0; x < w; x++, s += 3, d += 4) {
      out[d] = T[src[s]]; out[d + 1] = T[src[s + 1]]; out[d + 2] = T[src[s + 2]]; out[d + 3] = 0x3c00;
    }
  }
  return out;
}

// Уменьшение Uint16 RGB до long <= max (усреднение блоков)
export function shrinkU16(src, w, h, max) {
  const f = Math.max(1, Math.ceil(Math.max(w, h) / max));
  if (f === 1) return { data: src, w, h, f };
  const W = Math.floor(w / f), H = Math.floor(h / f), n = f * f;
  const out = new Uint16Array(W * H * 3);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < f; dy++) {
      let s = 3 * ((Y * f + dy) * w + X * f);
      for (let dx = 0; dx < f; dx++, s += 3) { r += src[s]; g += src[s + 1]; b += src[s + 2]; }
    }
    const d = 3 * (Y * W + X);
    out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
  }
  return { data: out, w: W, h: H, f };
}

/**
 * img: {data: Uint16 RGB, w, h}; ctx: {pipeline, makeOpts(w,h,pxUm) -> opts для process}
 * Возвращает RGBA8 (Uint8ClampedArray) или RGB16 (Uint16Array) всего кадра.
 */
export async function renderFull(pipe, img, ctx, { bits = 8, onProgress = () => {} } = {}) {
  const { w: W, h: H, data } = img;
  const long = Math.max(W, H);
  const pxUm = ctx.filmMm * 1000 / long;
  // общий проход по уменьшенному кадру — ореол и хвост диффузии ингибиторов
  const g = shrinkU16(data, W, H, 2048);
  pipe.setSource(regionToHalf(g.data, g.w, 0, 0, g.w, g.h), g.w, g.h, { mipmap: false });
  const gres = pipe.process({ ...ctx.opts, w: g.w, h: g.h, pxUm: ctx.filmMm * 1000 / Math.max(g.w, g.h), keep: true, geo: [0, 0, g.w, g.h] });
  pipe.releaseResult(gres);
  const globals = gres.globals;
  // тайлы
  const margin = Math.min(160, Math.max(24, Math.ceil(3 * 1.88 * 9.37 / pxUm + 3 * 20 / pxUm) + 8));
  const T = Math.min(2048, pipe.maxTex - 2 * margin);
  const out = bits === 16 ? new Uint16Array(W * H * 3) : new Uint8ClampedArray(W * H * 4);
  const nx = Math.ceil(W / T), ny = Math.ceil(H / T);
  const k = pipe.k, gl = pipe.gl;
  let done = 0;
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const cx0 = tx * T, cy0 = ty * T;
      const cw = Math.min(T, W - cx0), ch = Math.min(T, H - cy0);
      const x0 = Math.max(0, cx0 - margin), y0 = Math.max(0, cy0 - margin);
      const x1 = Math.min(W, cx0 + cw + margin), y1 = Math.min(H, cy0 + ch + margin);
      const w = x1 - x0, h = y1 - y0;
      pipe.setSource(regionToHalf(data, W, x0, y0, w, h), w, h, { mipmap: false });
      const res = pipe.process({
        ...ctx.opts, w, h, pxUm, globals, geo: [x0, y0, W, H],
        grect: [x0 / W, y0 / H, w / W, h / H],
      });
      const target = k.acquire(w, h, bits === 16 ? 'half' : 'u8');
      pipe.output(res, target, { sharp: ctx.sharp, encode: true });
      pipe.releaseResult(res);
      const ox = cx0 - x0, oy = cy0 - y0;
      if (bits === 16) {
        const px = k.readPixels(target, ox, oy, cw, ch, true);
        for (let y = 0; y < ch; y++) {
          let s = 4 * y * cw, d = 3 * ((cy0 + y) * W + cx0);
          for (let x = 0; x < cw; x++, s += 4, d += 3) {
            out[d] = px[s] * 65535 + 0.5; out[d + 1] = px[s + 1] * 65535 + 0.5; out[d + 2] = px[s + 2] * 65535 + 0.5;
          }
        }
      } else {
        const px = k.readPixels(target, ox, oy, cw, ch);
        for (let y = 0; y < ch; y++) out.set(px.subarray(4 * y * cw, 4 * (y + 1) * cw), 4 * ((cy0 + y) * W + cx0));
      }
      k.release(target);
      done++;
      onProgress(done / (nx * ny));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  pipe.releaseGlobals(globals);
  gl.finish();
  return out;
}

// 16-битный TIFF (RGB, без сжатия, с sRGB по умолчанию)
export function encodeTiff16(rgb, w, h) {
  const n = 11;
  const ifdSize = 2 + n * 12 + 4;
  const headerSize = 8;
  const extra = 6 + 8 + 8; // BitsPerSample[3], XRes, YRes
  const dataOff = headerSize + ifdSize + extra;
  const buf = new ArrayBuffer(dataOff + rgb.length * 2);
  const v = new DataView(buf);
  v.setUint16(0, 0x4949, true); v.setUint16(2, 42, true); v.setUint32(4, 8, true);
  let p = 8;
  v.setUint16(p, n, true); p += 2;
  const extraOff = headerSize + ifdSize;
  const tag = (t, type, count, val) => {
    v.setUint16(p, t, true); v.setUint16(p + 2, type, true); v.setUint32(p + 4, count, true);
    if (type === 3 && count === 1) v.setUint16(p + 8, val, true); else v.setUint32(p + 8, val, true);
    p += 12;
  };
  tag(256, 4, 1, w); tag(257, 4, 1, h);
  tag(258, 3, 3, extraOff);
  tag(259, 3, 1, 1); tag(262, 3, 1, 2);
  tag(273, 4, 1, dataOff); tag(277, 3, 1, 3); tag(278, 4, 1, h);
  tag(279, 4, 1, rgb.length * 2);
  tag(282, 5, 1, extraOff + 6); tag(283, 5, 1, extraOff + 14);
  v.setUint32(p, 0, true);
  v.setUint16(extraOff, 16, true); v.setUint16(extraOff + 2, 16, true); v.setUint16(extraOff + 4, 16, true);
  v.setUint32(extraOff + 6, 300, true); v.setUint32(extraOff + 10, 1, true);
  v.setUint32(extraOff + 14, 300, true); v.setUint32(extraOff + 18, 1, true);
  new Uint16Array(buf, dataOff).set(rgb); // little-endian платформы
  return new Blob([buf], { type: 'image/tiff' });
}

// Кодирование JPEG в отдельном потоке
export function encodeJpeg(rgba, w, h, quality = 92, p3 = false) {
  return new Promise((resolve, reject) => {
    const wk = new Worker(new URL('./jpeg-worker.js', import.meta.url), { type: 'module' });
    wk.onmessage = (e) => { wk.terminate(); e.data.ok ? resolve(e.data.blob) : reject(new Error(e.data.error)); };
    wk.onerror = (e) => { wk.terminate(); reject(new Error(e.message)); };
    wk.postMessage({ rgba, w, h, quality, p3 }, [rgba.buffer]);
  });
}
