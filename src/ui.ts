// UI iframe: has DOM + canvas. Decodes the selected image (or generates a random
// figure), downsamples to a grid, builds the pill/dot shape list, renders the live
// preview, and on "Gerar" hands the shapes to the main thread as editable vectors.
import type { Shape, MainToUi } from "./shared";

const WARN_COUNT = 20000;
const ALPHA_CUTOFF = 32;
const MAX_OUTPUT = 1500; // longest side of the generated result, in px

type DissolveDir = "top" | "bottom" | "left" | "right";
type Params = {
  cols: number;
  threshold: number;
  dotSize: number; // dot size (square cell); also the mark height/thickness
  widthAmt: number; // 0..100: how much of each pill's length is kept (100 = full pill)
  gap: number;
  invert: boolean;
  roundness: number; // 0 = square corners, 100 = fully round (capsule/circle)
  dissolve: number; // 0..100: how strongly cells scatter toward the dissolving edge
  reach: number; // 0..100: how far the dissolve gradient reaches into the figure
  dissolveDir: DissolveDir;
  dither: boolean; // "Print" mode: 1-bit Floyd–Steinberg dithering instead of threshold
  contrast: number; // 0..100: contrast applied before dithering
  modular: boolean; // render ON cells as one connected blob, rounding only exposed corners
};

// --- state ---
let mode: "image" | "random" = "image";
let bitmap: ImageBitmap | null = null;
let imgW = 0;
let imgH = 0;
let lum: Uint8ClampedArray | null = null;
let alphaArr: Uint8ClampedArray | null = null;
let gridCols = 0;
let gridRows = 0;
let maskMode: "alpha" | "luma" = "luma";
type RandomStyle = "cloud" | "burst" | "dust" | "mirror";
let randomStyle: RandomStyle = "cloud";
let randomSeed = 1;
let dissolveDir: DissolveDir = "top";
let imgStyle: "dots" | "print" = "dots"; // "print" = high-contrast dithered (1-bit) look
const STYLE_FILL: Record<RandomStyle, number> = { cloud: 145, burst: 155, dust: 100, mirror: 145 };
let lastShapes: Shape[] = [];
let lastCanvas = { w: 0, h: 0 };
// preview navigation: zoom (>=1) and pan offset in screen px
let zoom = 1;
let panX = 0;
let panY = 0;

// --- dom ---
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const estimateEl = $("estimate");
const genBtn = $<HTMLButtonElement>("generate");
const preview = $<HTMLCanvasElement>("preview");
const pctx = preview.getContext("2d")!;
const progress = $("progress");
const progressBar = $("progress-bar");
const lblThreshold = $("lbl-threshold");

// --- i18n (English default, Portuguese toggle) ---
type Lang = "en" | "pt";
let lang: Lang = "en";
type StatusState =
  | { kind: "idle" }
  | { kind: "image"; name: string; w: number; h: number; mask: "alpha" | "luma" }
  | { kind: "random"; style: RandomStyle }
  | { kind: "error" };
let statusState: StatusState = { kind: "idle" };

const STR = {
  en: {
    density: "Density", dotSize: "Dot size", dotWidth: "Dot width", spacing: "Spacing",
    corners: "Corners", dissolve: "Dissolve", reach: "Reach", contrast: "Contrast",
    fill: "Fill", threshold: "Threshold", invert: "Invert", modular: "Modular", generate: "Generate", close: "Close",
    cloud: "Cloud", burst: "Explosion", dust: "Dust", mirror: "Symmetric",
    modeDots: "Dots", modePrint: "Print", modeRandom: "Random",
    idle: "Select an image, or tap the smiley 🙂", imgWord: "Image",
    silhouette: "silhouette mode", luminance: "luminance mode", randomWord: "Random",
    decodeErr: "Couldn't decode the image.", shapes: "shapes", output: "output",
    tooMany: " — lots of nodes, lower the density",
    expand: "Expand preview", collapse: "Collapse preview", reroll: "Generate random shape",
    resize: "Drag to resize", langTitle: "Mudar para português", about: "About",
    role: "Product Designer",
    blurb: "dot dot dot is a free, personal project by Yago Bispo. If it helped you, come say hi.",
    portfolio: "Portfolio", instagram: "Instagram", threads: "Threads",
    previewHint: "Scroll to zoom · drag to pan · double-click to reset",
  },
  pt: {
    density: "Densidade", dotSize: "Tamanho do dot", dotWidth: "Largura do dot", spacing: "Espaçamento",
    corners: "Cantos", dissolve: "Dissolver", reach: "Alcance", contrast: "Contraste",
    fill: "Preenchimento", threshold: "Threshold", invert: "Inverter", modular: "Modular", generate: "Gerar", close: "Fechar",
    cloud: "Nuvem", burst: "Explosão", dust: "Poeira", mirror: "Simétrico",
    modeDots: "Pontos", modePrint: "Print", modeRandom: "Aleatório",
    idle: "Selecione uma imagem, ou clique na carinha 🙂", imgWord: "Imagem",
    silhouette: "modo silhueta", luminance: "modo luminância", randomWord: "Aleatório",
    decodeErr: "Não foi possível decodificar a imagem.", shapes: "formas", output: "saída",
    tooMany: " — muitos nós, baixe a densidade",
    expand: "Expandir visualização", collapse: "Recolher visualização", reroll: "Gerar forma aleatória",
    resize: "Arraste para redimensionar", langTitle: "Switch to English", about: "Sobre",
    role: "Product Designer",
    blurb: "o dot dot dot é um projeto pessoal e gratuito do Yago Bispo. Se te ajudou, vem trocar ideia.",
    portfolio: "Portfólio", instagram: "Instagram", threads: "Threads",
    previewHint: "Scroll: zoom · arraste: mover · duplo-clique: resetar",
  },
} as const;
function t(k: keyof (typeof STR)["en"]): string {
  return STR[lang][k];
}

