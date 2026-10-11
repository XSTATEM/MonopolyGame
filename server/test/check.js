// ---------------------------------------------------------------------
// Статическая проверка клиента и сервера (без сети, ~1 с).
// Запуск: node test/check.js  (из папки server) или npm test.
// - разбирает каждый встроенный <script> в public/*.html (index.html обязателен)
//   через vm.Script — номера строк в ошибках совпадают с файлом;
// - разбирает все .js: public/*.js (engine, anim, sw, native, skins, tutorial —
//   что есть), server.js, users.js и сами тесты;
// - ищет повторно объявленные функции верхнего уровня: поздняя декларация
//   молча побеждает раннюю, и правка «не той» копии ни на что не влияет;
// - грузит engine.js в Node и прогоняет несколько партий одних ботов:
//   ни исключений, ни нечисловых (NaN/Infinity) наличных.
// ---------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let bad = 0;
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
function ok(msg) { console.log("OK   " + msg); }
function fail(msg) { bad++; console.log("FAIL " + msg); }

function parse(label, code) {
  try { new vm.Script(code, { filename: label }); ok(label); }
  catch (e) { fail(label + ": " + e.message + (e.stack ? "\n" + e.stack.split("\n").slice(0, 3).join("\n") : "")); }
}
const listJs = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort().map((f) => path.join(dir, f))
  : [];

// Повторы имён функций одного уровня. В файлах с функциями «с нуля» (server.js,
// sw.js, встроенный скрипт index.html) верхний уровень — колонка 0; файлы,
// обёрнутые в IIFE/UMD (engine.js, anim.js…), объявляют их с отступом 2.
function findDuplicateFunctions(code) {
  const level = /^function\s/m.test(code) ? "" : "  ";
  const re = new RegExp("^" + level + "function\\s+([A-Za-z0-9_$]+)\\s*\\(", "gm");
  const names = {};
  for (const m of code.matchAll(re)) names[m[1]] = (names[m[1]] || 0) + 1;
  return Object.entries(names).filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
}

// --- встроенные скрипты страниц ----------------------------------------
const publicDir = path.join(ROOT, "public");
const indexPath = path.join(publicDir, "index.html");
if (!fs.existsSync(indexPath)) fail("public/index.html не найден");
const htmlFiles = fs.readdirSync(publicDir).filter((f) => f.endsWith(".html")).sort();
for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(publicDir, f), "utf8");
  // Только исполняемые скрипты: без src и без type, отличного от JS (module,
  // application/json и шаблоны vm.Script не разберёт — их и не проверяем).
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, i = 0, inline = "";
  while ((m = re.exec(html))) {
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]) || [])[1];
    if (type && !/^(text|application)\/(javascript|ecmascript)$/i.test(type)) continue;
    i++;
    const line = html.slice(0, m.index).split("\n").length;
    // Дополняем переводами строк, чтобы номер строки ошибки совпадал с .html.
    parse(`public/${f} inline #${i} (со строки ${line})`, "\n".repeat(line - 1) + m[2]);
    inline += m[2] + "\n";
  }
  const dups = findDuplicateFunctions(inline);
  if (dups.length) fail(`повторно объявленные функции в public/${f}: ${dups.join(", ")}`);
  else if (i) ok(`public/${f}: без повторно объявленных функций`);
}

// --- отдельные .js -------------------------------------------------------
const jsFiles = [...listJs(publicDir), ...listJs(ROOT), ...listJs(__dirname)];
for (const p of jsFiles) {
  const code = fs.readFileSync(p, "utf8").replace(/^#!.*/, "");
  parse(rel(p), code);
  const dups = findDuplicateFunctions(code);
  if (dups.length) fail(`повторно объявленные функции в ${rel(p)}: ${dups.join(", ")}`);
}
ok(`повторы функций проверены в ${jsFiles.length} .js`);

// --- движок: партии одних ботов -------------------------------------------
try {
  const enginePath = path.join(publicDir, "engine.js");
  delete require.cache[require.resolve(enginePath)];
  const E = require(enginePath);
  const GAMES = Number(process.env.CHECK_BOT_GAMES) || 5;
  for (let g = 0; g < GAMES; g++) {
    const r = E.freshRoom("T" + g);
    r.settings = Object.assign({}, r.settings);
    ["A", "B", "C", "D"].forEach((n) => E.addPlayer(r, "Bot" + n, "", "", 0, "default", true));
    r.phase = "roll"; r.maxRounds = 12;
    let steps = 0;
    while (r.phase === "roll" && steps < 20000) { const s = E.botStep(r); steps++; if (!s.acted) break; }
    for (const p of r.players) E.buildStatePayload(r, p.id);
    const nanCash = r.players.filter((p) => !Number.isFinite(p.cash));
    if (nanCash.length) throw new Error(`нечисловые наличные после партии ботов ${g}: ${nanCash.map((p) => p.name + "=" + p.cash).join(", ")}`);
    ok(`партия ботов ${g}: phase=${r.phase} steps=${steps} round=${r.roundNumber}`);
  }
} catch (e) { fail("движок упал в партии ботов: " + e.stack); }

console.log(bad ? `\n${bad} PROBLEM(S)` : "\nALL CHECKS PASSED");
process.exit(bad ? 1 : 0);
