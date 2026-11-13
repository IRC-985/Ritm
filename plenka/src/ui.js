// Панель настроек: строится из описания, сообщает об изменениях через onChange
import { LENS_FILTERS } from './engine/spectral.js';
import { FORMATS } from './engine/pipeline.js';

export const DEFAULTS = {
  film: 'kodak_kodachrome_64', paper: 'auto',
  exposure: 0, autoExposure: true, warmth: 0, tint: 0, sceneIllum: 'film', lensFilter: 'none',
  format: '35', vignette: 0.15,
  push: 0, couplers: 1, grain: 1, grainSize: 1, grainColor: 0.6, halation: 1, halationSize: 1, scatter: 1, boost: 1,
  printExposure: 0, paperContrast: 1, filterC: 0, filterM: 0, filterY: 0,
  slideView: 'lightbox', sharpen: 0.4, saturation: 1, flare: 1, normWhite: true, outSpace: 'srgb',
  dateStamp: false, dateStyle: 'ymd', stampPower: 1,
  exportFormat: 'jpeg', jpegQuality: 92, exportSize: 'full', highlight: 0,
};

const GROUPS = [
  ['slide', 'Слайды'],
  ['neg', 'Негативы'],
  ['bw', 'Чёрно-белые'],
  ['cine', 'Кино'],
];

const opt = (o) => Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : v.name]);