function renderStatus() {
  const s = statusState;
  if (s.kind === "image")
    statusEl.textContent = `${t("imgWord")}: ${s.name} (${s.w}×${s.h}) · ${s.mask === "alpha" ? t("silhouette") : t("luminance")}`;
  else if (s.kind === "random") statusEl.textContent = `${t("randomWord")} · ${t(s.style)}`;
  else if (s.kind === "error") statusEl.textContent = t("decodeErr");
  else statusEl.textContent = t("idle");
}

function applyLang() {
  const q = (sel: string) => document.querySelector(sel) as HTMLElement;
  q("#s-density .slabel span").textContent = t("density");
  q("#s-dot .slabel span").textContent = t("dotSize");
  q("#s-width .slabel span").textContent = t("dotWidth");
  q("#s-gap .slabel span").textContent = t("spacing");
  q("#s-round .slabel span").textContent = t("corners");
  q("#s-dissolve .slabel span").textContent = t("dissolve");
  q("#s-reach .slabel span").textContent = t("reach");
  q("#chk-invert > span:first-child").textContent = t("invert");
  q("#chk-modular > span:first-child").textContent = t("modular");
  genBtn.textContent = t("generate");
  $("close").textContent = t("close");
  q('#rstyle .seg[data-style="cloud"]').textContent = t("cloud");
  q('#rstyle .seg[data-style="burst"]').textContent = t("burst");
  q('#rstyle .seg[data-style="dust"]').textContent = t("dust");
  q('#rstyle .seg[data-style="mirror"]').textContent = t("mirror");
  q('#modebar .seg[data-mode="dots"]').textContent = t("modeDots");
  q('#modebar .seg[data-mode="print"]').textContent = t("modePrint");
  q('#modebar .seg[data-mode="random"]').textContent = t("modeRandom");
  q("#s-contrast .slabel span").textContent = t("contrast");
  lblThreshold.textContent = mode === "random" ? t("fill") : t("threshold");
  $("smiley").title = t("reroll");
  $("expand").title = expanded ? t("collapse") : t("expand");
  $("resize").title = t("resize");
  preview.title = t("previewHint");
  const langBtn = $("lang");
  langBtn.title = t("langTitle");
  langBtn.textContent = lang.toUpperCase();
  $("about").title = t("about");
  $("about-role").textContent = t("role");
  $("about-blurb").textContent = t("blurb");
  $("lnk-portfolio").textContent = t("portfolio");
  $("lnk-instagram").textContent = t("instagram");
  $("lnk-threads").textContent = t("threads");
  renderStatus();
  recompute(false); // rebuild the estimate text in the new language immediately
}

// --- custom sliders (pointer-captured so dragging works outside the track) ---
type Slider = { value: number; min: number; max: number };
const sliders: Record<string, Slider> = {};

function initSlider(id: string, onInput: (resample: boolean) => void, resampleOnChange: boolean) {
  const el = $(id);
  const track = el.querySelector(".track") as HTMLElement;
  const fill = el.querySelector(".fill") as HTMLElement;
  const thumb = el.querySelector(".thumb") as HTMLElement;
  const valEl = el.querySelector(".sval") as HTMLElement;
  const min = Number(el.dataset.min);
  const max = Number(el.dataset.max);
  const s: Slider = { value: Number(el.dataset.value), min, max };
  sliders[id] = s;

  const paint = () => {
    const t = (s.value - min) / (max - min);
    fill.style.width = `${t * 100}%`;
    thumb.style.left = `${t * 100}%`;
    valEl.textContent = String(s.value);
  };
  const setFromClientX = (clientX: number) => {
    const r = track.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const v = Math.round(min + t * (max - min));
    if (v !== s.value) {
      s.value = v;
      paint();
      onInput(resampleOnChange);
    } else {
      paint();
    }
  };

  track.addEventListener("pointerdown", (e) => {
    track.setPointerCapture(e.pointerId);
    track.classList.add("dragging");
    setFromClientX(e.clientX);
  });
  track.addEventListener("pointermove", (e) => {
    if (track.hasPointerCapture(e.pointerId)) setFromClientX(e.clientX);
  });
  const end = (e: PointerEvent) => {
    if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    track.classList.remove("dragging");
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);

  paint();
}

// --- invert checkbox ---
const invertEl = $("chk-invert");
let invert = false;
invertEl.addEventListener("click", () => {
  invert = !invert;
  invertEl.classList.toggle("on", invert);
  scheduleRecompute(false);
});
function setInvert(v: boolean) {
  invert = v;
  invertEl.classList.toggle("on", v);
}

