#!/usr/bin/env node
// Сборка логотипов компаний для клиента: server/public/logos/<TICKER>.svg|png
// и server/public/logos/logos.json (тикер → файл, цвет бренда, источник).
//
//   node tools/logos/build-logos.mjs --si <путь к пакету simple-icons>
//        [--board maps.png] [--out server/public/logos]
//        [--contact contact.html] [--review папка] [--only AAPL,SBER]
//
// Источники (подробности и лицензии — в README.md рядом):
//   «si»    — векторная иконка из пакета simple-icons (CC0), заливка цветом бренда;
//   «svg»   — простая геометрия, нарисованная здесь же (Microsoft, Pepsi, Сбер,
//             четырёхцветная «G» Google поверх контура из simple-icons);
//   «board» — вырезка из фото физического поля maps.png: верх клетки над тикером,
//             бирюзовый фон клетки удаляется в прозрачность.
// Скрипт без npm-зависимостей (PNG декодируется/кодируется через встроенный zlib);
// simple-icons нужен только на время сборки и в проект не ставится.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
// Версия simple-icons, с которой выверены пути и цвета. На другой версии скрипт
// работает, но иконку могли перерисовать или удалить — стоит проверить лист.
const SI_VERSION = "16.35.0";

// ---------------------------------------------------------------------------
// Что откуда берём. Порядок — как COMPANIES в engine.js.
//   si: слаг simple-icons; color — свой цвет вместо hex из simple-icons
//   svg: имя функции-рисовалки из DRAW; color — цвет бренда для logos.json
//   board: [ряд, колонка] клетки на maps.png (ряды 1..12 сверху вниз, колонки
//          12..1 слева направо — как подписано на поле). Клетки выбраны по
//          --review: логотип целиком, без обрезки ободком и подписью.
//          recolor — перекрасить светлые/серые пиксели (белая «a» Amazon на
//          белом фоне не видна); smooth — сгладить шумный контур
// ---------------------------------------------------------------------------
export const LOGOS = {
  AAPL:  { si: "apple" },
  MSFT:  { svg: "microsoft", color: "#00A4EF" },   // в simple-icons удалён
  GOOGL: { svg: "google", color: "#4285F4" },       // контур — simple-icons «google»
  NVDA:  { si: "nvidia" },
  IBM:   { board: [5, 8] },                         // в simple-icons удалён (как и Amazon, Walmart…)
  INTC:  { si: "intel" },
  SONY:  { si: "sony", color: "#000000" },          // в simple-icons hex = FFFFFF
  AMZN:  { board: [8, 10], recolor: { to: "#232F3E" }, smooth: true },
  DIS:   { board: [3, 12] },                        // единственная клетка Disney
  NFLX:  { si: "netflix" },
  META:  { si: "meta" },
  YDEX:  { board: [8, 7] },
  VKCO:  { si: "vk" },
  MCD:   { si: "mcdonalds" },
  NKE:   { si: "nike" },
  KO:    { si: "cocacola" },
  WMT:   { board: [3, 9] },
  PEP:   { svg: "pepsi", color: "#004B93" },        // нет ни в simple-icons, ни на поле
  SBUX:  { si: "starbucks" },
  RKT:   { board: [7, 4] },
  ADS:   { si: "adidas" },
  BA:    { si: "boeing" },
  TSLA:  { si: "tesla" },
  MMM:   { si: "3m" },
  AFLT:  { si: "aeroflot" },
  F:     { si: "ford" },
  V:     { si: "visa" },
  SBER:  { svg: "sber", color: "#21A038" },         // на поле — с 3D-тенью, вырезка грязная
  GAZP:  { board: [4, 10] },
  MGNT:  { board: [4, 6] },
  MTSS:  { board: [3, 1] },
};

// Раскладка физического поля maps.png (ряд 1 сверху; в строке колонки 12..1).
// Нужна, чтобы проверить, что в выбранной клетке нужный тикер, и для --review.
export const BOARD_MAP = [
  "BA MMM AMZN NKE YDEX RKT YDEX KO MTSS MMM AMZN AAPL",
  "MSFT KO AAPL NVDA SBER AAPL GOOGL BA AAPL NKE GOOGL MGNT",
  "DIS MCD IBM WMT GOOGL KO NVDA IBM RKT MSFT NKE MTSS",
  "MGNT MTSS GAZP AFLT VKCO AMZN MGNT NKE SBER WMT NVDA NVDA",
  "GOOGL MMM NVDA AMZN IBM MSFT GOOGL AMZN KO IBM GAZP MGNT",
  "AAPL BA NKE IBM KO BA IBM BA MTSS VKCO SBER GAZP",
  "KO WMT GOOGL MSFT KO AAPL YDEX MSFT RKT AMZN MSFT MCD",
  "GOOGL NVDA AMZN RKT GOOGL YDEX MMM AFLT NKE GOOGL KO AAPL",
  "RKT IBM MMM AAPL MSFT IBM AAPL AMZN MCD MSFT MGNT MCD",
  "BA NVDA VKCO SBER RKT KO NVDA MGNT IBM GAZP BA WMT",
  "MSFT KO SBER IBM AFLT SBER WMT KO GOOGL MCD AFLT GAZP",
  "AAPL YDEX GOOGL NVDA SBER MMM NVDA MCD YDEX MSFT AAPL MCD",
].map((s) => s.split(" "));
const boardTicker = (r, c) => BOARD_MAP[r - 1][12 - c];

