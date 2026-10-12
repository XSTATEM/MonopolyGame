// Копирует веб-клиент из server/public в mobile/www (webDir Capacitor) и
// прописывает адрес онлайн-сервера, к которому подключается приложение.
//
//   TM_SERVER_URL=https://my-server.example node scripts/copy-web.mjs
//
// Без переменной используется продакшн-сервер (см. DEFAULT_SERVER в native.js).
// Для сборок с покупками и рекламой (TM_STORE, TM_YANDEX_REWARDED_ID,
// TM_ADMOB_REWARDED_ID — см. enable-native.mjs) сюда же пишется window.TM_BUILD;
// в обычной сборке этого тега нет.
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFlavor, webBuildInfo, checkNativeBuild } from "./build-flavor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "server", "public");
const dest = join(here, "..", "www");

if (!existsSync(join(src, "index.html"))) {
  console.error(`Не найден веб-клиент: ${src}`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
// Service worker в нативной оболочке не нужен: файлы и так лежат в приложении.
cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith("sw.js") });

// Адрес сервера — только https-origin без пути, параметров и якоря: значение
// попадает внутрь <script>, и всё лишнее (например, "</script>") недопустимо.
let serverUrl = "";
const rawUrl = (process.env.TM_SERVER_URL || "").trim();
if (rawUrl) {
  let parsed = null;
  try { parsed = new URL(rawUrl); } catch (e) {}
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password
      || !["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash) {
    console.error("TM_SERVER_URL должен быть адресом вида https://host[:port] без пути и параметров (Android запрещает незащищённые запросы).");
    process.exit(1);
  }
  serverUrl = parsed.origin;
}

// Что включено в сборку: только значения, прошедшие проверку build-flavor.mjs
// (те же регулярные выражения, что в enable-native.mjs).
const flavor = readFlavor();
// Плагины ставит enable-native.mjs по тем же переменным и записывает в
// .native-build.json: веб-слой должен совпадать с ними (локальная сборка без
// тех же переменных иначе дала бы APK с чужим набором покупок).
let nativeBuild = null;
const nativeBuildPath = join(here, "..", ".native-build.json");
if (existsSync(nativeBuildPath)) {
  try { nativeBuild = JSON.parse(readFileSync(nativeBuildPath, "utf8")); }
  catch (e) { flavor.errors.push(`.native-build.json повреждён (${e.message}) — удалите его или запустите enable-native.mjs заново.`); }
}
const nb = checkNativeBuild(flavor, nativeBuild);
flavor.warnings.push(...nb.warnings);
flavor.errors.push(...nb.errors);
flavor.warnings.forEach((w) => console.warn("Внимание: " + w));
if (flavor.errors.length) {
  flavor.errors.forEach((e) => console.error("Ошибка: " + e));
  process.exit(1);
}
const build = webBuildInfo(flavor);

// JSON внутри <script>: «<» экранируется, чтобы строка не закрыла тег.
const inline = (name, value) => `<script>window.${name}=${JSON.stringify(value).replace(/</g, "\\u003c")};</script>\n`;
let tags = "";
if (serverUrl) tags += inline("TM_SERVER_URL", serverUrl);
if (build) tags += inline("TM_BUILD", build);
if (tags) {
  const indexPath = join(dest, "index.html");
  const html = readFileSync(indexPath, "utf8");
  const needle = '<script src="/native.js"></script>';
  if (!html.includes(needle)) {
    console.error("В index.html не найдено подключение /native.js — некуда вставить настройки сборки.");
    process.exit(1);
  }
  // Функция вместо строки: в строке замены `$'` и `$&` — спецшаблоны.
  writeFileSync(indexPath, html.replace(needle, () => tags + needle));
}
const notes = [];
if (serverUrl) notes.push(`сервер: ${serverUrl}`);
if (build) notes.push(`сборка: ${JSON.stringify(build)}`);
console.log(`Веб-клиент скопирован в ${dest}${notes.length ? ` (${notes.join("; ")})` : ""}`);