const modularEl = $("chk-modular");
let modular = false;
modularEl.addEventListener("click", () => {
  modular = !modular;
  modularEl.classList.toggle("on", modular);
  // Modular is per-cell (no run-length merge), so keep the grid chunky and light.
  if (modular && sliders["s-density"].value > 90) setSliderVal("s-density", 60);
  scheduleRecompute(false);
});

function readParams(): Params {
  return {
    cols: sliders["s-density"].value,
    threshold: sliders["s-threshold"].value,
    dotSize: sliders["s-dot"].value,
    // "Largura do dot" only applies to random; image mode always keeps full pills
    widthAmt: mode === "random" ? sliders["s-width"].value : 100,
    gap: sliders["s-gap"].value,
    invert,
    roundness: sliders["s-round"].value,
    dissolve: sliders["s-dissolve"].value,
    reach: sliders["s-reach"].value,
    dissolveDir,
    dither: mode === "image" && imgStyle === "print",
    contrast: sliders["s-contrast"].value,
    modular: mode === "random" && modular, // Modular is random-only (never on images)
  };
}
function setThreshold(v: number) {
  sliders["s-threshold"].value = v;
  const el = $("s-threshold");
  const t = (v - sliders["s-threshold"].min) / (sliders["s-threshold"].max - sliders["s-threshold"].min);
  (el.querySelector(".fill") as HTMLElement).style.width = `${t * 100}%`;
  (el.querySelector(".thumb") as HTMLElement).style.left = `${t * 100}%`;
  (el.querySelector(".sval") as HTMLElement).textContent = String(v);
}

// --- image sampling ---
function sampleGrid(cols: number) {
  if (!bitmap) return;
  const rows = Math.max(1, Math.round(cols * (imgH / imgW)));
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bitmap, 0, 0, cols, rows);
  const data = ctx.getImageData(0, 0, cols, rows).data;
  const outL = new Uint8ClampedArray(cols * rows);
  const outA = new Uint8ClampedArray(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    outL[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0;
    outA[i] = data[i * 4 + 3];
  }
  lum = outL;
  alphaArr = outA;
  gridCols = cols;
  gridRows = rows;
}

function transparentFraction(): number {
  if (!alphaArr) return 0;
  let t = 0;
  for (let i = 0; i < alphaArr.length; i++) if (alphaArr[i] < ALPHA_CUTOFF) t++;
  return t / alphaArr.length;
}

// --- random figure generation ---
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function previewAspect(): number {
  const w = preview.clientWidth || 1;
  const h = preview.clientHeight || 1;
  return h / w;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Floyd–Steinberg dithering -> 1-bit grid (0 or 255), for the "Print" high-contrast look.
function ditherGrid(src: Uint8ClampedArray, cols: number, rows: number, threshold: number, contrast: number): Uint8ClampedArray {
  const cf = 1 + (contrast / 100) * 2; // contrast factor 1..3
  const buf = new Float32Array(cols * rows);
  for (let i = 0; i < buf.length; i++) buf[i] = (src[i] - 128) * cf + 128;
  const out = new Uint8ClampedArray(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const old = buf[i];
      const nw = old < threshold ? 0 : 255;
      out[i] = nw;
      const err = old - nw;
      if (x + 1 < cols) buf[i + 1] += (err * 7) / 16;
      if (y + 1 < rows) {
        if (x > 0) buf[i + cols - 1] += (err * 3) / 16;
        buf[i + cols] += (err * 5) / 16;
        if (x + 1 < cols) buf[i + cols + 1] += (err * 1) / 16;
      }
    }
  }
  return out;
}

