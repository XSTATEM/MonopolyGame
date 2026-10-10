// Копирует веб-клиент из server/public в mobile/www (webDir Capacitor) и
// прописывает адрес онлайн-сервера, к которому подключается приложение.
//
//   TM_SERVER_URL=https://my-server.example node scripts/copy-web.mjs
//
// Без переменной используется продакшн-сервер (см. DEFAULT_SERVER в native.js).
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const indexPath = join(dest, "index.html");
  const html = readFileSync(indexPath, "utf8");
  const needle = '<script src="/native.js"></script>';
  const tag = `<script>window.TM_SERVER_URL=${JSON.stringify(serverUrl).replace(/</g, "\\u003c")};</script>\n${needle}`;
  if (!html.includes(needle)) {
    console.error("В index.html не найдено подключение /native.js — некуда вставить адрес сервера.");
    process.exit(1);
  }
  // Функция вместо строки: в строке замены `$'` и `$&` — спецшаблоны.
  writeFileSync(indexPath, html.replace(needle, () => tag));
}
console.log(`Веб-клиент скопирован в ${dest}${serverUrl ? ` (сервер: ${serverUrl})` : ""}`);
