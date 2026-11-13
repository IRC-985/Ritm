"""
Подготовка данных плёнок для приложения «Плёнка».

Читает профили spektrafilm (CC BY-SA 4.0, Andrea Volpato) как данные и пишет
компактные файлы в public/data/:
  common.json      — длины волн, функции цветового соответствия CIE 1931, источники света,
                     фильтр KG3 (тепловой фильтр увеличителя)
  spectra_lut.bin  — таблица восстановления спектра по цветности (float16, N x N x 81)
  stocks.json      — плёнки и бумаги (+ производные и чёрно-белые, построенные здесь)

Запуск:
  python tools/bake.py /путь/к/spektrafilm/src/spektrafilm
Нужны numpy, scipy, colour-science.
"""
import json
import sys
from pathlib import Path

import numpy as np
import colour
from scipy.interpolate import RegularGridInterpolator
from scipy.stats import norm

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / "public" / "data"
OUT.mkdir(parents=True, exist_ok=True)

SHAPE = colour.SpectralShape(380, 780, 5)
WL = SHAPE.wavelengths
LUT_N = 128


def r(a, nd=5):
    """Округление для компактного JSON; NaN -> None."""
    a = np.asarray(a, dtype=float)
    out = np.round(a, nd).tolist()

    def fix(x):
        if isinstance(x, list):
            return [fix(v) for v in x]
        return None if (x is None or (isinstance(x, float) and np.isnan(x))) else x
    return fix(out)


def illum(name):
    sd = colour.SDS_ILLUMINANTS[name].copy().align(SHAPE)
    v = np.asarray(sd.values, float)
    return v / (v.sum() / v.size)


# ---------------------------------------------------------------- common
cmf = colour.MSDS_CMFS["CIE 1931 2 Degree Standard Observer"].copy().align(SHAPE)
kg3 = np.loadtxt(SRC / "data/filters/heat_absorbing/schott/KG3.csv", delimiter=",")
kg3 = kg3[np.unique(kg3[:, 0], return_index=True)[1]]
kg3_t = np.interp(WL, kg3[:, 0], kg3[:, 1])
if kg3_t.max() > 1.5:
    kg3_t = kg3_t / 100.0
k75p = colour.SDS_LIGHT_SOURCES["Kinoton 75P"].copy().align(SHAPE)
k75p_v = np.asarray(k75p.values, float)
k75p_v /= k75p_v.sum() / k75p_v.size

common = {
    "wl": WL.tolist(),
    "cmf": r(np.asarray(cmf.values), 6),
    "illuminants": {k: r(illum(k), 5) for k in ["D50", "D55", "D65", "A"]},
    "K75P": r(k75p_v, 5),
    "KG3": r(kg3_t, 5),
    "lutN": LUT_N,
}
(OUT / "common.json").write_text(json.dumps(common, separators=(",", ":")))

# ---------------------------------------------------------------- spectra LUT
spec = np.load(SRC / "data/luts/spectral_upsampling/irradiance_xy_tc.npy", allow_pickle=False).astype(np.float64)
n0 = spec.shape[0]
g0 = np.linspace(0, 1, n0)
g1 = np.linspace(0, 1, LUT_N)
tx, ty = np.meshgrid(g1, g1, indexing="ij")
pts = np.stack([tx.ravel(), ty.ravel()], -1)
res = np.empty((LUT_N * LUT_N, spec.shape[2]))
for k in range(spec.shape[2]):
    res[:, k] = RegularGridInterpolator((g0, g0), spec[:, :, k], method="cubic")(pts)
res = np.clip(res, 0, None).reshape(LUT_N, LUT_N, -1).astype(np.float16)
res.tofile(OUT / "spectra_lut.bin")

# ---------------------------------------------------------------- stocks
def load(stock):
    return json.loads((SRC / "data/profiles" / f"{stock}.json").read_text())


