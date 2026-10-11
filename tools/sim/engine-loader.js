"use strict";
// ---------------------------------------------------------------------
// Загрузчик движка для симуляций баланса (tools/sim).
// Читает server/public/engine.js как ТЕКСТ и исполняет его в отдельном
// vm-контексте — сам файл движка не меняется и всегда берётся «как есть»:
//  - Math.random внутри контекста подменяется детерминированным генератором,
//    поэтому партия с тем же seed воспроизводится байт в байт (и не зависит
//    от того, сколько потоков считало прогон);
//  - верхнеуровневые константы движка можно подменить (--override NAME=value):
//    в исходнике ищется `const NAME = <литерал>;`, и литерал заменяется ДО
//    исполнения. Не нашли объявление — громкая ошибка, а не тихий прогон;
//  - перед финальным `return { … }` фабрики вставляется «крючок», который
//    отдаёт симулятору внутренние (не экспортируемые) функции и константы
//    движка: стоимости мер, botChoosePct, getForcedPaymentPct и т.п.
//    Если движок переименует что-то из них, профили откатятся на свои копии формул.
// ---------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const DEFAULT_ENGINE_PATH = path.resolve(__dirname, "..", "..", "server", "public", "engine.js");

// --- Детерминированный ГПСЧ: xmur3 (хеш строки-сида) + sfc32 ---
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
// Генератор [0,1) по произвольной строке-сиду. Сид партии — "<seed>#<номер партии>",
// поэтому партия №N одинакова при любом разбиении прогона по потокам.
function makeRng(seed) {
  const h = xmur3(String(seed));
  const rng = sfc32(h(), h(), h(), h());
  for (let i = 0; i < 12; i++) rng(); // прогрев — первые значения sfc32 слабо перемешаны
  return rng;
}

// Значение для --override/--set: сначала JSON, затем JS-литерал ({A:1,B:2} без
// кавычек удобнее набирать в PowerShell). Разрешены только данные — числа,
// строки, булевы, null, массивы и простые объекты.
function parseLiteral(raw, what) {
  const s = String(raw == null ? "" : raw).trim();
  if (s === "") throw new Error(`${what}: пустое значение`);
  let v;
  try {
    v = JSON.parse(s);
  } catch (_) {
    try {
      v = vm.runInNewContext("(" + s + ")", Object.create(null), { timeout: 200 });
    } catch (e) {
      throw new Error(`${what}: «${s}» — не JSON и не JS-литерал (${e.message})`);
    }
  }
  const bad = findNonData(v);
  if (bad) throw new Error(`${what}: «${s}» — допускаются только данные (числа, строки, массивы, объекты), найдено: ${bad}`);
  return JSON.parse(JSON.stringify(v)); // в «чистые» объекты основного realm
}
function findNonData(v, depth) {
  depth = depth || 0;
  if (depth > 20) return "слишком глубокая вложенность";
  if (v === null) return null;
  const t = typeof v;
  if (t === "number") return Number.isFinite(v) ? null : "не конечное число";
  if (t === "string" || t === "boolean") return null;
  if (t !== "object") return t;
  for (const k of Object.keys(v)) {
    const r = findNonData(v[k], depth + 1);
    if (r) return r;
  }
  return null;
}

// Подмена `const NAME = …;` в исходнике. Если объявлений с таким именем несколько
// (например, одноимённая локальная константа внутри функции), берём самое
// «внешнее» — с наименьшим отступом; при равенстве отступов — ошибка неоднозначности.
function applyOverrides(src, overrides) {
  const applied = [];
  for (const { name, value } of overrides || []) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`--override: некорректное имя константы «${name}»`);
    const re = new RegExp(`^([ \\t]*)const[ \\t]+${name.replace(/\$/g, "\\$")}[ \\t]*=[ \\t]*([\\s\\S]*?);`, "gm");
    const matches = [...src.matchAll(re)];
    if (!matches.length) {
      throw new Error(`--override ${name}: в engine.js нет объявления «const ${name} = …;» — константу переименовали или удалили? Список констант: node tools/sim/sim.js --list-constants`);
    }
    let m = matches[0];
    if (matches.length > 1) {
      const minIndent = Math.min(...matches.map((x) => x[1].length));
      const outer = matches.filter((x) => x[1].length === minIndent);
      if (outer.length > 1) throw new Error(`--override ${name}: объявление встречается ${outer.length} раз(а) на одном уровне — неоднозначно.`);
      m = outer[0];
    }
    const literal = JSON.stringify(value);
    src = src.slice(0, m.index) + `${m[1]}const ${name} = ${literal};` + src.slice(m.index + m[0].length);
    applied.push({ name, from: m[2].trim().replace(/\s+/g, " ").slice(0, 160), to: literal });
  }
  return { src, applied };
}

