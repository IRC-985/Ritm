// Впечатывание даты, как у «мыльниц» 90-х: семисегментные цифры светодиодом.
// Рисуем маску (белым по чёрному); в конвейере она добавляется к экспозиции плёнки
// оранжево-красным светом — и дальше проходит через ореол, проявку и печать.

const SEG = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd',
  '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', ' ': '', "'": "'",
};

export function stampText(date, style = 'ymd') {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  const m = String(d.getMonth() + 1).padStart(2, ' ');
  const dd = String(d.getDate()).padStart(2, ' ');
  return style === 'dmy' ? `${dd} ${m} '${yy}` : `'${yy} ${m} ${dd}`;
}

export function makeStampCanvas(text) {
  const W = 640, H = 128;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  const dh = 92, dw = 50, th = 9, gap = 4, skew = 0.12;
  let x = 18;
  const y0 = (H - dh) / 2;
  const seg = (name, ox) => {
    // координаты сегментов в «цифре» dw×dh
    const h2 = dh / 2;
    const S = {
      a: [th / 2 + gap, 0, dw - th - 2 * gap, th, 'h'],
      g: [th / 2 + gap, h2 - th / 2, dw - th - 2 * gap, th, 'h'],
      d: [th / 2 + gap, dh - th, dw - th - 2 * gap, th, 'h'],
      f: [0, th / 2 + gap, th, h2 - th - gap, 'v'],
      b: [dw - th, th / 2 + gap, th, h2 - th - gap, 'v'],
      e: [0, h2 + gap / 2, th, h2 - th - gap, 'v'],
      c: [dw - th, h2 + gap / 2, th, h2 - th - gap, 'v'],
    }[name];
    const [sx, sy, sw, sh] = S;
    g.beginPath();
    // наклон вправо, как у LCD/LED часов
    const X = (px, py) => ox + px + (dh - py) * skew;
    const Y = (py) => y0 + py;
    if (S[4] === 'h') {
      g.moveTo(X(sx, sy + sh / 2), Y(sy + sh / 2));
      g.lineTo(X(sx + th / 2, sy), Y(sy));
      g.lineTo(X(sx + sw - th / 2, sy), Y(sy));
      g.lineTo(X(sx + sw, sy + sh / 2), Y(sy + sh / 2));
      g.lineTo(X(sx + sw - th / 2, sy + sh), Y(sy + sh));
      g.lineTo(X(sx + th / 2, sy + sh), Y(sy + sh));
    } else {
      g.moveTo(X(sx + sw / 2, sy), Y(sy));
      g.lineTo(X(sx + sw, sy + th / 2), Y(sy + th / 2));
      g.lineTo(X(sx + sw, sy + sh - th / 2), Y(sy + sh - th / 2));
      g.lineTo(X(sx + sw / 2, sy + sh), Y(sy + sh));
      g.lineTo(X(sx, sy + sh - th / 2), Y(sy + sh - th / 2));
      g.lineTo(X(sx, sy + th / 2), Y(sy + th / 2));
    }
    g.closePath();
    g.fill();
  };
  for (const ch of text) {
    if (ch === "'") {
      g.beginPath();
      const X = x + 8 + dh * skew;
      g.moveTo(X, y0); g.lineTo(X + th, y0); g.lineTo(X + 2, y0 + 24); g.lineTo(X - 3, y0 + 24); g.closePath(); g.fill();
      x += 22;
      continue;
    }
    if (ch === ' ') { x += 26; continue; }
    for (const s of SEG[ch] || '') seg(s, x);
    x += dw + 16;
  }
  return { canvas: c, w: W, h: H, used: Math.min(W, x + 20) };
}
