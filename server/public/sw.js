// Service worker: офлайн-оболочка приложения (PWA).
// Всё своё — «сначала сеть, без сети — кеш»: пока есть связь, игрок всегда
// получает согласованные index.html, engine.js и styles.css одной версии
// (при stale-while-revalidate новая страница могла бы встретиться со старым
// скриптом), а без сети офлайн-партия (хот-сит с ботами) открывается из кеша.
// /api/* и WebSocket не кешируются.
const VERSION = "tm-2026-10-13-ui-kit";
const CACHE = `shell-${VERSION}`;
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/engine.js",
  "/skins.js",
  "/native.js",
  "/anim.js",
  "/ui-kit.js",
  "/tutorial.js",
  "/shop.js",
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
  // Логотипы компаний (logos/, собирает tools/logos/build-logos.mjs) — чтобы
  // офлайн-партия шла с логотипами. Список должен совпадать с LOGO_FILES в
  // index.html и файлами в logos/ — это проверяет test/check.js.
  "/logos/AAPL.svg", "/logos/MSFT.svg", "/logos/GOOGL.svg", "/logos/NVDA.svg",
  "/logos/IBM.png", "/logos/INTC.svg", "/logos/SONY.svg", "/logos/AMZN.png",
  "/logos/DIS.png", "/logos/NFLX.svg", "/logos/META.svg", "/logos/YDEX.png",
  "/logos/VKCO.svg", "/logos/MCD.svg", "/logos/NKE.svg", "/logos/KO.svg", "/logos/WMT.png",
  "/logos/PEP.svg", "/logos/SBUX.svg", "/logos/RKT.png", "/logos/ADS.svg", "/logos/BA.svg",
  "/logos/TSLA.svg", "/logos/MMM.svg", "/logos/AFLT.svg", "/logos/F.svg", "/logos/V.svg",
  "/logos/SBER.svg", "/logos/GAZP.png", "/logos/MGNT.png", "/logos/MTSS.png",
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
    // Игру отдаём из копии "/index.html" — её обновляет каждый онлайн-заход.
    // Запись "/" (и start_url "/?source=pwa") остаётся со времени установки и
    // разошлась бы с уже обновлёнными engine.js и styles.css.
    const fromCache = () => isGame
      ? caches.match("/index.html").then((hit) => hit || caches.match(req, { ignoreSearch: true }))
      : caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("/index.html"));
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && isGame) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/index.html", copy)).catch(() => {}); }
          // 5xx (nginx 502/504, пока перезапускается Node, страница ошибки
          // хостинга) — открываем игру из кеша: офлайн-партия работает без сервера.
          if (res.status >= 500 && isGame) return fromCache().then((hit) => hit || res);
          return res;
        })
        .catch(() => fromCache())
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        // Без этого страница, открытая из кеша при 5xx, осталась бы без своих
        // скриптов и стилей (сервер отвечает 502 и на них).
        if (res.status >= 500) return caches.match(req, { ignoreSearch: true }).then((hit) => hit || res);
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
