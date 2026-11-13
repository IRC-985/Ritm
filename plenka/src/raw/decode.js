// Открытие файлов: RAW через LibRaw (в потоке), JPEG/PNG/TIFF через браузер.
import { mat, PROPHOTO_TO_XYZ, XYZ_TO_PROPHOTO, adaptation, WHITE_D50, WHITE_D65 } from '../engine/spectral.js';

const RAW_EXT = /\.(arw|srf|sr2|nef|nrw|raf|dng|cr2|cr3|crw|orf|rw2|pef|srw|3fr|fff|iiq|erf|kdc|mef|mos|mrw|x3f|raw|rwl|gpr)$/i;

export const isRaw = (name) => RAW_EXT.test(name);

export function wasmUrl() {
  return new URL('wasm/plenka_raw.mjs', document.baseURI).href;
}

let nextId = 1;
export function decodeRaw(buffer, { half = true, maxSize = 0, highlight = 0, quality = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const id = nextId++;
    w.onmessage = (ev) => {
      w.terminate();
      if (ev.data.ok) resolve(ev.data);
      else reject(new Error(ev.data.error));
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Ошибка потока декодирования')); };
    w.postMessage({ id, wasmUrl: wasmUrl(), buffer, half, maxSize, highlight, quality }, [buffer]);
  });
}

// Обычная картинка (sRGB) -> линейный ProPhoto 16 бит
export async function decodeImage(blob, maxSize = 0) {
  const bmp = await createImageBitmap(blob);
  let w = bmp.width, h = bmp.height;
  if (maxSize && Math.max(w, h) > maxSize) {
    const k = maxSize / Math.max(w, h);
    w = Math.round(w * k); h = Math.round(h * k);
  }
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lin[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  const SRGB_TO_XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
  const M = mat.mul(XYZ_TO_PROPHOTO, mat.mul(adaptation(WHITE_D65, WHITE_D50), SRGB_TO_XYZ));
  const out = new Uint16Array(w * h * 3);
  // JPEG уже «проявлен»: сдвигаем средний серый вниз, чтобы оставить запас по светам
  const k = 0.5 * 65535;
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    const r = lin[px[4 * i]], g = lin[px[4 * i + 1]], b = lin[px[4 * i + 2]];
    out[j] = Math.min(65535, Math.max(0, (M[0] * r + M[1] * g + M[2] * b) * k));
    out[j + 1] = Math.min(65535, Math.max(0, (M[3] * r + M[4] * g + M[5] * b) * k));
    out[j + 2] = Math.min(65535, Math.max(0, (M[6] * r + M[7] * g + M[8] * b) * k));
  }
  return { meta: { make: '', model: '', timestamp: (blob.lastModified || Date.now()) / 1000 }, w, h, data: out };
}

export { PROPHOTO_TO_XYZ };