// Верхнеуровневые константы фабрики (для --list-constants): имя + исходный литерал.
function listConstants(src) {
  const ret = findFactoryReturn(src);
  const indent = ret ? ret.indent : "  ";
  const re = new RegExp(`^${indent}const[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*=[ \\t]*([\\s\\S]*?);`, "gm");
  return [...src.matchAll(re)].map((m) => ({ name: m[1], value: m[2].trim().replace(/\s+/g, " ") }));
}

// Финальный `return {` фабрики UMD — последний такой в файле.
function findFactoryReturn(src) {
  const re = /\n([ \t]*)return[ \t]*\{/g;
  let m, last = null;
  while ((m = re.exec(src))) last = m;
  return last ? { index: last.index, indent: last[1] } : null;
}

// Вставляет перед финальным return фабрики вызов __simHook({имя: значение, …})
// со ВСЕМИ объявлениями уровня фабрики (тот же отступ, что у return). Каждое имя
// обёрнуто в typeof — отсутствующее просто придёт как undefined.
function injectHook(src) {
  const ret = findFactoryReturn(src);
  if (!ret) return { src, names: [] };
  const ind = ret.indent.replace(/[^\t ]/g, "");
  const declRe = new RegExp(`^${ind}(?:function[ \\t]*\\*?[ \\t]*([A-Za-z_$][\\w$]*)[ \\t]*\\(|(?:const|let|var)[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*=)`, "gm");
  const names = new Set();
  for (const d of src.matchAll(declRe)) names.add(d[1] || d[2]);
  const body = [...names].map((n) => `${JSON.stringify(n)}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(", ");
  const hook = `\n${ind}try { if (typeof __simHook === "function") __simHook({ ${body} }); } catch (e) { if (typeof __simHook === "function") __simHook(null, e); }`;
  return { src: src.slice(0, ret.index) + hook + src.slice(ret.index), names: [...names] };
}

// Готовит исходник один раз (в главном потоке): потоки-воркеры получают уже
// подготовленный текст, а не перечитывают файл — иначе правка engine.js
// посреди прогона дала бы разным потокам разные версии правил.
function prepareEngineSource(opts) {
  opts = opts || {};
  const file = path.resolve(opts.enginePath || DEFAULT_ENGINE_PATH);
  const original = opts.source != null ? opts.source : fs.readFileSync(file, "utf8");
  const sha1 = crypto.createHash("sha1").update(original).digest("hex").slice(0, 12);
  const { src: withOverrides, applied } = applyOverrides(original, opts.overrides || []);
  const { src, names } = injectHook(withOverrides);
  return { file, sha1, src, applied, hookNames: names };
}

// Встроенные объекты, которые движок берёт из глобальной области. В vm-контексте
// каждое обращение к глобальному имени идёт через перехватчик песочницы и вдвое
// замедляет движок — поэтому исходник оборачивается в функцию, где эти имена —
// обычные параметры (значения берутся из самого контекста один раз).
const GLOBAL_ALIASES = ["Math", "Date", "Number", "Object", "JSON", "Array", "String", "Boolean", "Set", "Map", "WeakMap", "Symbol",
  "Error", "TypeError", "RangeError", "isFinite", "isNaN", "parseInt", "parseFloat", "Intl", "RegExp", "Promise", "console", "module", "__simHook"];

// Исполняет подготовленный исходник в новом vm-контексте.
// Возвращает { E — экспорт движка, I — внутренности (могут быть пустыми), setRng(fn) }.
function instantiateEngine(prepared) {
  const box = { rng: Math.random, internals: null, hookError: null };
  const sandbox = {
    module: { exports: {} },
    console,
    __simHook(obj, err) { if (obj) box.internals = obj; else box.hookError = err; },
  };
  const ctx = vm.createContext(sandbox, { name: "engine-sim" });
  // Math внутри контекста — свой; движок зовёт Math.random() при каждом броске,
  // поэтому достаточно подменить свойство один раз и переключать генератор в box.
  vm.runInContext("Math", ctx).random = function () { return box.rng(); };
  // Обёртка в той же строке, что и первая строка движка, — номера строк в стеке ошибок совпадают с engine.js.
  const params = GLOBAL_ALIASES.join(", ");
  const args = GLOBAL_ALIASES.map((n) => `typeof ${n} !== "undefined" ? ${n} : undefined`).join(", ");
  const wrapped = `(function (${params}) {${prepared.src}\n}).call(this, ${args});`;
  new vm.Script(wrapped, { filename: prepared.file }).runInContext(ctx);
  const E = sandbox.module.exports;
  if (!E || typeof E.freshRoom !== "function" || typeof E.botStep !== "function") {
    throw new Error(`${prepared.file}: движок не экспортировал freshRoom/botStep — это точно engine.js?`);
  }
  return {
    E,
    I: box.internals || {},
    hookError: box.hookError,
    prepared,
    setRng(fn) { box.rng = fn; },
  };
}

function loadEngine(opts) {
  return instantiateEngine(prepareEngineSource(opts));
}

module.exports = {
  DEFAULT_ENGINE_PATH, makeRng, parseLiteral, applyOverrides, listConstants, injectHook,
  prepareEngineSource, instantiateEngine, loadEngine,
};