// Stable per-cell pseudo-random in [0,1), used to scatter cells for the dissolve effect.
function hash2(c: number, r: number, seed: number): number {
  let h = (Math.imul(c, 374761393) + Math.imul(r, 668265263) + Math.imul(seed, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function sampleBilinear(g: Float32Array, w: number, h: number, u: number, v: number): number {
  const fx = Math.min(w - 1, Math.max(0, u * (w - 1)));
  const fy = Math.min(h - 1, Math.max(0, v * (h - 1)));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = g[y0 * w + x0];
  const b = g[y0 * w + x1];
  const c = g[y1 * w + x0];
  const d = g[y1 * w + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

function noiseGrid(w: number, h: number, rnd: () => number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return g;
}

// Genuinely random, organic cloud: fractal (fBm) noise thresholded, so dense regions
// become pill runs and sparse edges break into scattered single dots. A random
// large-scale "envelope" makes some areas dense and others sparse (never symmetric),
// with a soft vignette so it fades naturally instead of looking like a cropped square.
// `mirror` folds the coordinates for 4-fold (kaleidoscopic) symmetry.
function genFBM(cols: number, rows: number, rnd: () => number, mirror: boolean): Uint8ClampedArray {
  const octaves = [
    { d: 12, amp: 0.28 },
    { d: 6, amp: 0.24 },
    { d: 3, amp: 0.2 },
    { d: 1.7, amp: 0.16 },
    { d: 1, amp: 0.12 },
  ].map((o) => {
    const gw = Math.max(2, Math.round(cols / o.d));
    const gh = Math.max(2, Math.round(rows / o.d));
    return { gw, gh, amp: o.amp, g: noiseGrid(gw, gh, rnd) };
  });
  const ampSum = octaves.reduce((s, o) => s + o.amp, 0);
  const egW = Math.max(2, Math.round(cols / 20));
  const egH = Math.max(2, Math.round(rows / 20));
  const env = noiseGrid(egW, egH, rnd);

  const field = new Float32Array(cols * rows);
  let maxV = 1e-6;
  for (let y = 0; y < rows; y++) {
    const v0 = (y + 0.5) / rows;
    const v = mirror ? 0.5 - Math.abs(v0 - 0.5) : v0;
    for (let x = 0; x < cols; x++) {
      const u0 = (x + 0.5) / cols;
      const u = mirror ? 0.5 - Math.abs(u0 - 0.5) : u0;
      let f = 0;
      for (const o of octaves) f += o.amp * sampleBilinear(o.g, o.gw, o.gh, u, v);
      f /= ampSum;
      const e = 0.25 + 1.15 * sampleBilinear(env, egW, egH, u, v);
      const edge = Math.max(Math.abs(u0 - 0.5), Math.abs(v0 - 0.5)) * 2;
      const vig = 1 - 0.5 * smoothstep(0.5, 1.0, edge);
      const val = f * e * vig;
      field[y * cols + x] = val;
      if (val > maxV) maxV = val;
    }
  }
  const out = new Uint8ClampedArray(cols * rows);
  for (let i = 0; i < field.length; i++) out[i] = ((field[i] / maxV) * 255) | 0;
  return out;
}

// Dense explosion / starburst: bright core with rays that fragment into particles.
function genBurst(cols: number, rows: number, rnd: () => number): Uint8ClampedArray {
  const lowW = Math.max(4, Math.round(cols / 7));
  const lowH = Math.max(4, Math.round(rows / 7));
  const low = noiseGrid(lowW, lowH, rnd);
  const spikes = 7 + Math.floor(rnd() * 9);
  const phase = rnd() * Math.PI * 2;
  const spikeAmt = 0.7 + rnd() * 0.8;
  const cx = 0.5 + (rnd() - 0.5) * 0.06;
  const cy = 0.5 + (rnd() - 0.5) * 0.06;

  const out = new Uint8ClampedArray(cols * rows);
  for (let y = 0; y < rows; y++) {
    const ny = (y + 0.5) / rows - cy;
    for (let x = 0; x < cols; x++) {
      const nx = (x + 0.5) / cols - cx;
      const r = Math.hypot(nx * 2, ny * 2);
      const ang = Math.atan2(ny, nx);
      const core = Math.max(0, 1 - r * 0.8);
      let rayF = 0.5 + 0.5 * Math.sin(ang * spikes + phase);
      rayF = Math.pow(rayF, 1.7);
      const reach = core * (0.5 + spikeAmt * rayF);
      const n = sampleBilinear(low, lowW, lowH, x / cols, y / rows);
      let v = reach * (0.6 + 0.85 * n);
      const e = Math.max(Math.abs(nx), Math.abs(ny)) * 2;
      v *= 1 - smoothstep(0.82, 1.0, e);
      out[y * cols + x] = Math.min(255, v * 300) | 0;
    }
  }
  return out;
}

// Sparse scattered dots ("dust" / starfield): mostly isolated cells across the frame.
function genDust(cols: number, rows: number, rnd: () => number): Uint8ClampedArray {
  const egW = Math.max(2, Math.round(cols / 14));
  const egH = Math.max(2, Math.round(rows / 14));
  const env = noiseGrid(egW, egH, rnd);
  const cell = noiseGrid(cols, rows, rnd);
  const field = new Float32Array(cols * rows);
  let maxV = 1e-6;
  for (let y = 0; y < rows; y++) {
    const v = (y + 0.5) / rows;
    for (let x = 0; x < cols; x++) {
      const u = (x + 0.5) / cols;
      const e = 0.2 + 1.1 * sampleBilinear(env, egW, egH, u, v);
      const val = Math.pow(cell[y * cols + x], 2.4) * e; // power sparsifies -> isolated
      field[y * cols + x] = val;
      if (val > maxV) maxV = val;
    }
  }
  const out = new Uint8ClampedArray(cols * rows);
  for (let i = 0; i < field.length; i++) out[i] = ((field[i] / maxV) * 255) | 0;
  return out;
}

function regenRandom(cols: number) {
  const rows = Math.max(1, Math.round(cols * previewAspect()));
  const rnd = mulberry32(randomSeed);
  let out: Uint8ClampedArray;
  if (randomStyle === "burst") out = genBurst(cols, rows, rnd);
  else if (randomStyle === "dust") out = genDust(cols, rows, rnd);
  else if (randomStyle === "mirror") out = genFBM(cols, rows, rnd, true);
  else out = genFBM(cols, rows, rnd, false); // cloud
  lum = out;
  alphaArr = new Uint8ClampedArray(cols * rows).fill(255);
  gridCols = cols;
  gridRows = rows;
  maskMode = "luma";
}

// --- shape building ---
function buildShapes(p: Params): { shapes: Shape[]; canvasW: number; canvasH: number } {
  const shapes: Shape[] = [];
  if (!lum) return { shapes, canvasW: 0, canvasH: 0 };
  const pitch = p.dotSize + p.gap; // square grid — the mark width never affects the canvas
  const dissolveN = p.dissolve / 100;
  const dStart = Math.min(0.98, 1 - p.reach / 100); // where the dissolve gradient begins
  const dith = p.dither ? ditherGrid(lum, gridCols, gridRows, p.threshold, p.contrast) : null;
  const isOn = (r: number, c: number) => {
    if (r < 0 || c < 0 || r >= gridRows || c >= gridCols) return false;
    const idx = r * gridCols + c;
    let base: boolean;
    if (dith) {
      if (alphaArr![idx] < ALPHA_CUTOFF) return false;
      base = dith[idx] >= 128; // white pixels of the dithered image
    } else if (maskMode === "alpha") {
      base = alphaArr![idx] >= p.threshold;
    } else {
      if (alphaArr![idx] < ALPHA_CUTOFF) return false;
      base = lum![idx] >= p.threshold;
    }
    if (!(p.invert ? !base : base)) return false;
    if (dissolveN > 0) {
      // `a` runs 0 (solid end) → 1 (dissolving edge); cells scatter more as a grows
      const nx = gridCols > 1 ? c / (gridCols - 1) : 0;
      const ny = gridRows > 1 ? r / (gridRows - 1) : 0;
      const a =
        p.dissolveDir === "top" ? 1 - ny : p.dissolveDir === "bottom" ? ny : p.dissolveDir === "left" ? 1 - nx : nx;
      const keepP = 1 - dissolveN * smoothstep(dStart, 1.0, a);
      if (hash2(c, r, randomSeed) > keepP) return false;
    }
    return true;
  };

  const roundN = p.roundness / 100;
  let canvasW: number;
  let canvasH: number;

  if (p.modular) {
    // Each ON cell fills its whole cell so neighbours touch and connect. Round only the
    // corners whose two orthogonal neighbours are both OFF (exposed outer corners).
    const cornerR = (pitch / 2) * roundN;
    for (let r = 0; r < gridRows; r++) {
      for (let c = 0; c < gridCols; c++) {
        if (!isOn(r, c)) continue;
        const up = isOn(r - 1, c);
        const dn = isOn(r + 1, c);
        const lf = isOn(r, c - 1);
        const rt = isOn(r, c + 1);
        // Diagonal neighbours (used both to keep the corner square and to weld across).
        const dBR = isOn(r + 1, c + 1);
        const dBL = isOn(r + 1, c - 1);
        // Round a corner only if it is truly exposed — keep it square when a diagonal
        // neighbour sits at that corner, so diagonally-touching cells connect.
        const tl = !up && !lf && !isOn(r - 1, c - 1) ? cornerR : 0;
        const tr = !up && !rt && !isOn(r - 1, c + 1) ? cornerR : 0;
        const br = !dn && !rt && !dBR ? cornerR : 0;
        const bl = !dn && !lf && !dBL ? cornerR : 0;
        shapes.push({ kind: "pill", x: c * pitch, y: r * pitch, w: pitch, h: pitch, radius: 0, cr: [tl, tr, br, bl] });

        // Weld diagonally-connected cells: a rounded blob at the shared corner whose size
        // grows with the corner radius, so higher "Cantos" merges them more (added once
        // per junction, from the top cell of each diagonal pair via its bottom corners).
        const weld = pitch * roundN * 0.6;
        if (weld > 0.5) {
          const wr = (weld / 2) * roundN;
          if (!dn && !rt && dBR) {
            shapes.push({ kind: "dot", x: (c + 1) * pitch - weld / 2, y: (r + 1) * pitch - weld / 2, w: weld, h: weld, radius: wr });
          }
          if (!dn && !lf && dBL) {
            shapes.push({ kind: "dot", x: c * pitch - weld / 2, y: (r + 1) * pitch - weld / 2, w: weld, h: weld, radius: wr });
          }
        }
      }
    }
    canvasW = Math.max(1, gridCols * pitch);
    canvasH = Math.max(1, gridRows * pitch);
  } else {
    // Pass 1: collect runs and find the longest, so the "Largura" trim can be scaled to it.
    const runs: { r: number; c: number; len: number }[] = [];
    let maxLen = 1;
    for (let r = 0; r < gridRows; r++) {
      let c = 0;
      while (c < gridCols) {
        if (!isOn(r, c)) {
          c++;
          continue;
        }
        let len = 1;
        while (c + len < gridCols && isOn(r, c + len)) len++;
        runs.push({ r, c, len });
        if (len > maxLen) maxLen = len;
        c += len;
      }
    }

    // Trim scaled to the longest pill: at 0 the longest reaches the 1:1 floor, and shorter
    // pills (which need less trim) square off earlier — the floor clamps each individually.
    const maxNatural = maxLen * pitch - p.gap;
    const trim = ((100 - p.widthAmt) / 100) * Math.max(0, maxNatural - p.dotSize);

    // Pass 2: build the marks. Corner radius runs from 0 (square) to min/2 (fully round).
    for (const run of runs) {
      const x = run.c * pitch;
      const y = run.r * pitch;
      if (run.len === 1) {
        shapes.push({ kind: "dot", x, y, w: p.dotSize, h: p.dotSize, radius: (p.dotSize / 2) * roundN });
      } else {
        const natural = run.len * pitch - p.gap;
        const w = Math.max(p.dotSize, natural - trim); // never narrower than 1:1 (square)
        const radius = (Math.min(w, p.dotSize) / 2) * roundN;
        shapes.push({ kind: "pill", x: x + (natural - w) / 2, y, w, h: p.dotSize, radius });
      }
    }
    canvasW = Math.max(1, gridCols * pitch - p.gap);
    canvasH = Math.max(1, gridRows * pitch - p.gap);
  }

  // Cap the output so the longest side never exceeds MAX_OUTPUT px: scale every
  // shape and the canvas by the same factor, preserving proportions.
  const s = MAX_OUTPUT / Math.max(canvasW, canvasH);
  if (s < 1) {
    for (const sh of shapes) {
      sh.x *= s;
      sh.y *= s;
      sh.w *= s;
      sh.h *= s;
      sh.radius *= s;
      if (sh.cr) sh.cr = [sh.cr[0] * s, sh.cr[1] * s, sh.cr[2] * s, sh.cr[3] * s];
    }
    canvasW *= s;
    canvasH *= s;
  }
  return { shapes, canvasW, canvasH };
}

function renderPreview(shapes: Shape[], canvasW: number, canvasH: number) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = preview.clientWidth;
  const cssH = preview.clientHeight;
  preview.width = Math.round(cssW * dpr);
  preview.height = Math.round(cssH * dpr);
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.fillStyle = "#000";
  pctx.fillRect(0, 0, cssW, cssH);
  if (!shapes.length || canvasW === 0) return;

  const fit = Math.min(cssW / canvasW, cssH / canvasH);
  const scale = fit * zoom;
  const offX = (cssW - canvasW * scale) / 2 + panX;
  const offY = (cssH - canvasH * scale) / 2 + panY;
  pctx.fillStyle = "#fff";
  for (const s of shapes) {
    const x = offX + s.x * scale;
    const y = offY + s.y * scale;
    const w = s.w * scale;
    const h = s.h * scale;
    const maxR = Math.min(w, h) / 2;
    pctx.beginPath();
    if (s.cr) {
      const tl = Math.min(s.cr[0] * scale, maxR);
      const tr = Math.min(s.cr[1] * scale, maxR);
      const br = Math.min(s.cr[2] * scale, maxR);
      const bl = Math.min(s.cr[3] * scale, maxR);
      pctx.moveTo(x + tl, y);
      pctx.arcTo(x + w, y, x + w, y + h, tr);
      pctx.arcTo(x + w, y + h, x, y + h, br);
      pctx.arcTo(x, y + h, x, y, bl);
      pctx.arcTo(x, y, x + w, y, tl);
    } else {
      const rad = Math.min(maxR, s.radius * scale);
      pctx.moveTo(x + rad, y);
      pctx.arcTo(x + w, y, x + w, y + h, rad);
      pctx.arcTo(x + w, y + h, x, y + h, rad);
      pctx.arcTo(x, y + h, x, y, rad);
      pctx.arcTo(x, y, x + w, y, rad);
    }
    pctx.closePath();
    pctx.fill();
  }
}

function recompute(forceRegrid: boolean) {
  if (!lum && mode === "image" && !bitmap) return;
  const p = readParams();
  // In random mode the slider reads as "fill amount": higher = more filled, so invert
  // it into the luminance cutoff used by buildShapes.
  if (mode === "random") p.threshold = 255 - p.threshold;
  if (mode === "image" && bitmap && (forceRegrid || gridCols !== p.cols)) sampleGrid(p.cols);
  if (mode === "random" && (forceRegrid || gridCols !== p.cols)) regenRandom(p.cols);

  const { shapes, canvasW, canvasH } = buildShapes(p);
  lastShapes = shapes;
  lastCanvas = { w: canvasW, h: canvasH };
  renderPreview(shapes, canvasW, canvasH);

  const n = shapes.length;
  estimateEl.textContent = `${n.toLocaleString()} ${t("shapes")} • ${t("output")} ${Math.round(canvasW)}×${Math.round(canvasH)} px`;
  estimateEl.classList.toggle("warn", n > WARN_COUNT);
  if (n > WARN_COUNT) estimateEl.textContent += t("tooMany");
  genBtn.disabled = n === 0;
}

let raf = 0;
function scheduleRecompute(forceRegrid: boolean) {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => recompute(forceRegrid));
}

// --- wire sliders ---
initSlider("s-density", scheduleRecompute, true);
initSlider("s-width", scheduleRecompute, false); // random only: width of each dot (px)
initSlider("s-threshold", scheduleRecompute, false);
initSlider("s-dot", scheduleRecompute, false);
initSlider("s-gap", scheduleRecompute, false);
initSlider("s-round", scheduleRecompute, false);
initSlider("s-reach", scheduleRecompute, false);
initSlider("s-contrast", scheduleRecompute, false);

function setSliderVal(id: string, v: number) {
  const s = sliders[id];
  s.value = v;
  const el = $(id);
  const t2 = (v - s.min) / (s.max - s.min);
  (el.querySelector(".fill") as HTMLElement).style.width = `${t2 * 100}%`;
  (el.querySelector(".thumb") as HTMLElement).style.left = `${t2 * 100}%`;
  (el.querySelector(".sval") as HTMLElement).textContent = String(v);
}
function applyPrintDefaults() {
  setSliderVal("s-density", 150);
  setSliderVal("s-dot", 4);
  setSliderVal("s-gap", 0);
  setSliderVal("s-round", 0);
  setSliderVal("s-contrast", 40);
  setSliderVal("s-threshold", 128);
  setInvert(false);
}
function updateDissolveUI() {
  $("dissolve-extra").classList.toggle("is-hidden", sliders["s-dissolve"].value === 0);
}
initSlider(
  "s-dissolve",
  (resample) => {
    updateDissolveUI();
    scheduleRecompute(resample);
  },
  false
);

document.querySelectorAll<HTMLElement>("#dirbar .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    dissolveDir = (btn.dataset.dir as DissolveDir) || "top";
    document.querySelectorAll<HTMLElement>("#dirbar .seg").forEach((b) => b.classList.toggle("on", b === btn));
    scheduleRecompute(false);
  });
});

