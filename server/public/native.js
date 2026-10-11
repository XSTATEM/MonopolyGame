// Мост к нативной оболочке (Capacitor, папка mobile/). В обычном браузере
// всё здесь — безопасные пустышки, поэтому файл подключается всегда.
//
// В нативном приложении страница открывается с https://localhost (Android)
// или capacitor://localhost (iOS), а онлайн-сервер живёт отдельно — его адрес
// берётся из window.TM_SERVER_URL, которое пишет скрипт сборки
// mobile/scripts/copy-web.mjs (по умолчанию — продакшн на Render). Переопределять
// его из localStorage нельзя: туда уходят пароли и токены сессий.
(function(){
  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
  var plugins = isNative ? (cap.Plugins || {}) : {};
  var DEFAULT_SERVER = "https://birzha-multiplayer.onrender.com";

  var serverOrigin = "";
  if(isNative){
    serverOrigin = DEFAULT_SERVER;
    try {
      var u = new URL(String(window.TM_SERVER_URL || DEFAULT_SERVER));
      if(u.protocol === "https:") serverOrigin = u.origin;
    } catch(e){}
  }

  // Экран не гаснет, пока идёт партия (Screen Wake Lock API — есть и в
  // Android WebView, и в мобильном Chrome; там, где нет, просто ничего не делаем).
  var wakeLock = null, wantWake = false;
  function syncWakeLock(){
    if(!("wakeLock" in navigator)) return;
    if(wantWake && document.visibilityState === "visible" && !wakeLock){
      navigator.wakeLock.request("screen").then(function(l){
        wakeLock = l;
        l.addEventListener("release", function(){ wakeLock = null; });
      }).catch(function(){});
    } else if(!wantWake && wakeLock){
      wakeLock.release().catch(function(){});
      wakeLock = null;
    }
  }
  document.addEventListener("visibilitychange", syncWakeLock);

  function setBarsStyle(dark){
    // Capacitor 8: системные панели через встроенный SystemBars; на старых
    // версиях — плагин StatusBar. "DARK" = светлые значки на тёмном фоне.
    var style = dark ? "DARK" : "LIGHT";
    [plugins.SystemBars, plugins.StatusBar].forEach(function(bars){
      if(bars && bars.setStyle){ bars.setStyle({ style: style }).catch(function(){}); }
    });
  }

  var TMNative = {
    isNative: isNative,
    serverOrigin: serverOrigin,
    // Абсолютный адрес API: в браузере — относительный путь того же сервера.
    api: function(path){ return serverOrigin + path; },
    wsUrl: function(){
      if(serverOrigin) return serverOrigin.replace(/^http/, "ws");
      return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
    },
    onScreen: function(id){
      var inGame = id === "app";
      setBarsStyle(inGame);
      wantWake = inGame;
      syncWakeLock();
    },
    haptic: function(kind){
      if(plugins.Haptics && plugins.Haptics.impact){
        plugins.Haptics.impact({ style: kind === "heavy" ? "HEAVY" : kind === "light" ? "LIGHT" : "MEDIUM" }).catch(function(){});
      } else if(navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)){
        // До первого касания страницы браузер вибрацию всё равно блокирует
        // и пишет ошибку в консоль (анимации зовут haptic и на чужих ходах).
        try { navigator.vibrate(kind === "heavy" ? 30 : 12); } catch(e){}
      }
    },
  };
  window.TMNative = TMNative;

  if(isNative){
    document.documentElement.classList.add("native");
    // Бесплатный сервер засыпает при простое: будим его сразу при запуске,
    // чтобы к нажатию «Играть онлайн» он уже отвечал.
    try { fetch(serverOrigin + "/api/rooms").catch(function(){}); } catch(e){}
    // Аппаратная кнопка «Назад» на Android: сначала закрываем модалки и
    // оверлеи (см. handleBackNavigation в index.html), иначе сворачиваем приложение.
    if(plugins.App && plugins.App.addListener){
      plugins.App.addListener("backButton", function(){
        if(typeof window.handleBackNavigation === "function" && window.handleBackNavigation()) return;
        if(plugins.App.minimizeApp) plugins.App.minimizeApp();
      });
    }
    if(plugins.SplashScreen && plugins.SplashScreen.hide){
      window.addEventListener("load", function(){ plugins.SplashScreen.hide().catch(function(){}); });
    }
  }
})();