def pack(prof, overrides=None):
    """Достаёт из профиля только нужное приложению."""
    i, d = prof["info"], prof["data"]
    o = {
        "id": i["stock"],
        "name": i["name"],
        "type": i["type"],
        "support": i["support"],
        "use": i["use"],
        "antihalation": i.get("antihalation"),
        "refIllum": i["reference_illuminant"],
        "viewIllum": i["viewing_illuminant"],
        "targetPrint": i.get("target_print"),
        "logSens": r(np.nan_to_num(np.asarray(d["log_sensitivity"], float), nan=-10.0), 4),
        "window": r(d.get("hanatos2025_adaptation_window_params") or [], 4),
        "channelDensity": r(np.nan_to_num(np.asarray(d["channel_density"], float)), 4),
        "baseDensity": r(np.nan_to_num(np.asarray(d["base_density"], float)), 4),
        "logE": [float(d["log_exposure"][0]), float(d["log_exposure"][-1]), len(d["log_exposure"])],
        "curves": r(d["density_curves"], 4),
        "layers": r(d["density_curves_layers"], 4),
    }
    m = d.get("density_curves_model") or {}
    if m.get("centers"):
        o["model"] = {k: r(m[k], 5) for k in ("centers", "amplitudes", "sigmas")}
    if overrides:
        o.update(overrides)
    return o


def shift_sens(prof, shifts_nm):
    ls = np.asarray(prof["data"]["log_sensitivity"], float)
    out = ls.copy()
    for c, s in enumerate(shifts_nm):
        if s:
            out[:, c] = np.interp(WL - s, WL, ls[:, c])
    prof["data"]["log_sensitivity"] = out.tolist()


def gamma_curves(prof, g):
    """Меняет контраст характеристических кривых вокруг logE=0."""
    d = prof["data"]
    le = np.linspace(d["log_exposure"][0], d["log_exposure"][-1], len(d["log_exposure"]))
    dc = np.asarray(d["density_curves"], float)
    dl = np.asarray(d["density_curves_layers"], float)
    d["density_curves"] = np.stack([np.interp(le / g, le, dc[:, c]) for c in range(3)], -1).tolist()
    d["density_curves_layers"] = np.stack(
        [np.stack([np.interp(le / g, le, dl[:, l, c]) for c in range(3)], -1) for l in range(3)], 1).tolist()


stocks = []
ORIGINAL = [
    # слайды
    ("kodak_kodachrome_64", dict(name="Kodachrome 64", era="1974–2009", grain=0.8, group="slide")),
    ("kodak_ektachrome_100", dict(name="Ektachrome E100", era="2018", grain=0.6, group="slide")),
    ("fujifilm_velvia_100", dict(name="Fuji Velvia 100", era="2003", grain=0.6, group="slide")),
    ("fujifilm_provia_100f", dict(name="Fuji Provia 100F", era="2000", grain=0.55, group="slide")),
    # негативы
    ("kodak_gold_200", dict(name="Kodak Gold 200", era="1988–", grain=0.9, group="neg")),
    ("kodak_ultramax_400", dict(name="Kodak UltraMax 400", era="1990-е", grain=1.3, group="neg")),
    ("fujifilm_c200", dict(name="Fujicolor Superia 200 / C200", era="1990-е", grain=0.9, group="neg")),
    ("fujifilm_xtra_400", dict(name="Fuji Superia X-TRA 400", era="1998–", grain=1.2, group="neg")),
    ("kodak_portra_160", dict(name="Kodak Portra 160", era="1998–", grain=0.5, group="neg")),
    ("kodak_portra_400", dict(name="Kodak Portra 400", era="1998–", grain=1.0, group="neg")),
    ("kodak_portra_800", dict(name="Kodak Portra 800", era="1998–", grain=1.6, group="neg")),
    ("fujifilm_pro_400h", dict(name="Fuji Pro 400H", era="2004", grain=0.9, group="neg")),
    ("kodak_ektar_100", dict(name="Kodak Ektar 100", era="2008", grain=0.4, group="neg")),
    # кино
    ("kodak_vision3_50d", dict(name="Kodak Vision3 50D", era="кино", grain=0.4, group="cine")),
    ("kodak_vision3_250d", dict(name="Kodak Vision3 250D", era="кино", grain=0.8, group="cine")),
    ("kodak_vision3_200t", dict(name="Kodak Vision3 200T", era="кино", grain=0.8, group="cine")),
    ("kodak_vision3_500t", dict(name="Kodak Vision3 500T", era="кино", grain=1.2, group="cine")),
]
for sid, meta in ORIGINAL:
    stocks.append(pack(load(sid), meta))