const OUT_PNG_MAX = 128;       // максимум стороны вырезки, px
const CELL_INSET = 8;          // светлый ободок клетки у линий сетки
const TEXT_RGB = [6, 78, 70];  // тёмно-бирюзовый цвет подписи тикера на поле
const BG_RGB = [163, 228, 214];// номинальный фон клетки (уточняется по краю вырезки)
const KEY_T0 = 14, KEY_T1 = 60;// порог удаления фона по расстоянию цвета (мягкий край)

// ---------------------------------------------------------------------------
// PNG: декодер (8 бит, RGB/RGBA, без интерлейса, фильтры 0–4) и энкодер RGBA
// ---------------------------------------------------------------------------
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("не PNG");
  let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const name = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (name === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (name === "IDAT") idat.push(data);
    else if (name === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) {
    throw new Error(`PNG не поддерживается: глубина ${depth}, тип ${type}, интерлейс ${interlace}`);
  }
  const ch = type === 6 ? 4 : 3, stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1), filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = raw[base + 1 + i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`неизвестный фильтр PNG ${filter} в строке ${y}`);
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * ch;
      out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2];
      out[o + 3] = ch === 4 ? cur[s + 3] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(name, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(name, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePng({ w, h, data }) {
  const row = w * 4 + 1, raw = Buffer.alloc(h * row);
  for (let y = 0; y < h; y++) data.copy(raw, y * row + 1, y * w * 4, (y + 1) * w * 4); // фильтр 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8 бит RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Поле: сетка, клетки, удаление фона
// ---------------------------------------------------------------------------
const isGridPx = (r, g, b) => r < 90 && g > 55 && g < 150 && b > 45 && b < 140 && g > r + 20;

// Линии сетки — столбцы/строки, где тёмно-бирюзовых пикселей больше половины
// максимума (подписи тикеров того же цвета, но занимают малую долю высоты).
export function findGrid(img) {
  const col = new Uint32Array(img.w), row = new Uint32Array(img.h);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      if (isGridPx(img.data[o], img.data[o + 1], img.data[o + 2])) { col[x]++; row[y]++; }
    }
  }
  const lines = (prof) => {
    const max = Math.max(...prof), res = [];
    let start = -1;
    for (let i = 0; i <= prof.length; i++) {
      const on = i < prof.length && prof[i] > max * 0.5;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { res.push([start, i - 1]); start = -1; }
    }
    return res;
  };
  const v = lines(col), hz = lines(row);
  if (v.length !== 13 || hz.length !== 13) {
    throw new Error(`сетка поля не найдена: вертикальных линий ${v.length}, горизонтальных ${hz.length} (нужно 13 и 13)`);
  }
  return { v, h: hz };
}

// Внутренность клетки (без линий сетки и светлого ободка).
export function cellRect(grid, r, c) {
  const i = 12 - c, j = r - 1;
  const x0 = grid.v[i][1] + 1 + CELL_INSET, x1 = grid.v[i + 1][0] - 1 - CELL_INSET;
  const y0 = grid.h[j][1] + 1 + CELL_INSET, y1 = grid.h[j + 1][0] - 1 - CELL_INSET;
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function cropImg(img, { x0, y0, w, h }) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(data, y * w * 4, ((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4);
  return { w, h, data };
}

const dist3 = (r, g, b, c) => Math.hypot(r - c[0], g - c[1], b - c[2]);

// Верх подписи тикера: нижняя сплошная полоса строк с пикселями цвета подписи.
function findTextTop(cell) {
  const rows = new Array(cell.h).fill(0);
  for (let y = 0; y < cell.h; y++) {
    for (let x = 0; x < cell.w; x++) {
      const o = (y * cell.w + x) * 4;
      if (dist3(cell.data[o], cell.data[o + 1], cell.data[o + 2], TEXT_RGB) < 50) rows[y]++;
    }
  }
  let y = cell.h - 1;
  while (y > 0 && rows[y] < 3) y--;           // пропускаем низ клетки без текста
  let top = y, gap = 0;
  for (; y >= Math.floor(cell.h * 0.4); y--) {
    if (rows[y] >= 3) { top = y; gap = 0; } else if (++gap > 3) break;
  }
  return top;
}

// Плоскость фона c = a + bx·x + by·y (по каналу) — по полосе вдоль края вырезки,
// из пикселей, похожих на фон клетки. У клеток лёгкий градиент освещения.
function fitBackground(img) {
  const band = 3, pts = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (x >= band && x < img.w - band && y >= band && y < img.h - band) continue;
      const o = (y * img.w + x) * 4, r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
      if (dist3(r, g, b, BG_RGB) < 40) pts.push([x, y, r, g, b]);
    }
  }
  if (pts.length < 20) throw new Error("не удалось определить фон клетки");
  // нормальные уравнения 3×3 (одинаковая матрица для трёх каналов)
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  const sv = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // [канал][1, x, y]
  for (const [x, y, ...c] of pts) {
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    for (let k = 0; k < 3; k++) { sv[k][0] += c[k]; sv[k][1] += c[k] * x; sv[k][2] += c[k] * y; }
  }
  const M = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
  const coef = sv.map((rhs) => solve3(M, rhs));
  return (x, y) => coef.map(([a, bx, by]) => a + bx * x + by * y);
}
function solve3(M, v) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(M);
  if (Math.abs(d) < 1e-9) return [v[0] / M[0][0], 0, 0];
  return [0, 1, 2].map((k) => det(M.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)))) / d);
}

