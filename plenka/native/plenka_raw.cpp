// Плёнка: минимальная обёртка LibRaw для WebAssembly (однопоточная, без SharedArrayBuffer).
// Отдаёт линейное 16-битное изображение в ProPhoto RGB (D50) без гаммы и автояркости.
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <emscripten.h>
#include "libraw/libraw.h"

static LibRaw *P = nullptr;
static char meta_buf[4096];

static void json_str(char *dst, size_t n, const char *s) {
  size_t j = 0;
  for (size_t i = 0; s && s[i] && j + 2 < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { dst[j++] = '\\'; dst[j++] = c; }
    else if (c >= 32) dst[j++] = c;
  }
  dst[j] = 0;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE int pl_open(uint8_t *data, int size) {
  if (!P) P = new LibRaw();
  else P->recycle();
  return P->open_buffer(data, (size_t)size);
}

// half: 1 = половинный размер (быстро, без демозаики)
// highlight: 0 клип, 1 без клипа, 2 смешивание, 3..9 реконструкция
// quality: 0 линейная, 1 VNG, 2 PPG, 3 AHD, 4 DCB, 11 DHT, 12 AAHD
// wb: 0 как снято, 1 авто, 2 без баланса (дневной матрицы)
EMSCRIPTEN_KEEPALIVE int pl_process(int half, int highlight, int quality, int wb) {
  if (!P) return -1;
  libraw_output_params_t &o = P->imgdata.params;
  o.output_color = 4;  // ProPhoto
  o.output_bps = 16;
  o.gamm[0] = 1.0; o.gamm[1] = 1.0;
  o.no_auto_bright = 1;
  o.use_camera_wb = (wb == 0) ? 1 : 0;
  o.use_auto_wb = (wb == 1) ? 1 : 0;
  o.use_camera_matrix = 1;
  o.half_size = half;
  o.highlight = highlight;
  o.user_qual = quality;
  o.user_flip = 0;  // поворот делаем сами
  int r = P->unpack();
  if (r != LIBRAW_SUCCESS) return r;
  return P->dcraw_process();
}

// Сжимает image[][4] -> RGB16 на месте. out[0]=w, out[1]=h.
EMSCRIPTEN_KEEPALIVE uint16_t *pl_image(int *out) {
  if (!P || !P->imgdata.image) return nullptr;
  int w = P->imgdata.sizes.iwidth, h = P->imgdata.sizes.iheight;
  ushort(*img)[4] = P->imgdata.image;
  uint16_t *dst = (uint16_t *)img;
  size_t n = (size_t)w * h;
  for (size_t i = 0; i < n; i++) {
    uint16_t r = img[i][0], g = img[i][1], b = img[i][2];
    dst[3 * i] = r; dst[3 * i + 1] = g; dst[3 * i + 2] = b;
  }
  out[0] = w; out[1] = h;
  return dst;
}

EMSCRIPTEN_KEEPALIVE const char *pl_meta() {
  if (!P) return "{}";
  auto &d = P->imgdata;
  char make[128], model[128], lens[256];
  json_str(make, sizeof make, d.idata.make);
  json_str(model, sizeof model, d.idata.model);
  json_str(lens, sizeof lens, d.lens.Lens);
  snprintf(meta_buf, sizeof meta_buf,
    "{\"make\":\"%s\",\"model\":\"%s\",\"lens\":\"%s\",\"iso\":%g,\"shutter\":%g,"
    "\"aperture\":%g,\"focal\":%g,\"timestamp\":%lld,\"width\":%d,\"height\":%d,"
    "\"flip\":%d,\"camMul\":[%g,%g,%g,%g],\"preMul\":[%g,%g,%g,%g],\"filters\":%u,\"colors\":%d}",
    make, model, lens, d.other.iso_speed, d.other.shutter, d.other.aperture,
    d.other.focal_len, (long long)d.other.timestamp, d.sizes.width, d.sizes.height,
    d.sizes.flip, d.color.cam_mul[0], d.color.cam_mul[1], d.color.cam_mul[2], d.color.cam_mul[3],
    d.color.pre_mul[0], d.color.pre_mul[1], d.color.pre_mul[2], d.color.pre_mul[3],
    d.idata.filters, d.idata.colors);
  return meta_buf;
}

EMSCRIPTEN_KEEPALIVE const char *pl_error(int code) { return libraw_strerror(code); }

EMSCRIPTEN_KEEPALIVE void pl_close() {
  if (P) { P->recycle(); delete P; P = nullptr; }
}

}
