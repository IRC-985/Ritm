// Декодирование RAW в отдельном потоке (LibRaw, WebAssembly).
// Каждый файл — новый поток: после работы он закрывается и освобождает память.

let mod = null;

async function getModule(url) {
  if (!mod) {
    const m = await import(/* @vite-ignore */ url);
    mod = await m.default();
  }
  return mod;
}

// Поворот по EXIF (коды LibRaw: 3 = 180°, 5 = 90° против часовой, 6 = 90° по часовой)
function orient(src, w, h, flip) {
  if (flip !== 3 && flip !== 5 && flip !== 6) return { data: src, w, h };
  const rot = flip === 3 ? 180 : flip === 6 ? 90 : 270;
  const W = rot === 180 ? w : h, H = rot === 180 ? h : w;
  const out = new Uint16Array(W * H * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X, Y;
      if (rot === 180) { X = w - 1 - x; Y = h - 1 - y; }
      else if (rot === 90) { X = h - 1 - y; Y = x; }
      else { X = y; Y = w - 1 - x; }
      const s = 3 * (y * w + x), d = 3 * (Y * W + X);
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
    }
  }
  return { data: out, w: W, h: H };
}

// Уменьшение усреднением блоков f×f
function shrink(src, w, h, f) {
  if (f <= 1) return { data: src, w, h };
  const W = Math.floor(w / f), H = Math.floor(h / f);
  const out = new Uint16Array(W * H * 3);
  const n = f * f;
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < f; dy++) {
        let s = 3 * ((Y * f + dy) * w + X * f);
        for (let dx = 0; dx < f; dx++, s += 3) { r += src[s]; g += src[s + 1]; b += src[s + 2]; }
      }
      const d = 3 * (Y * W + X);
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
    }
  }
  return { data: out, w: W, h: H };
}

self.onmessage = async (ev) => {
  const { id, wasmUrl, buffer, half, maxSize, highlight = 0, quality = 3 } = ev.data;
  try {
    const m = await getModule(wasmUrl);
    const bytes = new Uint8Array(buffer);
    const p = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, p);
    let r = m._pl_open(p, bytes.length);
    if (r !== 0) throw new Error('Не удалось открыть файл: ' + m.UTF8ToString(m._pl_error(r)));
    const meta = JSON.parse(m.UTF8ToString(m._pl_meta()));
    r = m._pl_process(half ? 1 : 0, highlight, quality, 0);
    if (r !== 0) throw new Error('Ошибка декодирования: ' + m.UTF8ToString(m._pl_error(r)));
    const op = m._malloc(8);
    const ip = m._pl_image(op);
    const w = m.HEAP32[op >> 2], h = m.HEAP32[(op >> 2) + 1];
    // копия из памяти WASM (адрес может быть > 2 ГБ)
    let img = new Uint16Array(m.HEAPU8.buffer, ip >>> 0, w * h * 3).slice();
    m._pl_close();
    m._free(p);
    let res = { data: img, w, h };
    if (maxSize) {
      const f = Math.max(1, Math.floor(Math.max(w, h) / maxSize));
      res = shrink(res.data, res.w, res.h, f);
    }
    res = orient(res.data, res.w, res.h, meta.flip);
    self.postMessage({ id, ok: true, meta, w: res.w, h: res.h, data: res.data }, [res.data.buffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