// Удаление фона.
//  1. Фон — область, «залитая» от пикселей чистого фона (ближе KEY_T0) через
//     похожие на фон пиксели: ближе KEY_T1 или светлая кайма (фото поля
//     пересвечено — вокруг логотипов фон «высветлен» к белому). Заливка идёт
//     только по связным областям, поэтому смесь белого с синим внутри логотипа
//     (буквы durex — по цвету похожа на бирюзу) остаётся непрозрачной, а
//     замкнутые островки фона (внутри пламени Газпрома, в буквах Disney)
//     удаляются: в них есть свои пиксели чистого фона.
//  2. Всё, куда заливка не дошла, — логотип, непрозрачный.
//  3. Край со стороны фона — «матирование» по самому контрастному к фону
//     соседу-логотипу f: c = α·f + (1−α)·bg → α = проекция (c−bg) на (f−bg).
//     Так край не тянет за собой бирюзовую кайму.
//  4. Наружный контур логотипа (1–2 px) берёт цвет пикселя поглубже внутри,
//     если цвет тот же, — иначе пересвеченный контур даёт светлые точки или
//     тёмную обводку на тёмном фоне.
function keyBackground(img, bgAt) {
  const { w, h, data } = img, N = w * h;
  const d = new Float32Array(N), bgs = new Float32Array(N * 3), cand = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4, bg = bgAt(x, y);
      bgs[i * 3] = bg[0]; bgs[i * 3 + 1] = bg[1]; bgs[i * 3 + 2] = bg[2];
      d[i] = dist3(data[o], data[o + 1], data[o + 2], bg);
      // светлая кайма: c ≈ bg + t·(белый − bg), 0 < t < 0.85
      const v = [data[o] - bg[0], data[o + 1] - bg[1], data[o + 2] - bg[2]];
      const u = [255 - bg[0], 255 - bg[1], 255 - bg[2]];
      const t = (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
      const res = Math.hypot(v[0] - t * u[0], v[1] - t * u[1], v[2] - t * u[2]);
      if (d[i] < KEY_T1 || (t > 0 && t < 0.85 && res < 28)) cand[i] = 1;
      else if (t >= 0.85 && res < 28) cand[i] = 2; // почти белое — см. ниже
    }
  }
  // Почти белая кайма вплотную (≤2 px) к чистому фону — тоже фон (у круга
  // Яндекса пересвет доходит до белого). Белое глубже в логотипе (буквы,
  // «a» Amazon за тёмным контуром) не трогаем.
  for (let i = 0; i < N; i++) {
    if (cand[i] !== 2) continue;
    cand[i] = 0;
    const x = i % w, y = (i / w) | 0;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2) && !cand[i]; yy++)
      for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++)
        if (d[yy * w + xx] < KEY_T0) { cand[i] = 1; break; }
  }
  const bgSide = new Uint8Array(N), queue = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (d[i] < KEY_T0) { bgSide[i] = 1; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++], x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!bgSide[j] && cand[j]) { bgSide[j] = 1; queue[qt++] = j; }
    }
  }
  // глубина пикселя логотипа — шагов до фона (обход в ширину от всех пикселей фона)
  const depth = new Int32Array(N).fill(-1);
  qh = 0; qt = 0;
  for (let i = 0; i < N; i++) if (bgSide[i]) { depth[i] = 0; queue[qt++] = i; }
  while (qh < qt) {
    const i = queue[qh++], x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (depth[j] < 0) { depth[j] = depth[i] + 1; queue[qt++] = j; }
    }
  }
  // лучший сосед-логотип в радиусе R по ключу score (больше — лучше; при
  // равенстве — ближе)
  const pick = (i, R, score) => {
    const x = i % w, y = (i / w) | 0;
    let best = -1, bs = -Infinity, bd = Infinity;
    for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++)
      for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
        const j = yy * w + xx;
        if (bgSide[j]) continue;
        const s = score(j), sd = (xx - x) ** 2 + (yy - y) ** 2;
        if (s > bs || (s === bs && sd < bd)) { best = j; bs = s; bd = sd; }
      }
    return best;
  };
  // «чистый» цвет пикселя логотипа: у контура (глубина 1–2) — цвет самого
  // глубокого соседа f, если пиксель — тот же цвет, только загрязнённый: близок
  // к f или лежит между f и белым (пересвет). Иначе (белые линии durex,
  // доходящие до края квадрата) цвет остаётся своим.
  const clean = (i) => {
    if (depth[i] > 2) return i;
    const j = pick(i, 2, (k) => depth[k]), o = i * 4, q = j * 4;
    const f = [data[q], data[q + 1], data[q + 2]];
    if (dist3(data[o], data[o + 1], data[o + 2], f) < 160) return j;
    const u = [255 - f[0], 255 - f[1], 255 - f[2]], v = [data[o] - f[0], data[o + 1] - f[1], data[o + 2] - f[2]];
    const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
    if (!uu) return i;
    const s = (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / uu;
    const res = Math.hypot(v[0] - s * u[0], v[1] - s * u[1], v[2] - s * u[2]);
    return s < 0.8 && res < 60 ? j : i;
  };
  const out = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (!bgSide[i]) {
      const src = clean(i);
      data.copy(out, o, src * 4, src * 4 + 3); out[o + 3] = 255;
      continue;
    }
    if (d[i] < KEY_T0) continue;
    // α — по самому контрастному к фону соседу (у тёмного контура на белом —
    // по контуру), цвет — «чистый» цвет этого соседа
    const best = pick(i, 3, (j) => d[j]);
    if (best < 0) continue;
    const b0 = bgs[i * 3], b1 = bgs[i * 3 + 1], b2 = bgs[i * 3 + 2], q = best * 4;
    const c0 = data[o] - b0, c1 = data[o + 1] - b1, c2 = data[o + 2] - b2;
    const f0 = data[q] - b0, f1 = data[q + 1] - b1, f2 = data[q + 2] - b2;
    let a = (c0 * f0 + c1 * f1 + c2 * f2) / (f0 * f0 + f1 * f1 + f2 * f2);
    a = Math.max(0, Math.min(1, a));
    if (a < 0.06) continue;
    const src = clean(best) * 4;
    data.copy(out, o, src, src + 3); out[o + 3] = Math.round(a * 255);
  }
  return { w, h, data: out };
}

