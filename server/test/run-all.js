// ---------------------------------------------------------------------
// Запуск всех проверок подряд с итоговой сводкой (npm test).
//   node test/run-all.js            — всё, смоук ждёт периодическое сохранение (~35 с)
//   node test/run-all.js --fast     — то же без ожидания (SMOKE_FAST=1, npm run test:fast)
//   node test/run-all.js engine     — только выбранные: check, engine, smoke, shop
// Каждый набор — отдельный процесс node: падение одного не мешает остальным,
// а код выхода ненулевой, если не прошёл хоть один.
// ---------------------------------------------------------------------
const { spawnSync } = require("child_process");
const path = require("path");

const SUITES = [
  { name: "check", file: "check.js", title: "синтаксис, повторы функций, партии ботов" },
  { name: "engine", file: "engine.test.js", title: "правила движка" },
  { name: "smoke", file: "smoke.js", title: "сервер: HTTP + WebSocket" },
  { name: "shop", file: "shop.test.js", title: "магазин, заказы, реклама" },
];

const args = process.argv.slice(2);
const fast = args.includes("--fast");
const only = args.filter((a) => !a.startsWith("--"));
const unknown = only.filter((n) => !SUITES.some((s) => s.name === n));
if (unknown.length) {
  console.error(`Неизвестный набор: ${unknown.join(", ")}. Есть: ${SUITES.map((s) => s.name).join(", ")}.`);
  process.exit(2);
}
const selected = only.length ? SUITES.filter((s) => only.includes(s.name)) : SUITES;
// Флаг вместо переменной окружения в npm-скрипте: «SMOKE_FAST=1 node …» не
// работает в cmd.exe/PowerShell, а так test:fast одинаков на любой ОС.
const env = Object.assign({}, process.env, fast ? { SMOKE_FAST: "1" } : {});

const results = [];
for (const s of selected) {
  console.log(`\n=== ${s.name}: ${s.title} ===`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, s.file)], { stdio: "inherit", env, cwd: path.join(__dirname, "..") });
  const code = r.error ? `ошибка запуска: ${r.error.message}` : r.status !== null ? r.status : `сигнал ${r.signal}`;
  results.push({ name: s.name, ok: code === 0, code, sec: ((Date.now() - t0) / 1000).toFixed(1) });
}

console.log("\n=== Итог ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(7)} ${String(r.sec).padStart(5)} с${r.ok ? "" : `  (код ${r.code})`}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\nНе прошли: ${failed.map((r) => r.name).join(", ")} (${failed.length} из ${results.length})`
  : `\nВсё прошло: ${results.map((r) => r.name).join(", ")}${fast ? " (быстрый режим)" : ""}`);
process.exit(failed.length ? 1 : 0);
