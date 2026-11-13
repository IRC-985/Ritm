// GLSL-шейдеры конвейера «Плёнка»

const HEAD = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUV;
out vec4 outColor;
`;

// Кривая из текстуры 256xR: строка row, x = logE
const CURVE = `
uniform sampler2D uCurves;
uniform vec2 uLE; // min, max
float curveTex(float x, float row, int ch) {
  float f = clamp((x - uLE.x) / (uLE.y - uLE.x), 0.0, 1.0) * 255.0 + 0.5;
  vec4 v = texture(uCurves, vec2(f / 256.0, (row + 0.5) / uCurveRows));
  return ch == 0 ? v.r : (ch == 1 ? v.g : v.b);
}
vec3 curve3(vec3 x, float row) {
  return vec3(curveTex(x.r, row, 0), curveTex(x.g, row, 1), curveTex(x.b, row, 2));
}
`;

const HASH = `
uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float urand(uvec2 p, uint s) {
  return (float(hash(p.x * 1973u + hash(p.y * 9277u + s * 26699u))) + 0.5) / 4294967296.0;
}
// нормальное распределение (Бокс-Мюллер)
float nrand(uvec2 p, uint s) {
  float u1 = urand(p, s * 2u + 1u), u2 = urand(p, s * 2u + 2u);
  return sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
}
`;

// 1. Экспонирование: ProPhoto -> экспозиция слоёв через спектральную таблицу
export const EXPOSE = HEAD + `
uniform sampler2D uSrc;
uniform sampler2D uTc;
uniform mat3 uIn;
uniform float uTcN;
uniform float uExp;
uniform vec4 uVig;      // сила, радиус, мягкость, 0
uniform vec4 uGeo;      // смещение тайла (x,y) и размер всего кадра (w,h), в пикселях
uniform vec2 uSize;     // размер текущего вывода
uniform float uBoost;   // восстановление светов, в стопах
uniform vec4 uSrcRect;  // область исходника (UV)
uniform sampler2D uStamp;
uniform vec4 uStampRect; // прямоугольник даты (пиксели кадра этого масштаба)
uniform vec3 uStampCol;  // экспозиция светодиода по слоям
void main() {
  vec3 rgb = max(texture(uSrc, uSrcRect.xy + vUV * uSrcRect.zw).rgb, 0.0);
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  if (uBoost > 0.0) rgb *= exp2(uBoost * smoothstep(0.75, 1.0, mx));
  vec3 xyz = uIn * rgb;
  float b = xyz.x + xyz.y + xyz.z;
  vec3 raw = vec3(0.0);
  if (b > 1e-9) {
    vec2 xy = xyz.xy / b;
    float qx = clamp((1.0 - xy.x) * (1.0 - xy.x), 0.0, 1.0);
    float qy = clamp(xy.y / max(1.0 - xy.x, 1e-6), 0.0, 1.0);
    vec2 uv = (vec2(qy, qx) * (uTcN - 1.0) + 0.5) / uTcN;
    raw = max(texture(uTc, uv).rgb, 0.0) * b;
  }
  // виньетирование объектива (cos^4 + мягкий край)
  vec2 p = (uGeo.xy + vUV * uSize) / uGeo.zw - 0.5;
  p.x *= uGeo.z / uGeo.w;
  float r = length(p) / (0.5 * length(vec2(uGeo.z / uGeo.w, 1.0)));
  float vig = 1.0 - uVig.x * smoothstep(uVig.y - uVig.z, uVig.y + uVig.z, r);
  raw *= uExp * vig;
  if (uStampRect.z > 0.0) {
    vec2 sp = (uGeo.xy + vUV * uSize - uStampRect.xy) / uStampRect.zw;
    if (sp.x >= 0.0 && sp.y >= 0.0 && sp.x <= 1.0 && sp.y <= 1.0) raw += uStampCol * texture(uStamp, sp).r;
  }
  outColor = vec4(raw, 1.0);
}`;

// Уменьшение вдвое (усреднение 2x2 через линейную фильтрацию)
export const DOWN = HEAD + `
uniform sampler2D uTex;
void main() { outColor = texture(uTex, vUV); }`;

// Раздельное гауссово размытие
export const BLUR = HEAD + `
uniform sampler2D uTex;
uniform vec2 uDir;    // шаг в UV
uniform float uSigma; // в пикселях текущего уровня
void main() {
  if (uSigma < 0.2) { outColor = texture(uTex, vUV); return; }
  int R = int(min(ceil(uSigma * 3.0), 40.0));
  float inv = -0.5 / (uSigma * uSigma);
  vec4 acc = texture(uTex, vUV);
  float wsum = 1.0;
  // парные выборки с линейной интерполяцией: вдвое меньше обращений
  for (int i = 1; i <= 40; i += 2) {
    if (i > R) break;
    float w1 = exp(float(i * i) * inv), w2 = exp(float((i + 1) * (i + 1)) * inv);
    float w = w1 + w2;
    float o = (float(i) * w1 + float(i + 1) * w2) / w;
    acc += w * (texture(uTex, vUV + uDir * o) + texture(uTex, vUV - uDir * o));
    wsum += 2.0 * w;
  }
  outColor = acc / wsum;
}`;

// 2. Рассеяние в эмульсии и ореол (халяция)
export const HALATION = HEAD + `
uniform sampler2D uE0;
uniform sampler2D uCore;   // G(sigma_core)
uniform sampler2D uTail1;  // хвост: смесь гауссиан
uniform sampler2D uTail2;
uniform sampler2D uH1;     // ореол: G(sigma_h * sqrt(k)), k=1..3
uniform sampler2D uH2;
uniform sampler2D uH3;
uniform vec3 uScatter;     // доля рассеянного света
uniform vec3 uTailW;       // вес экспоненциального хвоста
uniform vec3 uHal;         // сила ореола по каналам
uniform vec3 uHW;          // веса отражений
uniform vec4 uGRect;       // где брать крупные размытия (UV глобальной текстуры)
void main() {
  vec2 g = uGRect.xy + vUV * uGRect.zw;
  vec3 e0 = texture(uE0, vUV).rgb;
  vec3 tail = 0.35 * texture(uTail1, vUV).rgb + 0.65 * texture(uTail2, vUV).rgb;
  vec3 sc = (1.0 - uTailW) * texture(uCore, vUV).rgb + uTailW * tail;
  vec3 e1 = (1.0 - uScatter) * e0 + uScatter * sc;
  vec3 h = uHW.x * texture(uH1, g).rgb + uHW.y * texture(uH2, g).rgb + uHW.z * texture(uH3, g).rgb;
  vec3 e2 = (e1 + uHal * h) / (1.0 + uHal);
  outColor = vec4(e2, 1.0);
}`;

// 3. Первичная проявка: плотность и выделение ингибиторов DIR
export const DEVELOP1 = HEAD + `
uniform sampler2D uE;
uniform float uCurveRows;
uniform float uShift;
uniform mat3 uM;          // строки — источник, столбцы — получатель
uniform vec3 uDmax;
uniform float uPositive;
${CURVE}
void main() {
  vec3 e = max(texture(uE, vUV).rgb, 1e-10);
  vec3 le = log(e) / log(10.0) + uShift;
  vec3 d = curve3(le, 0.0);
  vec3 silver = mix(d, uDmax - d, uPositive);
  // corr_m = sum_j silver_j * M[j][m]  (uM загружена построчно -> uM * v даёт сумму по столбцам строки;
  // нам нужна транспонированная свёртка)
  vec3 corr = transpose(uM) * silver;
  outColor = vec4(corr, 1.0);
}`;

// 4. Окончательная проявка: DIR-поправка + зерно
export const DEVELOP2 = HEAD + `
uniform sampler2D uE;
uniform sampler2D uCorrG;  // поправка, размытая гауссом
uniform sampler2D uCorrT1; // хвост диффузии (смесь гауссиан)
uniform sampler2D uCorrT2;
uniform sampler2D uGrain;  // sqrt(g(d)) по каналам, d нормирована на dmax
uniform float uCurveRows;
uniform float uShift;
uniform vec3 uDmax;
uniform float uTailW;
uniform float uGrainAmt;   // множитель / sqrt(площадь пикселя)
uniform float uGrainSigma; // размытие зерна в пикселях
uniform float uMono;       // 1 = ч/б: одно зерно на все каналы
uniform float uCorr;       // связь зерна между слоями (облака красителя перекрываются)
uniform vec4 uGeo;         // смещение тайла и размер кадра
uniform vec2 uSize;
uniform float uSeed;
uniform vec4 uGRect;
${CURVE}
${HASH}
vec3 grainNoise(vec2 pix) {
  // гауссово-взвешенная сумма белого шума: зерно с размером uGrainSigma
  uvec2 base = uvec2(pix);
  uint seed = uint(uSeed);
  float s = max(uGrainSigma, 0.3);
  int R = s < 0.9 ? 1 : (s < 1.6 ? 2 : 3);
  float inv = -0.5 / (s * s);
  vec3 acc = vec3(0.0);
  for (int dy = -3; dy <= 3; dy++) {
    if (dy < -R || dy > R) continue;
    for (int dx = -3; dx <= 3; dx++) {
      if (dx < -R || dx > R) continue;
      float w = exp(float(dx * dx + dy * dy) * inv);
      uvec2 q = uvec2(ivec2(base) + ivec2(dx, dy) + ivec2(65536));
      float n0 = nrand(q, seed);
      vec3 n = uMono > 0.5 ? vec3(n0) : vec3(n0, nrand(q, seed + 7u), nrand(q, seed + 13u));
      acc += w * n;
    }
  }
  return acc;
}
void main() {
  vec3 e = max(texture(uE, vUV).rgb, 1e-10);
  vec3 le = log(e) / log(10.0) + uShift;
  vec2 g = uGRect.xy + vUV * uGRect.zw;
  vec3 corr = (1.0 - uTailW) * texture(uCorrG, vUV).rgb
            + uTailW * (0.35 * texture(uCorrT1, g).rgb + 0.65 * texture(uCorrT2, g).rgb);
  vec3 d = curve3(le - corr, 1.0);
  if (uGrainAmt > 0.0) {
    vec2 pix = uGeo.xy + vUV * uSize;
    vec3 n = grainNoise(floor(pix));
    if (uMono < 0.5 && uCorr > 0.0) {
      float sh = (n.r + n.g + n.b) * 0.57735;
      float a = sqrt(1.0 - uCorr), b = sqrt(uCorr);
      n = (a * n + b * sh) / sqrt(1.0 + 2.0 * a * b * 0.57735);
    }
    vec3 u = clamp(d / uDmax, 0.0, 1.0);
    vec3 g = vec3(texture(uGrain, vec2((u.r * 255.0 + 0.5) / 256.0, 0.5)).r,
                  texture(uGrain, vec2((u.g * 255.0 + 0.5) / 256.0, 0.5)).g,
                  texture(uGrain, vec2((u.b * 255.0 + 0.5) / 256.0, 0.5)).b);
    d += n * g * uGrainAmt;
  }
  outColor = vec4(d, 1.0);
}`;

// 5. Печать / просмотр -> линейный RGB вывода
export const FINAL = HEAD + `
uniform sampler2D uD;
uniform sampler3D uEnl;    // плотности негатива -> log10 экспозиции бумаги
uniform sampler3D uView;   // плотности носителя -> log10 XYZ
uniform sampler2D uPaper;  // кривые бумаги (строка 0)
uniform vec3 uFilmLo, uFilmHi;
uniform vec3 uPaperLo, uPaperHi;
uniform vec3 uViewLo, uViewHi;
uniform float uNeg;        // 1 = негатив (печать), 0 = слайд
uniform float uPrintExp;   // log10 экспозиции печати
uniform vec2 uLE;
uniform float uLutN;
uniform vec3 uFlare;       // засветка (XYZ)
uniform float uWhite;
uniform mat3 uOut;
uniform float uSat;        // насыщенность скана
vec3 lut3(sampler3D t, vec3 x, vec3 lo, vec3 hi) {
  vec3 f = clamp((x - lo) / (hi - lo), 0.0, 1.0);
  return texture(t, (f * (uLutN - 1.0) + 0.5) / uLutN).rgb;
}
float paperTex(float x, int ch) {
  float f = clamp((x - uLE.x) / (uLE.y - uLE.x), 0.0, 1.0) * 255.0 + 0.5;
  vec4 v = texture(uPaper, vec2(f / 256.0, 0.5));
  return ch == 0 ? v.r : (ch == 1 ? v.g : v.b);
}
vec3 gamutCompress(vec3 c) {
  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float mn = min(c.r, min(c.g, c.b));
  if (mn < 0.0 && Y > 0.0) c = Y + (c - Y) * (Y / (Y - mn));
  c = max(c, 0.0);
  float mx = max(c.r, max(c.g, c.b));
  if (mx > 1.0) c /= mx; // клип с сохранением тона
  return c;
}
void main() {
  vec3 d = texture(uD, vUV).rgb;
  vec3 m = d;
  if (uNeg > 0.5) {
    vec3 lr = lut3(uEnl, d, uFilmLo, uFilmHi) + uPrintExp;
    m = vec3(paperTex(lr.r, 0), paperTex(lr.g, 1), paperTex(lr.b, 2));
  }
  vec3 xyz = pow(vec3(10.0), lut3(uView, m, uViewLo, uViewHi));
  xyz = (xyz + uFlare) * uWhite;
  vec3 rgb = uOut * xyz;
  float Y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = Y + (rgb - Y) * uSat;
  outColor = vec4(gamutCompress(rgb), 1.0);
}`;

// 6. Вывод: резкость скана, кодирование sRGB, эффекты
export const OUTPUT = HEAD + `
uniform sampler2D uRGB;
uniform sampler2D uBlur;
uniform float uSharp;
uniform float uEncode;     // 1 = sRGB-гамма
uniform vec4 uView;        // для показа на экране: смещение и масштаб UV
void main() {
  vec2 uv = uView.xy + vUV * uView.zw;
  vec3 c = texture(uRGB, uv).rgb;
  vec3 b = texture(uBlur, uv).rgb;
  c = max(c + uSharp * (c - b), 0.0);
  if (uEncode > 0.5) {
    c = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Показ исходника «до» (линейный ProPhoto -> sRGB)
export const BEFORE = HEAD + `
uniform sampler2D uSrc;
uniform mat3 uM;
uniform float uExp;
uniform vec4 uView;
void main() {
  vec3 c = max(uM * texture(uSrc, uView.xy + vUV * uView.zw).rgb * uExp, 0.0);
  c = c / (1.0 + c * 0.15);
  c = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