// --- random styles ---
const rndbar = $("rndbar");

function applyStyleUI() {
  document.querySelectorAll<HTMLElement>("#rstyle .seg").forEach((b) => {
    b.classList.toggle("on", b.dataset.style === randomStyle);
  });
}

function applyModeUI() {
  const active = mode === "random" ? "random" : imgStyle; // "dots" | "print" | "random"
  document.querySelectorAll<HTMLElement>("#modebar .seg").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === active);
  });
}

// Switch to image mode with a given style, and (re)load the selected Figma image.
function enterImage(style: "dots" | "print") {
  const wasPrint = mode === "image" && imgStyle === "print";
  mode = "image";
  imgStyle = style;
  rndbar.classList.add("hidden");
  $("s-width").classList.add("is-hidden");
  $("chk-modular").classList.add("is-hidden");
  $("s-contrast").classList.toggle("is-hidden", style !== "print");
  if (style === "print" && !wasPrint) applyPrintDefaults();
  applyModeUI();
  lblThreshold.textContent = t("threshold");
  parent.postMessage({ pluginMessage: { type: "request-image" } }, "*");
}

function showRandom(newSeed: boolean, resetFill: boolean) {
  const wasRandom = mode === "random";
  mode = "random";
  rndbar.classList.remove("hidden");
  $("s-width").classList.remove("is-hidden");
  $("chk-modular").classList.remove("is-hidden");
  $("s-contrast").classList.add("is-hidden");
  applyModeUI();
  lblThreshold.textContent = t("fill");
  if (resetFill || !wasRandom) {
    setInvert(false);
    setThreshold(STYLE_FILL[randomStyle]);
  }
  if (newSeed) randomSeed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
  statusState = { kind: "random", style: randomStyle };
  renderStatus();
  regenRandom(readParams().cols);
  recompute(false);
}

