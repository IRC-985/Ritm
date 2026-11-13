// Кодирование JPEG средствами браузера (OffscreenCanvas) в отдельном потоке
self.onmessage = async (e) => {
  const { rgba, w, h, quality, p3 } = e.data;
  try {
    const cs = p3 ? 'display-p3' : 'srgb';
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { colorSpace: cs });
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h, { colorSpace: cs }), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
    self.postMessage({ ok: true, blob });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
