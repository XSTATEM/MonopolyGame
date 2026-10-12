// Правки сгенерированного Android-проекта, которые нельзя задать через
// capacitor.config.json. Запускается после `cap add android` (npm run android:init).
//
// Всегда — только allowBackup=false. Если enable-native.mjs включил плагины
// покупок или рекламы (есть .native-build.json), дополнительно прописывает
// то, что нужно их SDK: репозиторий RuStore, id приложения в консоли, схему
// возврата из банковских приложений, id приложения AdMob и настройки сборки.
// Каждая вставка проверяется; повторный запуск ничего не дублирует.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RE, PLUGINS } from "./build-flavor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = join(root, "android");
const manifest = join(androidDir, "app", "src", "main", "AndroidManifest.xml");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
// Вставка «один раз»: если маркер уже в тексте — оставляем как есть,
// иначе применяем правку и убеждаемся, что маркер появился.
function ensure(text, marker, apply, what) {
  if (text.includes(marker)) return text;
  const out = apply(text);
  if (out === text || !out.includes(marker)) fail(`Не удалось ${what}`);
  return out;
}
function patchFile(path, fn) {
  if (!existsSync(path)) fail(`Не найден ${path} — сначала выполните cap add android.`);
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after !== before) writeFileSync(path, after);
}
// В шаблоне Capacitor `</application>` в манифесте один; вставляем перед ним
// (вместе с его отступом, чтобы строки снипета легли ровно).
const beforeAppEnd = (snippet) => (t) => t.replace(/([ \t]*)<\/application>/, (m, indent) => `${snippet}\n${indent}</application>`);

let xml = readFileSync(manifest, "utf8");
// Токен сессии лежит в localStorage WebView — не отдаём его в облачный бэкап Android.
xml = xml.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
if (!xml.includes('android:allowBackup="false"')) fail("Не удалось выключить allowBackup в AndroidManifest.xml");