$("smiley").addEventListener("click", () => showRandom(true, false));

document.querySelectorAll<HTMLElement>("#modebar .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    const m = btn.dataset.mode;
    if (m === "random") showRandom(false, false); // keep the current figure
    else enterImage(m === "print" ? "print" : "dots");
  });
});

document.querySelectorAll<HTMLElement>("#rstyle .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    randomStyle = (btn.dataset.style as RandomStyle) || "cloud";
    applyStyleUI();
    showRandom(false, true); // keep same figure, switch style, reset fill to that style's default
  });
});

// --- expand: grow the window and give the extra space to the preview ---
const appEl = $("app");
const expandBtn = $("expand");
let expanded = false;
function applyWindowSize(w: number, h: number) {
  document.body.style.width = `${w}px`;
  document.body.style.height = `${h}px`;
  parent.postMessage({ pluginMessage: { type: "resize", width: w, height: h } }, "*");
  requestAnimationFrame(() => scheduleRecompute(false)); // redraw preview at new size
}
expandBtn.addEventListener("click", () => {
  expanded = !expanded;
  appEl.classList.toggle("expanded", expanded);
  expandBtn.classList.toggle("on", expanded);
  expandBtn.title = expanded ? t("collapse") : t("expand");
  applyWindowSize(expanded ? 960 : 360, expanded ? 720 : 680);
});

