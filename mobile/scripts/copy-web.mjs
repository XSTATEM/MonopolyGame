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

const serverUrl = (process.env.TM_SERVER_URL || "").trim().replace(/\/+$/, "");
if (serverUrl) {
  if (!/^https:\/\//.test(serverUrl)) {
    console.error("TM_SERVER_URL должен начинаться с https:// (Android запрещает незащищённые запросы).");
    process.exit(1);
  }
  const indexPath = join(dest, "index.html");
  const html = readFileSync(indexPath, "utf8");
  const tag = `<script>window.TM_SERVER_URL=${JSON.stringify(serverUrl)};</script>\n<script src="/native.js"></script>`;
  if (!html.includes('<script src="/native.js"></script>')) {
    console.error("В index.html не найдено подключение /native.js — некуда вставить адрес сервера.");
    process.exit(1);
  }
  writeFileSync(indexPath, html.replace('<script src="/native.js"></script>', tag));
}
console.log(`Веб-клиент скопирован в ${dest}${serverUrl ? ` (сервер: ${serverUrl})` : ""}`);