// Сглаживание контура (для пересвеченных/шумных вырезок): размываем альфу
// гауссом σ≈1 и снова делаем край резким smoothstep'ом — «зубцы» уходят,
// форма остаётся.
function smoothAlpha(img) {
  const { w, h, data } = img, K = [1, 4, 6, 4, 1], ks = 16;
  const a = new Float32Array(w * h), tmp = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = data[i * 4 + 3] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let k = -2; k <= 2; k++) s += a[y * w + Math.min(w - 1, Math.max(0, x + k))] * K[k + 2];
    tmp[y * w + x] = s / ks;
  }
  const out = Buffer.from(data);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let k = -2; k <= 2; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] * K[k + 2];
    s /= ks;
    const t = Math.max(0, Math.min(1, (s - 0.3) / 0.4)), o = (y * w + x) * 4;
    out[o + 3] = Math.round(t * t * (3 - 2 * t) * 255);
    if (out[o + 3] && !data[o + 3]) {
      // пиксель стал видимым — цвет берём у самого непрозрачного соседа
      let best = -1;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++)
        for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
          const j = (yy * w + xx) * 4;
          if (best < 0 || data[j + 3] > data[best + 3]) best = j;
        }
      data.copy(out, o, best, best + 3);
    }
  }
  return { w, h, data: out };
}
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

// Убираем мелкий мусор: компоненты (α>50%) меньше minArea пикселей и всё, что
// дальше 3 px от оставшихся компонент.
function dropSpecks(img, minArea = 10) {
  const { w, h, data } = img, N = w * h;
  const label = new Int32Array(N).fill(-1), keep = new Uint8Array(N);
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (label[s] >= 0 || data[s * 4 + 3] <= 127) continue;
    const comp = [];
    label[s] = s; stack.push(s);
    while (stack.length) {
      const i = stack.pop(); comp.push(i);
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (label[j] < 0 && data[j * 4 + 3] > 127) { label[j] = s; stack.push(j); }
      }
    }
    if (comp.length >= minArea) for (const i of comp) keep[i] = 1;
  }
  const near = new Uint8Array(N), R = 3;
  for (let i = 0; i < N; i++) {
    if (!keep[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++)
      for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) near[yy * w + xx] = 1;
  }
  const out = Buffer.from(data);
  for (let i = 0; i < N; i++) if (!near[i]) out[i * 4 + 3] = 0;
  return { w, h, data: out };
}

function trim(img, pad = 1) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (img.data[(y * img.w + x) * 4 + 3] > 5) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  if (x1 < 0) throw new Error("после удаления фона ничего не осталось");
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(img.w - 1, x1 + pad); y1 = Math.min(img.h - 1, y1 + pad);
  return cropImg(img, { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}

// Перекраска светлых малонасыщенных пикселей (белая «a» Amazon и её контур).
function recolor(img, { to, maxSat = 0.3 }) {
  const t = hexRgb(to), out = Buffer.from(img.data);
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * 4; if (!out[o + 3]) continue;
    const mx = Math.max(out[o], out[o + 1], out[o + 2]), mn = Math.min(out[o], out[o + 1], out[o + 2]);
    if (mx === 0 || (mx - mn) / mx < maxSat) { out[o] = t[0]; out[o + 1] = t[1]; out[o + 2] = t[2]; }
  }
  return { w: img.w, h: img.h, data: out };
}