// --- image received from main thread ---
async function onImage(bytes: Uint8Array, name: string) {
  try {
    bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart]));
    imgW = bitmap.width;
    imgH = bitmap.height;
    mode = "image";
    rndbar.classList.add("hidden");
    $("s-width").classList.add("is-hidden");
    gridCols = 0;
    lblThreshold.textContent = t("threshold");
    sampleGrid(readParams().cols);
    const transp = transparentFraction();
    setInvert(false);
    if (transp > 0.12) {
      maskMode = "alpha";
      setThreshold(40);
    } else {
      maskMode = "luma";
      setThreshold(128);
    }
    applyModeUI();
    statusState = { kind: "image", name, w: imgW, h: imgH, mask: maskMode };
    renderStatus();
    recompute(false);
  } catch {
    statusState = { kind: "error" };
    renderStatus();
    bitmap = null;
    if (mode === "image") genBtn.disabled = true;
  }
}

// --- generate / close ---
genBtn.addEventListener("click", () => {
  if (!lastShapes.length) return;
  genBtn.disabled = true;
  progress.classList.remove("hidden");
  progressBar.style.width = "0%";
  parent.postMessage(
    { pluginMessage: { type: "generate", shapes: lastShapes, canvasW: lastCanvas.w, canvasH: lastCanvas.h } },
    "*"
  );
});
$("close").addEventListener("click", () => {
  parent.postMessage({ pluginMessage: { type: "cancel" } }, "*");
});