function sections(stocks, S) {
  const film = stocks[S.film];
  const neg = film && film.type !== 'positive';
  const papers = Object.values(stocks).filter((s) => s.group === 'paper').map((s) => [s.id, s.name]);
  return [
    { id: 'film', title: 'Плёнка', open: true, custom: 'films' },
    {
      id: 'shoot', title: 'Съёмка', open: true, controls: [
        { k: 'exposure', label: 'Экспозиция плёнки', min: -3, max: 3, step: 0.05, unit: ' EV', fmt: 2,
          hint: neg ? 'Негатив: печать компенсирует яркость, меняются плотность и характер' : 'Слайд: как на камере — ярче или темнее' },
        { k: 'autoExposure', label: 'Автоэкспозиция по кадру', type: 'toggle' },
        { k: 'warmth', label: 'Теплее ↔ холоднее', min: -100, max: 100, step: 1, fmt: 0 },
        { k: 'tint', label: 'Зелёный ↔ пурпурный', min: -50, max: 50, step: 1, fmt: 0 },
        { k: 'sceneIllum', label: 'Свет на съёмке', type: 'select', options: [['film', 'Под баланс плёнки'], ['D55', 'Дневной свет'], ['A', 'Лампа накаливания']] },
        { k: 'lensFilter', label: 'Фильтр на объективе', type: 'select', options: opt(LENS_FILTERS) },
        { k: 'format', label: 'Формат плёнки (масштаб зерна и ореола)', type: 'select', options: opt(FORMATS) },
        { k: 'vignette', label: 'Виньетирование объектива', min: 0, max: 1, step: 0.01, fmt: 2 },
      ],
    },
    {
      id: 'dev', title: 'Проявка', controls: [
        { k: 'push', label: 'Пуш / пулл-проявка', min: -1, max: 3, step: 1, unit: ' ст.', fmt: 0 },
        { k: 'couplers', label: 'Межслойные эффекты (цвет, резкость краёв)', min: 0, max: 2, step: 0.05, fmt: 2 },
        { k: 'grain', label: 'Зерно', min: 0, max: 3, step: 0.05, fmt: 2 },
        { k: 'grainSize', label: 'Размер зерна', min: 0.4, max: 3, step: 0.05, fmt: 2 },
        { k: 'grainColor', label: 'Цветность зерна', min: 0, max: 1, step: 0.05, fmt: 2 },
        { k: 'halation', label: 'Ореол (халяция)', min: 0, max: 5, step: 0.05, fmt: 2 },
        { k: 'halationSize', label: 'Размер ореола', min: 0.3, max: 3, step: 0.05, fmt: 2 },
        { k: 'scatter', label: 'Рассеяние света в эмульсии', min: 0, max: 1, step: 0.05, fmt: 2 },
        { k: 'boost', label: 'Яркость пересвеченных источников', min: 0, max: 4, step: 0.1, unit: ' EV', fmt: 1 },
      ],
    },
    neg ? {
      id: 'print', title: 'Печать', open: true, controls: [
        { k: 'paper', label: 'Бумага', type: 'select', options: [['auto', 'Как задумано для плёнки'], ...papers] },
        { k: 'printExposure', label: 'Экспозиция печати', min: -2, max: 2, step: 0.05, unit: ' EV', fmt: 2 },
        { k: 'paperContrast', label: film.bw ? 'Градация бумаги' : 'Контраст бумаги', min: 0.6, max: 1.6, step: 0.01, fmt: 2,
          hint: film.bw ? '0.7 ≈ №0, 1.0 ≈ №2, 1.3 ≈ №4, 1.6 ≈ №5' : '' },
        ...(film.bw ? [] : [
          { k: 'filterY', label: 'Жёлтый фильтр (CC) — синее ↔ желтее', min: -40, max: 40, step: 1, fmt: 0 },
          { k: 'filterM', label: 'Пурпурный фильтр (CC) — зеленее ↔ пурпурнее', min: -40, max: 40, step: 1, fmt: 0 },
          { k: 'filterC', label: 'Голубой фильтр (CC)', min: 0, max: 40, step: 1, fmt: 0 },
        ]),
        { custom: 'neutral' },
      ],
    } : {
      id: 'view', title: 'Просмотр слайда', open: true, controls: [
        { k: 'slideView', label: 'Как смотрим', type: 'select', options: [['lightbox', 'На просвет (лайтбокс 5000K)'], ['projector', 'Проектор (галогенная лампа)']] },
      ],
    },
    {
      id: 'scan', title: 'Скан', controls: [
        { k: 'sharpen', label: 'Резкость сканера', min: 0, max: 2, step: 0.05, fmt: 2 },
        { k: 'saturation', label: 'Насыщенность', min: 0, max: 1.6, step: 0.01, fmt: 2 },
        { k: 'flare', label: 'Вуаль / засветка при просмотре', min: 0, max: 6, step: 0.1, fmt: 1 },
        { k: 'normWhite', label: 'Белое по чистой основе', type: 'toggle' },
        { k: 'outSpace', label: 'Цветовое пространство', type: 'select', options: [['srgb', 'sRGB'], ['p3', 'Display P3 (широкий охват)']] },
      ],
    },
    {
      id: 'fx', title: 'Эффекты', controls: [
        { k: 'dateStamp', label: 'Дата в углу кадра (как у мыльницы)', type: 'toggle' },
        { k: 'dateStyle', label: 'Порядок даты', type: 'select', options: [['ymd', "'98 7 15"], ['dmy', "15 7 '98"]] },
        { k: 'stampPower', label: 'Яркость даты', min: 0.2, max: 3, step: 0.05, fmt: 2 },
      ],
    },
    {
      id: 'save', title: 'Сохранение', controls: [
        { k: 'exportFormat', label: 'Формат', type: 'select', options: [['jpeg', 'JPEG'], ['tiff', 'TIFF 16 бит']] },
        { k: 'jpegQuality', label: 'Качество JPEG', min: 60, max: 100, step: 1, fmt: 0 },
        { k: 'exportSize', label: 'Размер', type: 'select', options: [['full', 'Полный'], ['half', 'Половина (быстрее, меньше памяти)']] },
        { k: 'highlight', label: 'Пересветы RAW', type: 'select', options: [['0', 'Обрезать (нейтрально)'], ['2', 'Смешивать'], ['5', 'Восстанавливать']] },
        { custom: 'reset' },
      ],
    },
  ];
}