// Уменьшение «коробочным» фильтром (усреднение по площади) в премультиплицированных
// цветах — так прозрачные пиксели не подмешивают свой RGB в края.
export function downscale(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.w, img.h));
  if (s === 1) return img;
  const W = Math.max(1, Math.round(img.w * s)), H = Math.max(1, Math.round(img.h * s));
  const src = new Float64Array(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) {
    const a = img.data[i * 4 + 3] / 255;
    src[i * 4] = img.data[i * 4] * a; src[i * 4 + 1] = img.data[i * 4 + 1] * a;
    src[i * 4 + 2] = img.data[i * 4 + 2] * a; src[i * 4 + 3] = a;
  }
  const weights = (n, N) => {   // для каждого выходного индекса — [индекс, вес]
    const k = n / N, res = [];
    for (let o = 0; o < N; o++) {
      const a = o * k, b = (o + 1) * k, ws = [];
      for (let i = Math.floor(a); i < Math.min(n, Math.ceil(b)); i++) {
        const wgt = Math.min(b, i + 1) - Math.max(a, i);
        if (wgt > 0) ws.push([i, wgt / k]);
      }
      res.push(ws);
    }
    return res;
  };
  const wx = weights(img.w, W), wy = weights(img.h, H);
  const tmp = new Float64Array(W * img.h * 4);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < W; x++)
    for (const [i, wgt] of wx[x]) for (let k = 0; k < 4; k++) tmp[(y * W + x) * 4 + k] += src[(y * img.w + i) * 4 + k] * wgt;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const acc = [0, 0, 0, 0];
    for (const [j, wgt] of wy[y]) for (let k = 0; k < 4; k++) acc[k] += tmp[(j * W + x) * 4 + k] * wgt;
    const o = (y * W + x) * 4, a = acc[3];
    out[o + 3] = clamp255(a * 255);
    if (a > 0) { out[o] = clamp255(acc[0] / a); out[o + 1] = clamp255(acc[1] / a); out[o + 2] = clamp255(acc[2] / a); }
  }
  return { w: W, h: H, data: out };
}

// Доминирующий цвет: самый частый насыщенный цвет (если насыщенных пикселей
// заметная доля), иначе самый частый не белый.
function dominantColor(img) {
  const buckets = new Map(), sat = new Map();
  let opaque = 0, satCount = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * 4; if (img.data[o + 3] < 230) continue;
    const r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mn > 225) continue; // белое
    opaque++;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const add = (m) => { const e = m.get(key) || [0, 0, 0, 0]; e[0]++; e[1] += r; e[2] += g; e[3] += b; m.set(key, e); };
    add(buckets);
    if (mx > 0 && (mx - mn) / mx > 0.35) { add(sat); satCount++; }
  }
  const pool = satCount >= opaque * 0.15 && sat.size ? sat : buckets;
  let best = null;
  for (const e of pool.values()) if (!best || e[0] > best[0]) best = e;
  if (!best) return "#000000";
  return rgbHex([best[1] / best[0], best[2] / best[0], best[3] / best[0]]);
}

const hexRgb = (hex) => { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const rgbHex = (c) => "#" + c.map((v) => clamp255(v).toString(16).padStart(2, "0")).join("").toUpperCase();

// Полный путь вырезки одного логотипа из клетки поля.
export function cutFromBoard(img, grid, r, c, opts = {}) {
  const rect = cellRect(grid, r, c);
  const cell = cropImg(img, rect);
  const textTop = findTextTop(cell);
  const logoArea = cropImg(cell, { x0: 0, y0: 0, w: cell.w, h: Math.max(10, textTop - 1) });
  let out = keyBackground(logoArea, fitBackground(logoArea));
  out = dropSpecks(out);
  // Логотип упирается в край вырезки — скорее всего, обрезан (на поле он залез
  // на ободок клетки или на подпись). Лучше выбрать другую клетку (--review).
  const touches = [];
  for (let x = 0; x < out.w; x++) {
    if (out.data[x * 4 + 3] > 127) touches.push("верх");
    if (out.data[((out.h - 1) * out.w + x) * 4 + 3] > 127) touches.push("низ");
  }
  for (let y = 0; y < out.h; y++) {
    if (out.data[y * out.w * 4 + 3] > 127) touches.push("лево");
    if (out.data[(y * out.w + out.w - 1) * 4 + 3] > 127) touches.push("право");
  }
  if (opts.smooth) out = smoothAlpha(out);
  out = trim(out);
  if (opts.recolor) out = recolor(out, opts.recolor);
  out = downscale(out, OUT_PNG_MAX);
  return { img: out, textTop, clipped: [...new Set(touches)] };
}

// ---------------------------------------------------------------------------
// Вектор: simple-icons и своя геометрия (viewBox 0 0 24 24, как у simple-icons)
// ---------------------------------------------------------------------------
function loadSimpleIcons(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "data", "simple-icons.json"), "utf8"));
  const list = Array.isArray(raw) ? raw : raw.icons;
  const bySlug = new Map(list.map((i) => [i.slug, i]));
  const pathOf = (slug) => {
    const file = path.join(dir, "icons", `${slug}.svg`);
    if (!fs.existsSync(file)) throw new Error(`в simple-icons ${pkg.version} нет иконки «${slug}»`);
    const svg = fs.readFileSync(file, "utf8");
    const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
    if (paths.length !== 1) throw new Error(`иконка «${slug}»: ожидался один <path>, найдено ${paths.length}`);
    return paths[0];
  };
  return { version: pkg.version, bySlug, pathOf };
}