# Производные плёнки: нет опубликованных данных, строим из ближайших родственников.
DERIVED = [
    ("kodak_kodachrome_25", "kodak_kodachrome_64",
     dict(name="Kodachrome 25", era="1974–2001", grain=0.55, group="slide", approx=True,
          note="На основе данных Kodachrome 64: те же красители K-14, мельче зерно")),
    ("fujifilm_velvia_50", "fujifilm_velvia_100",
     dict(name="Fuji Velvia 50", era="1990", grain=0.7, group="slide", approx=True, couplers=1.45,
          note="На основе Velvia 100: сильнее межслойные эффекты и контраст"), dict(gamma=1.06)),
    ("agfa_ct_precisa_100", "fujifilm_provia_100f",
     dict(name="Agfa CT Precisa 100", era="1990-е", grain=0.8, group="slide", approx=True, couplers=0.8,
          note="Приближение: мягче насыщенность, холоднее синие"), dict(gamma=0.97, shift=(0, -4, 6))),
    ("konica_centuria_400", "fujifilm_xtra_400",
     dict(name="Konica Centuria 400", era="1990-е", grain=1.3, group="neg", approx=True, couplers=0.85,
          note="Приближение на основе Superia 400"), dict(shift=(-4, 5, 0))),
    ("agfa_vista_200", "kodak_gold_200",
     dict(name="Agfa Vista 200", era="1990-е", grain=1.0, group="neg", approx=True, couplers=1.2,
          note="Приближение: насыщенные тёплые красные"), dict(shift=(-6, 0, 0))),
]
for item in DERIVED:
    sid, base, meta = item[0], item[1], item[2]
    mod = item[3] if len(item) > 3 else {}
    p = load(base)
    p["info"]["stock"] = sid
    if "shift" in mod:
        shift_sens(p, mod["shift"])
    if "gamma" in mod:
        gamma_curves(p, mod["gamma"])
    stocks.append(pack(p, meta))

# Бумаги
PAPERS = [
    ("fujifilm_crystal_archive_typeii", "Fuji Crystal Archive (минилаб Frontier)"),
    ("kodak_supra_endura", "Kodak Supra Endura"),
    ("kodak_ultra_endura", "Kodak Ultra Endura"),
    ("kodak_portra_endura", "Kodak Portra Endura"),
    ("kodak_endura_premier", "Kodak Endura Premier"),
    ("kodak_ektacolor_edge", "Kodak Ektacolor Edge"),
    ("kodak_2383", "Kodak 2383 (кинокопия)"),
]
for sid, name in PAPERS:
    stocks.append(pack(load(sid), dict(name=name, group="paper")))


# ---------------------------------------------------------------- чёрно-белые
def cdf_curve(le, A, mu, s):
    layers = np.stack([a * norm.cdf((le - m) / sg) for a, m, sg in zip(A, mu, s)], -1)
    return layers.sum(-1), layers


def gauss(x, m, s):
    return np.exp(-0.5 * ((x - m) / s) ** 2)


LE = np.linspace(-3, 4, 256)


def bw_film(sid, name, era, sens_parts, red_cut, A, mu, s, grain, note):
    sens = sum(a * gauss(WL, m, sg) for a, m, sg in sens_parts)
    sens *= 1.0 / (1.0 + np.exp((WL - red_cut) / 8.0))     # спад в красной области
    sens *= 1.0 / (1.0 + np.exp(-(WL - 375.0) / 8.0))     # стекло/желатин режет УФ
    ls = np.log10(np.clip(sens, 1e-6, None))
    ls = np.stack([ls] * 3, -1)
    dc, layers = cdf_curve(LE, A, mu, s)
    curves = np.stack([dc] * 3, -1)
    lay = np.stack([layers] * 3, -1)  # (256, слой, канал)
    flat = np.full((WL.size, 3), 1.0 / 3.0)
    base = np.full(WL.size, 0.25)
    return {
        "id": sid, "name": name, "type": "negative", "support": "film", "use": "still",
        "antihalation": "strong", "refIllum": "D55", "viewIllum": "D50", "targetPrint": "ilford_mg_fb",
        "logSens": r(ls, 4), "window": [], "channelDensity": r(flat, 4), "baseDensity": r(base, 4),
        "logE": [-3.0, 4.0, 256], "curves": r(curves, 4), "layers": r(lay, 4),
        "bw": True, "era": era, "grain": grain, "group": "bw", "approx": True, "note": note,
    }


