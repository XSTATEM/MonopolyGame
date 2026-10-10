// Service worker: офлайн-оболочка приложения (PWA).
// Всё своё — «сначала сеть, без сети — кеш»: пока есть связь, игрок всегда
// получает согласованные index.html, engine.js и styles.css одной версии
// (при stale-while-revalidate новая страница могла бы встретиться со старым
// скриптом), а без сети офлайн-партия (хот-сит с ботами) открывается из кеша.
// /api/* и WebSocket не кешируются.
const VERSION = "tm-2026-10-10";
const CACHE = `shell-${VERSION}`;
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/engine.js",
  "/skins.js",
  "/native.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/fonts/manrope-cyrillic-wght-normal.woff2",
  "/fonts/manrope-latin-wght-normal.woff2",
  "/fonts/manrope-latin-ext-wght-normal.woff2",
  "/fonts/jetbrains-mono-cyrillic-wght-normal.woff2",
  "/fonts/jetbrains-mono-latin-wght-normal.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // По одному, чтобы один недоступный файл не сорвал установку целиком.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    // В кеш попадает только сама игра — не калькулятор, не карточки и не
    // страница ошибки просыпающегося сервера.
    const isGame = url.pathname === "/" || url.pathname === "/index.html";
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && isGame) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/index.html", copy)).catch(() => {}); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("/index.html")))
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
