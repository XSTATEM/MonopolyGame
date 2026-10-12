// Включает в сборку плагины покупок и рекламы — по переменным окружения
// (docs/MONETIZATION-SPEC.md, §10; инструкция — mobile/README.md):
//
//   TM_STORE=direct|rustore|googleplay      тип сборки (по умолчанию direct)
//   TM_YANDEX_REWARDED_ID=R-M-…             видео Яндекса (direct, rustore)
//   TM_ADMOB_APP_ID, TM_ADMOB_REWARDED_ID   видео AdMob (только googleplay)
//   TM_RUSTORE_CONSOLE_APP_ID, TM_RUSTORE_PAY_SCHEME   обязательны для rustore
//
// Запускается после `npm ci` и до `npm run android:init`. В сборке по умолчанию
// (direct без рекламы) его не запускают, и набор плагинов остаётся прежним.
// Ставит плагины через `npm install` — это правит package.json и package-lock.json:
// в CI это рабочая копия, а локально верните их потом (git checkout -- package.json package-lock.json).
// Пишет .native-build.json — по нему patch-android.mjs правит Android-проект.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFlavor, pluginsFor, PLUGINS } from "./build-flavor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, ".native-build.json");

const f = readFlavor();
f.warnings.forEach((w) => console.warn("Внимание: " + w));
if (f.errors.length) {
  f.errors.forEach((e) => console.error("Ошибка: " + e));
  console.error("Сборка остановлена: исправьте переменные (Settings → Secrets and variables → Actions → Variables), см. mobile/README.md.");
  process.exit(1);
}

const plugins = pluginsFor(f);
if (!plugins.length) {
  // Нечего включать: убираем след прошлого запуска, чтобы patch-android.mjs
  // не правил проект под плагины, которых в сборке нет.
  rmSync(outFile, { force: true });
  console.log(`Сборка ${f.store}: плагины покупок и рекламы не нужны — всё как в обычной сборке.`);
  process.exit(0);
}

// Точные версии сторонних плагинов: обновлять осознанно, с проверочной сборкой.
const SPECS = {
  [PLUGINS.yandex]: "./native/yandex-rewarded",
  [PLUGINS.rustore]: "./native/rustore-pay",
  [PLUGINS.googleBilling]: "@capgo/native-purchases@8.8.1",
  [PLUGINS.admob]: "@capacitor-community/admob@8.1.0",
};
// --install-links: локальный плагин копируется в node_modules, а не ссылкой —
// так cap sync и gradle видят его как обычный пакет.
const args = ["install", "--no-audit", "--no-fund", "--save-exact", "--install-links", ...plugins.map((p) => SPECS[p])];
console.log(`Сборка ${f.store}: ставлю ${plugins.join(", ")}`);
// npm на Windows — это npm.cmd, его запускаем через cmd.exe. Аргументы здесь —
// только наши константы, без строк из окружения.
const r = process.platform === "win32"
  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "npm", ...args], { cwd: root, stdio: "inherit" })
  : spawnSync("npm", args, { cwd: root, stdio: "inherit" });
if (r.status !== 0) {
  console.error("npm install завершился с ошибкой — плагины не установлены.");
  process.exit(1);
}
for (const p of plugins) {
  if (!existsSync(join(root, "node_modules", ...p.split("/"), "package.json"))) {
    console.error(`Плагин ${p} не появился в node_modules после установки.`);
    process.exit(1);
  }
}

const info = { store: f.store, plugins };
if (plugins.includes(PLUGINS.rustore)) info.rustore = { appId: f.rustoreAppId, scheme: f.rustoreScheme };
if (plugins.includes(PLUGINS.admob)) info.admob = { appId: f.admobAppId };
writeFileSync(outFile, JSON.stringify(info, null, 2) + "\n");
console.log(`Записан ${outFile}: ${JSON.stringify(info)}`);