BW = [
    bw_film("kodak_trix_400", "Kodak Tri-X 400", "1954–", [(1.0, 440, 45), (0.85, 540, 40), (0.95, 615, 30)], 655,
            [0.55, 0.85, 0.9], [-1.25, 0.15, 1.6], [0.55, 0.75, 0.9], 3.0,
            "Панхром, мягкий длинный носок, крупное зерно"),
    bw_film("ilford_hp5_400", "Ilford HP5 Plus 400", "1989–", [(1.0, 430, 45), (0.8, 545, 40), (0.85, 610, 28)], 650,
            [0.5, 0.85, 0.95], [-1.2, 0.2, 1.7], [0.6, 0.8, 0.95], 3.0,
            "Панхром, ниже контраст, крупное зерно"),
    bw_film("ilford_fp4_125", "Ilford FP4 Plus 125", "1990–", [(1.0, 435, 45), (0.85, 545, 40), (0.85, 610, 28)], 655,
            [0.55, 0.9, 0.95], [-1.15, 0.1, 1.5], [0.5, 0.7, 0.85], 1.4,
            "Классическая среднечувствительная, умеренное зерно"),
    bw_film("kodak_tmax_100", "Kodak T-Max 100", "1986–", [(1.0, 440, 45), (0.9, 545, 40), (1.0, 630, 30)], 680,
            [0.6, 0.95, 1.0], [-1.1, 0.1, 1.4], [0.45, 0.65, 0.8], 0.7,
            "Т-кристаллы: очень мелкое зерно, расширенная красная чувствительность"),
    bw_film("ilford_delta_3200", "Ilford Delta 3200", "1998–", [(1.0, 440, 45), (0.85, 545, 40), (0.95, 620, 30)], 665,
            [0.45, 0.75, 0.7], [-1.3, 0.25, 1.9], [0.65, 0.85, 1.0], 6.0,
            "Сверхчувствительная: низкий контраст, очень крупное зерно"),
]
stocks.extend(BW)

# Ч/б бумага: форма кривой бумаги Crystal Archive (зелёный слой), нейтральные красители.
ca = load("fujifilm_crystal_archive_typeii")
cm = ca["data"]["density_curves_model"]
A = np.asarray(cm["amplitudes"], float)[1]
MU = np.asarray(cm["centers"], float)[1]
SG = np.asarray(cm["sigmas"], float)[1]
A = A * (2.15 / A.sum())
bw_paper_sens = np.log10(np.clip(gauss(WL, 450, 45) + 0.6 * gauss(WL, 525, 25), 1e-6, None))
bw_dc, bw_layers = cdf_curve(LE, A, MU, SG)
stocks.append({
    "id": "ilford_mg_fb", "name": "Ilford Multigrade (ч/б бумага)", "type": "negative", "support": "paper",
    "use": "still", "antihalation": "strong", "refIllum": "TH-KG3", "viewIllum": "D50", "targetPrint": None,
    "logSens": r(np.stack([bw_paper_sens] * 3, -1), 4), "window": [],
    "channelDensity": r(np.full((WL.size, 3), 1.0 / 3.0), 4), "baseDensity": r(np.full(WL.size, 0.04), 4),
    "logE": [-3.0, 4.0, 256], "curves": r(np.stack([bw_dc] * 3, -1), 4),
    "layers": r(np.stack([bw_layers] * 3, -1), 4),
    "model": {"centers": r([MU] * 3), "amplitudes": r([A] * 3), "sigmas": r([SG] * 3)},
    "bw": True, "group": "paper",
})

(OUT / "stocks.json").write_text(json.dumps({
    "license": "Данные плёнок: spektrafilm, Andrea Volpato, CC BY-SA 4.0 "
               "(https://github.com/andreavolpato/spektrafilm). Производные и ч/б профили — "
               "приближения, построенные в этом проекте, распространяются на тех же условиях.",
    "stocks": stocks,
}, separators=(",", ":"), ensure_ascii=False))

for f in OUT.iterdir():
    print(f.name, f.stat().st_size // 1024, "KB")
print(len(stocks), "stocks")