const svgDoc = (comment, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><!-- ${comment} -->${body}</svg>\n`;

const f2 = (v) => (Math.round(v * 100) / 100).toString();
const polar = (cx, cy, r, deg) => [cx + r * Math.cos(deg * Math.PI / 180), cy - r * Math.sin(deg * Math.PI / 180)];
// Сектор от центра (углы — математические, против часовой от +x).
function wedge(cx, cy, a0, a1, r = 30) {
  const pts = [[cx, cy]];
  for (let a = a0; a < a1; a += 10) pts.push(polar(cx, cy, r, a));
  pts.push(polar(cx, cy, r, a1));
  return "M" + pts.map(([x, y]) => `${f2(x)} ${f2(y)}`).join("L") + "Z";
}
function lerpColor(stops, a) {
  if (a <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) {
    if (a <= stops[k][0]) {
      const [a0, c0] = stops[k - 1], [a1, c1] = stops[k], t = (a - a0) / (a1 - a0);
      const p = hexRgb(c0), q = hexRgb(c1);
      return rgbHex(p.map((v, i) => v + (q[i] - v) * t));
    }
  }
  return stops[stops.length - 1][1];
}

const DRAW = {
  // Четыре квадрата Microsoft — официальные цвета.
  microsoft: () => svgDoc("Microsoft: геометрия логотипа, нарисовано вручную",
    `<path fill="#F25022" d="M0 0h11.4v11.4H0z"/><path fill="#7FBA00" d="M12.6 0H24v11.4H12.6z"/>` +
    `<path fill="#00A4EF" d="M0 12.6h11.4V24H0z"/><path fill="#FFB900" d="M12.6 12.6H24V24H12.6z"/>`),

  // «G» Google: контур из simple-icons, раскрашенный секторами в четыре цвета
  // (центр «G» ≈ (12.3, 12)); перекладина — синяя поверх всего.
  google: (si) => {
    const d = si.pathOf("google"), cx = 12.3, cy = 12;
    return svgDoc("Google: контур simple-icons (CC0), четыре цвета секторами",
      `<defs><clipPath id="tm-googl-g"><path d="${d}"/></clipPath></defs><g clip-path="url(#tm-googl-g)">` +
      `<path fill="#EA4335" d="${wedge(cx, cy, 22, 160)}"/>` +
      `<path fill="#FBBC05" d="${wedge(cx, cy, 160, 212)}"/>` +
      `<path fill="#34A853" d="${wedge(cx, cy, 212, 318)}"/>` +
      `<path fill="#4285F4" d="${wedge(cx, cy, 318, 382)}"/>` +
      `<path fill="#4285F4" d="M12.3 10.6H24.5V14.6H12.3z"/></g>`);
  },

  // Глобус Pepsi: красный верх, синий низ, белая волна-«улыбка» (шире справа).
  pepsi: () => svgDoc("Pepsi: упрощённый глобус, нарисовано вручную",
    `<defs><clipPath id="tm-pep-c"><circle cx="12" cy="12" r="11.6"/></clipPath></defs><g clip-path="url(#tm-pep-c)">` +
    `<path fill="#E32934" d="M0 0H24V7C19.4 10.3 14.2 12.5 8.6 12.1C5.6 11.9 2.7 11.1 0 10.4Z"/>` +
    `<path fill="#004B93" d="M0 24H24V12.4C19.6 14.7 14.4 15.7 9 15.3C5.8 15 2.8 14.2 0 13.3Z"/></g>`),

  // Сбер: кольцо с разрывом справа сверху и галочка. Геометрия снята с клетки
  // поля (r2c8), цвета кольца — по углу, как на поле, но в фирменной гамме.
  // «Конический» градиент собран из узких секторов кольца (SVG его не умеет);
  // каждый сектор чуть заходит на следующий, чтобы не было швов сглаживания.
  sber: () => {
    const cx = 12, cy = 12, ro = 11.5, ri = 8.35, from = 55, to = 368, step = 2.5;
    const stops = [
      [55, "#1A8FE8"], [110, "#0FA8E0"], [140, "#1FBFC2"], [160, "#38CA84"], [176, "#8BD33D"],
      [196, "#D0E221"], [214, "#F2E913"], [248, "#F2E913"], [266, "#B2DA31"], [284, "#55BF3F"],
      [304, "#21A038"], [368, "#21A038"],
    ];
    let ring = "";
    for (let a = from; a < to; a += step) {
      const b = Math.min(to, a + step + 0.6), m = Math.min(to, a + step / 2);
      const pts = [polar(cx, cy, ro, a), polar(cx, cy, ro, b), polar(cx, cy, ri, b), polar(cx, cy, ri, a)];
      ring += `<path fill="${lerpColor(stops, m)}" d="M${pts.map(([x, y]) => `${f2(x)} ${f2(y)}`).join("L")}Z"/>`;
    }
    const check = `<path fill="#21A038" d="M7.42 9.3L7.65 12.78L11.89 15.01L22.38 7.65L21.04 5.41L11.89 11.44Z"/>`;
    return svgDoc("Сбер: реконструкция логотипа по полю (кольцо + галочка), нарисовано вручную", ring + check);
  },
};

function siSvg(si, slug, color) {
  return svgDoc(`Simple Icons (CC0), «${slug}». Товарный знак принадлежит владельцу`,
    `<path fill="${color}" d="${si.pathOf(slug)}"/>`);
}

// ---------------------------------------------------------------------------
// Контактный лист для ревью: все логотипы на белом, кремовом поле и цветах секторов
// ---------------------------------------------------------------------------
const SECTORS = { // как в engine.js / styles.css (светлая тема)
  tech: ["Технологии", "#3F63C9"], media: ["Интернет и медиа", "#8A54D6"],
  consumer: ["Потребительские товары", "#B26026"], industrial: ["Промышленность и транспорт", "#56656F"],
  finance: ["Финансы и сырьё", "#26825A"],
};
const SECTOR_OF = {
  tech: "AAPL MSFT GOOGL NVDA IBM INTC SONY", media: "AMZN DIS NFLX META YDEX VKCO",
  consumer: "MCD NKE KO WMT PEP SBUX RKT ADS", industrial: "BA TSLA MMM AFLT F", finance: "V SBER GAZP MGNT MTSS",
};
const sectorOf = (t) => Object.keys(SECTOR_OF).find((k) => SECTOR_OF[k].split(" ").includes(t));

function contactSheet(outDir, manifest) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const bgs = [["белый", "#FFFFFF"], ["поле (крем)", "#EFE3C6"], ...Object.values(SECTORS).map(([n, c]) => [n, c])];
  const sizes = [16, 24, 40, 64];
  let css = "", rows = "";
  for (const [t, m] of Object.entries(manifest)) {
    const file = path.join(outDir, m.file);
    const mime = m.file.endsWith(".svg") ? "image/svg+xml" : "image/png";
    css += `.L-${t}{background-image:url(data:${mime};base64,${fs.readFileSync(file).toString("base64")})}\n`;
    const sec = SECTORS[sectorOf(t)];
    let cells = "";
    for (const [, color] of bgs) {
      cells += `<td style="background:${color}">` + sizes.map((s) => `<i class="lg L-${t}" style="width:${s}px;height:${s}px"></i>`).join("") + "</td>";
    }
    const badge = [28, 44].map((s) => `<span class="badge" style="width:${s}px;height:${s}px;border-radius:${Math.round(s * 0.28)}px"><i class="lg L-${t}" style="width:${Math.round(s * 0.72)}px;height:${Math.round(s * 0.72)}px"></i></span>`).join("");
    rows += `<tr><th><b>${t}</b><small>${esc(m.source)}<br><span class="sw" style="background:${m.color}"></span>${m.color}</small></th>${cells}<td style="background:${sec[1]}">${badge}</td></tr>\n`;
  }
  const head = bgs.map(([n, c]) => `<th>${esc(n)}<br><small>${c}</small></th>`).join("");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Логотипы компаний</title>
<style>
:root{--ink:#2B2118;--line:#D8CDB8;--page:#F7F2E8;}
body{margin:0;padding:16px;background:var(--page);color:var(--ink);font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;}
h1{font-size:18px;margin:0 0 4px;} p{margin:0 0 12px;max-width:70ch;}
.wrap{overflow-x:auto;}
table{border-collapse:collapse;} th,td{border:1px solid var(--line);padding:6px 8px;vertical-align:middle;}
thead th{background:#fff;font-weight:600;font-size:12px;position:sticky;top:0;}
tbody th{text-align:left;background:#fff;min-width:120px;} tbody th small{display:block;font-weight:400;color:#6B5E4C;font-size:11px;}
td{white-space:nowrap;}
.lg{display:inline-block;vertical-align:middle;margin:0 5px;background:center/contain no-repeat;}
.badge{display:inline-flex;align-items:center;justify-content:center;background:#fff;margin:0 5px;vertical-align:middle;box-shadow:0 1px 2px rgba(0,0,0,.25);}
.badge .lg{margin:0;}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:4px;border:1px solid rgba(0,0,0,.2);}
${css}</style></head><body>
<h1>Логотипы компаний — ${Object.keys(manifest).length} шт.</h1>
<p>Каждая строка: 16 / 24 / 40 / 64 px на белом, на кремовом цвете поля и на цветах пяти секторов; в последней колонке — логотип на белой плашке поверх цвета своего сектора. Источник и цвет бренда из logos.json — под тикером.</p>
<div class="wrap"><table><thead><tr><th>тикер</th>${head}<th>на плашке<br><small>свой сектор</small></th></tr></thead>
<tbody>
${rows}</tbody></table></div>
</body></html>
`;
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { board: path.join(ROOT, "maps.png"), out: path.join(ROOT, "server", "public", "logos"), si: process.env.SIMPLE_ICONS_DIR || "" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`нет значения для ${k}`); return argv[++i]; };
    if (k === "--si") a.si = v();
    else if (k === "--board") a.board = v();
    else if (k === "--out") a.out = v();
    else if (k === "--contact") a.contact = v();
    else if (k === "--review") a.review = v();
    else if (k === "--only") a.only = v().split(",").map((s) => s.trim().toUpperCase());
    else if (k === "-h" || k === "--help") a.help = true;
    else throw new Error(`неизвестный параметр ${k}`);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node tools/logos/build-logos.mjs --si <simple-icons> [--board maps.png] [--out dir] [--contact file.html] [--review dir] [--only T1,T2]");
    return;
  }
  if (!args.si) throw new Error("укажите путь к пакету simple-icons: --si <папка>/node_modules/simple-icons (см. tools/logos/README.md)");
  const si = loadSimpleIcons(args.si);
  if (si.version !== SI_VERSION) console.warn(`! simple-icons ${si.version}, скрипт выверен на ${SI_VERSION} — проверьте контактный лист`);

  const tickers = Object.keys(LOGOS).filter((t) => !args.only || args.only.includes(t));
  const needBoard = tickers.some((t) => LOGOS[t].board) || args.review;
  let img = null, grid = null;
  if (needBoard) {
    img = decodePng(fs.readFileSync(args.board));
    grid = findGrid(img);
  }

  fs.mkdirSync(args.out, { recursive: true });
  const manifestPath = path.join(args.out, "logos.json");
  // С --only остальные записи logos.json сохраняем как были.
  const manifest = args.only && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};

  for (const t of tickers) {
    const cfg = LOGOS[t];
    let file, color, source;
    if (cfg.si) {
      const meta = si.bySlug.get(cfg.si);
      color = cfg.color || "#" + meta.hex.toUpperCase();
      file = `${t}.svg`; source = `simple-icons:${cfg.si}`;
      fs.writeFileSync(path.join(args.out, file), siSvg(si, cfg.si, color));
    } else if (cfg.svg) {
      color = cfg.color; file = `${t}.svg`; source = `svg:${cfg.svg}`;
      fs.writeFileSync(path.join(args.out, file), DRAW[cfg.svg](si));
    } else if (cfg.board) {
      const [r, c] = cfg.board;
      if (boardTicker(r, c) !== t) throw new Error(`${t}: в клетке r${r}c${c} на поле ${boardTicker(r, c)}`);
      const res = cutFromBoard(img, grid, r, c, cfg);
      if (res.clipped.length) console.warn(`! ${t} r${r}c${c}: логотип касается края вырезки (${res.clipped.join(", ")}) — возможно, обрезан`);
      color = cfg.color || dominantColor(res.img);
      file = `${t}.png`; source = `board:r${r}c${c}`;
      fs.writeFileSync(path.join(args.out, file), encodePng(res.img));
    } else throw new Error(`${t}: не задан источник`);
    // Другой вариант того же тикера (svg↔png) удаляем, чтобы не путать клиент.
    for (const ext of [".svg", ".png"]) {
      const other = path.join(args.out, t + ext);
      if (t + ext !== file && fs.existsSync(other)) fs.unlinkSync(other);
    }
    manifest[t] = { file, color, source };
    console.log(`${t.padEnd(6)} ${file.padEnd(10)} ${color}  ${source}`);
  }

  // logos.json — в порядке LOGOS, одна строка на тикер (удобно смотреть диффы).
  const ordered = Object.keys(LOGOS).filter((t) => manifest[t]);
  const json = "{\n" + ordered.map((t) => `  ${JSON.stringify(t)}: ${JSON.stringify(manifest[t])}`).join(",\n") + "\n}\n";
  fs.writeFileSync(manifestPath, json);
  console.log(`logos.json: ${ordered.length} тикеров → ${manifestPath}`);

  if (args.contact) {
    const full = Object.fromEntries(ordered.map((t) => [t, manifest[t]]));
    fs.writeFileSync(args.contact, contactSheet(args.out, full));
    console.log(`контактный лист: ${args.contact}`);
  }

  // --review: все клетки поля для тикеров-вырезок — чтобы выбрать самую чистую.
  if (args.review) {
    fs.mkdirSync(args.review, { recursive: true });
    const boardTickers = args.only || Object.keys(LOGOS).filter((t) => LOGOS[t].board);
    for (const t of boardTickers) {
      const found = [];
      for (let r = 1; r <= 12; r++) for (let c = 12; c >= 1; c--) if (boardTicker(r, c) === t) found.push([r, c]);
      const cuts = found.map(([r, c]) => cutFromBoard(img, grid, r, c, LOGOS[t] || {}));
      const imgs = cuts.map((x) => x.img);
      // полоса: кандидаты на белом, слева направо в порядке списка
      const S = OUT_PNG_MAX + 8, M = { w: S * imgs.length, h: S, data: Buffer.alloc(S * imgs.length * S * 4, 255) };
      imgs.forEach((im, k) => {
        const ox = k * S + ((S - im.w) >> 1), oy = (S - im.h) >> 1;
        for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
          const s = (y * im.w + x) * 4, d = ((oy + y) * M.w + ox + x) * 4, a = im.data[s + 3] / 255;
          for (let ch = 0; ch < 3; ch++) M.data[d + ch] = clamp255(im.data[s + ch] * a + 255 * (1 - a));
        }
      });
      fs.writeFileSync(path.join(args.review, `${t}.png`), encodePng(M));
      console.log(`review ${t}: ${found.map(([r, c], k) => `r${r}c${c}${cuts[k].clipped.length ? "(обрезан?)" : ""}`).join(" ")}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try { main(); } catch (e) { console.error("Ошибка:", e.message); process.exit(1); }
}