// --- resize handle ---
const resizeEl = $("resize");
resizeEl.addEventListener("pointerdown", (e) => {
  resizeEl.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = document.documentElement.clientWidth;
  const startH = document.documentElement.clientHeight;
  const move = (ev: PointerEvent) => {
    const w = Math.min(1000, Math.max(320, startW + (ev.clientX - startX)));
    const h = Math.min(1000, Math.max(420, startH + (ev.clientY - startY)));
    document.body.style.width = `${w}px`;
    document.body.style.height = `${h}px`;
    parent.postMessage({ pluginMessage: { type: "resize", width: w, height: h } }, "*");
    scheduleRecompute(false); // reflow preview at new size
  };
  const up = (ev: PointerEvent) => {
    resizeEl.releasePointerCapture(ev.pointerId);
    resizeEl.removeEventListener("pointermove", move);
    resizeEl.removeEventListener("pointerup", up);
  };
  resizeEl.addEventListener("pointermove", move);
  resizeEl.addEventListener("pointerup", up);
});

// --- messages from main ---
window.onmessage = (event: MessageEvent) => {
  const msg = event.data.pluginMessage as MainToUi | undefined;
  if (!msg) return;
  if (msg.type === "image") {
    if (mode === "random") return; // stay in Random unless the user picked the Image tab
    onImage(msg.bytes, msg.name);
  } else if (msg.type === "no-image") {
    if (mode === "random") return; // keep the random figure on screen
    bitmap = null;
    lastShapes = [];
    genBtn.disabled = true;
    statusState = { kind: "idle" };
    renderStatus();
    estimateEl.textContent = "—";
    renderPreview([], 0, 0);
  } else if (msg.type === "progress") {
    progressBar.style.width = `${Math.round((msg.done / msg.total) * 100)}%`;
  } else if (msg.type === "generated") {
    progress.classList.add("hidden");
    genBtn.disabled = false;
  }
};

// --- language toggle + About panel ---
$("lang").addEventListener("click", () => {
  lang = lang === "en" ? "pt" : "en";
  applyLang();
});
const aboutOverlay = $("aboutOverlay");
$("about").addEventListener("click", () => aboutOverlay.classList.remove("hidden"));
$("aboutClose").addEventListener("click", () => aboutOverlay.classList.add("hidden"));
aboutOverlay.addEventListener("click", (e) => {
  if (e.target === aboutOverlay) aboutOverlay.classList.add("hidden");
});

// --- preview zoom & pan ---
function redraw() {
  renderPreview(lastShapes, lastCanvas.w, lastCanvas.h);
}
preview.addEventListener(
  "wheel",
  (e) => {
    if (!lastShapes.length) return;
    e.preventDefault();
    const rect = preview.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cw = lastCanvas.w || 1;
    const ch = lastCanvas.h || 1;
    const cssW = preview.clientWidth;
    const cssH = preview.clientHeight;
    const fit = Math.min(cssW / cw, cssH / ch);
    const oldScale = fit * zoom;
    const offX = (cssW - cw * oldScale) / 2 + panX;
    const offY = (cssH - ch * oldScale) / 2 + panY;
    const wx = (mx - offX) / oldScale; // world point under the cursor (stays fixed)
    const wy = (my - offY) / oldScale;
    zoom = Math.min(16, Math.max(1, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const newScale = fit * zoom;
    panX = mx - wx * newScale - (cssW - cw * newScale) / 2;
    panY = my - wy * newScale - (cssH - ch * newScale) / 2;
    if (zoom <= 1) {
      zoom = 1;
      panX = 0;
      panY = 0;
    }
    preview.style.cursor = zoom > 1 ? "grab" : "";
    redraw();
  },
  { passive: false }
);
let dragging = false;
let dragMx = 0;
let dragMy = 0;
preview.addEventListener("pointerdown", (e) => {
  if (zoom <= 1) return;
  dragging = true;
  preview.setPointerCapture(e.pointerId);
  dragMx = e.clientX;
  dragMy = e.clientY;
  preview.style.cursor = "grabbing";
});
preview.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  panX += e.clientX - dragMx;
  panY += e.clientY - dragMy;
  dragMx = e.clientX;
  dragMy = e.clientY;
  redraw();
});
const endPreviewDrag = (e: PointerEvent) => {
  if (!dragging) return;
  dragging = false;
  preview.releasePointerCapture(e.pointerId);
  preview.style.cursor = zoom > 1 ? "grab" : "";
};
preview.addEventListener("pointerup", endPreviewDrag);
preview.addEventListener("pointercancel", endPreviewDrag);
preview.addEventListener("dblclick", () => {
  zoom = 1;
  panX = 0;
  panY = 0;
  preview.style.cursor = "";
  redraw();
});

applyModeUI();
applyLang(); // sets all labels/status for the default language