// --- Плагины покупок и рекламы (только если их включил enable-native.mjs) ---
const nativeBuildPath = join(root, ".native-build.json");
let nb = null;
if (existsSync(nativeBuildPath)) {
  try { nb = JSON.parse(readFileSync(nativeBuildPath, "utf8")); } catch (e) { fail(`.native-build.json повреждён: ${e.message}`); }
}
const done = [];
if (nb) {
  const plugins = Array.isArray(nb.plugins) ? nb.plugins : [];
  const known = Object.values(PLUGINS);
  if (!RE.store.test(String(nb.store)) || plugins.some((p) => !known.includes(p))) fail(".native-build.json: неизвестный тип сборки или плагин.");
  // Каждый плагин из .native-build.json должен реально стоять в проекте: остаток
  // прошлой сборки (плагины потом вернули git checkout'ом) иначе дописал бы в
  // обычную сборку манифест RuStore или AdMob без их кода.
  let deps = {};
  try { deps = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies || {}; } catch (e) {}
  for (const p of plugins) {
    if (!deps[p] || !existsSync(join(root, "node_modules", ...p.split("/"), "package.json"))) {
      fail(`.native-build.json требует плагин ${p}, но его нет в package.json или node_modules: удалите mobile/.native-build.json или запустите scripts/enable-native.mjs заново.`);
    }
  }
  const has = (p) => plugins.includes(p);
  const appBuildGradle = join(androidDir, "app", "build.gradle");

  if (has(PLUGINS.rustore)) {
    // Значения пойдут в XML — ещё раз проверяем их по тем же правилам.
    const appId = String((nb.rustore && nb.rustore.appId) || "");
    const scheme = String((nb.rustore && nb.rustore.scheme) || "");
    if (!RE.rustoreAppId.test(appId) || !RE.rustoreScheme.test(scheme)) fail(".native-build.json: неверные id приложения RuStore или схема.");
    // SDK RuStore лежит в своём Maven-репозитории; без него модуль app не
    // найдёт зависимости плагина. Ставим его последним: всё остальное gradle
    // по-прежнему берёт из google() и mavenCentral().
    const repo = 'maven { url "https://nexus-external.rustore.ru/repository/maven-rustore-exposed" }';
    patchFile(join(androidDir, "build.gradle"), (t) => ensure(t, repo,
      (s) => s.replace(/(allprojects\s*\{\s*repositories\s*\{[^{}]*?)(\n[ \t]*\})/, (m, head, close) => `${head}\n        ${repo}${close}`),
      "добавить репозиторий RuStore в android/build.gradle (allprojects.repositories)"));
    // Числа и схема — строковыми ресурсами: число прямо в android:value
    // Android прочитал бы как int, а SDK ждёт строку.
    patchFile(join(androidDir, "app", "src", "main", "res", "values", "strings.xml"), (t) => ensure(t, 'name="rustore_console_app_id"',
      (s) => s.replace("</resources>", () => `    <string name="rustore_console_app_id">${appId}</string>\n    <string name="rustore_pay_scheme">${scheme}</string>\n</resources>`),
      "добавить строки RuStore в strings.xml"));
    xml = ensure(xml, 'android:name="console_app_id_value"', beforeAppEnd(
      '        <meta-data android:name="console_app_id_value" android:value="@string/rustore_console_app_id" />\n' +
      '        <meta-data android:name="sdk_pay_scheme_value" android:value="@string/rustore_pay_scheme" />'),
      "добавить meta-data RuStore в AndroidManifest.xml");
    // Возврат из приложения банка (СБП, SberPay) — deeplink в MainActivity.
    xml = ensure(xml, `android:scheme="${scheme}"`, (s) => {
      const at = s.indexOf('android:name=".MainActivity"');
      const end = at < 0 ? -1 : s.indexOf("</activity>", at);
      if (end < 0) return s;
      const filter =
        "    <intent-filter>\n" +
        '                <action android:name="android.intent.action.VIEW" />\n' +
        '                <category android:name="android.intent.category.DEFAULT" />\n' +
        '                <category android:name="android.intent.category.BROWSABLE" />\n' +
        `                <data android:scheme="${scheme}" />\n` +
        "            </intent-filter>\n\n        ";
      return s.slice(0, end) + filter + s.slice(end);
    }, "добавить intent-filter со схемой RuStore в MainActivity");
    done.push(`RuStore (приложение ${appId}, схема ${scheme})`);
  }

  if (has(PLUGINS.admob)) {
    const appId = String((nb.admob && nb.admob.appId) || "");
    // Без id приложения Google Mobile Ads SDK роняет приложение при запуске.
    if (!RE.admobAppId.test(appId)) fail(".native-build.json: нет или неверный id приложения AdMob — без него приложение упадёт при запуске.");
    xml = ensure(xml, 'android:name="com.google.android.gms.ads.APPLICATION_ID"', beforeAppEnd(
      `        <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="${appId}" />`),
      "добавить id приложения AdMob в AndroidManifest.xml");
    // У плагина по умолчанию плавающая версия SDK (25.4.+) — фиксируем.
    patchFile(join(androidDir, "variables.gradle"), (t) => ensure(t, "playServicesAdsVersion",
      (s) => s.replace(/ext\s*\{/, (m) => `${m}\n    playServicesAdsVersion = '25.4.0'`),
      "задать playServicesAdsVersion в android/variables.gradle"));
    done.push(`AdMob (${appId})`);
  }

  if (has(PLUGINS.yandex) || has(PLUGINS.admob)) {
    // SDK Яндекса приносит проверку lint, которая валит релизную сборку
    // (lintVitalRelease), как только выходит его новая версия.
    patchFile(appBuildGradle, (t) => ensure(t, "YandexAdsSdkOutdatedVersion",
      (s) => s.replace(/\s*$/, "") + "\n\n// Реклама: см. mobile/scripts/patch-android.mjs\nandroid {\n    lint {\n        disable.add('YandexAdsSdkOutdatedVersion')\n    }\n}\n",
      "отключить проверку YandexAdsSdkOutdatedVersion в app/build.gradle"));
    // Рекламные SDK большие: gradle по умолчанию не хватает памяти на dex.
    patchFile(join(androidDir, "gradle.properties"), (t) => ensure(t, "org.gradle.jvmargs=-Xmx4g",
      (s) => /^org\.gradle\.jvmargs=.*$/m.test(s) ? s.replace(/^org\.gradle\.jvmargs=.*$/m, "org.gradle.jvmargs=-Xmx4g") : s.replace(/\s*$/, "") + "\norg.gradle.jvmargs=-Xmx4g\n",
      "задать org.gradle.jvmargs в gradle.properties"));
    done.push("настройки сборки для рекламы");
  }
}

writeFileSync(manifest, xml);
console.log("AndroidManifest.xml: allowBackup=false");
if (nb) console.log(`Сборка ${nb.store}: ${done.length ? done.join("; ") : "дополнительных правок нет"}`);