export function buildPanel(root, stocks, S, onChange, extras = {}) {
  const openState = buildPanel.openState || (buildPanel.openState = {});
  root.textContent = '';
  for (const sec of sections(stocks, S)) {
    const d = document.createElement('details');
    d.className = 'sec';
    d.open = openState[sec.id] ?? !!sec.open;
    d.addEventListener('toggle', () => { openState[sec.id] = d.open; });
    const sm = document.createElement('summary');
    sm.textContent = sec.title;
    d.appendChild(sm);
    const body = document.createElement('div');
    body.className = 'body';
    d.appendChild(body);
    if (sec.custom === 'films') body.appendChild(filmPicker(stocks, S, onChange));
    for (const c of sec.controls || []) {
      if (c.custom === 'neutral') { if (extras.neutral) body.appendChild(extras.neutral()); continue; }
      if (c.custom === 'reset') {
        const b = document.createElement('button');
        b.className = 'btn small-btn';
        b.textContent = 'Сбросить все настройки';
        b.onclick = () => onChange('__reset', true);
        body.appendChild(b);
        continue;
      }
      body.appendChild(control(c, S, onChange));
    }
    root.appendChild(d);
  }
}

function control(c, S, onChange) {
  const wrap = document.createElement('div');
  if (c.type === 'toggle') {
    wrap.className = 'toggle';
    const l = document.createElement('span');
    l.textContent = c.label;
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = !!S[c.k];
    i.onchange = () => onChange(c.k, i.checked);
    wrap.append(l, i);
    wrap.onclick = (e) => { if (e.target !== i) { i.checked = !i.checked; onChange(c.k, i.checked); } };
    return wrap;
  }
  wrap.className = 'ctl';
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('span');
  l.textContent = c.label;
  row.appendChild(l);
  wrap.appendChild(row);
  if (c.type === 'select') {
    const s = document.createElement('select');
    for (const [v, t] of c.options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      s.appendChild(o);
    }
    s.value = String(S[c.k]);
    s.onchange = () => onChange(c.k, s.value);
    wrap.appendChild(s);
  } else {
    const val = document.createElement('span');
    val.className = 'val';
    const show = (v) => { val.textContent = (+v).toFixed(c.fmt ?? 2) + (c.unit || ''); };
    show(S[c.k]);
    val.title = 'Сбросить';
    row.appendChild(val);
    const r = document.createElement('input');
    r.type = 'range';
    r.min = c.min; r.max = c.max; r.step = c.step;
    r.value = S[c.k];
    r.oninput = () => { show(r.value); onChange(c.k, +r.value, true); };
    r.onchange = () => onChange(c.k, +r.value, false);
    val.onclick = () => { const d = DEFAULTS[c.k]; r.value = d; show(d); onChange(c.k, d, false); };
    wrap.appendChild(r);
  }
  if (c.hint) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = c.hint;
    wrap.appendChild(h);
  }
  return wrap;
}

function filmPicker(stocks, S, onChange) {
  const box = document.createElement('div');
  box.className = 'films';
  for (const [g, title] of GROUPS) {
    const items = Object.values(stocks).filter((s) => s.group === g);
    if (!items.length) continue;
    const t = document.createElement('div');
    t.className = 'fgroup-title';
    t.textContent = title;
    box.appendChild(t);
    const grid = document.createElement('div');
    grid.className = 'fgrid';
    for (const f of items) {
      const b = document.createElement('button');
      b.className = 'film' + (f.id === S.film ? ' on' : '');
      const name = document.createElement('span');
      name.textContent = f.name;
      if (f.approx) {
        const a = document.createElement('span');
        a.className = 'approx';
        a.textContent = ' ≈';
        a.title = 'Приближение';
        name.appendChild(a);
      }
      const era = document.createElement('small');
      era.textContent = f.era || '';
      b.append(name, era);
      b.onclick = () => onChange('film', f.id);
      grid.appendChild(b);
    }
    box.appendChild(grid);
  }
  const f = stocks[S.film];
  if (f && f.note) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = (f.approx ? '≈ ' : '') + f.note;
    box.appendChild(n);
  }
  return box;
}
