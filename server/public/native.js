// Мост к нативной оболочке (Capacitor, папка mobile/). В обычном браузере
// всё здесь — безопасные пустышки, поэтому файл подключается всегда.
//
// В нативном приложении страница открывается с https://localhost (Android)
// или capacitor://localhost (iOS), а онлайн-сервер живёт отдельно — его адрес
// берётся из window.TM_SERVER_URL, которое пишет скрипт сборки
// mobile/scripts/copy-web.mjs (по умолчанию — продакшн на Render). Переопределять
// его из localStorage нельзя: туда уходят пароли и токены сессий.
//
// Покупки и реклама (TMNative.store, billing, ads — см. shop.js и
// docs/MONETIZATION-SPEC.md, §9): плагины магазинов и рекламы попадают только в
// сборки, где их включили (mobile/scripts/enable-native.mjs). В браузере и в
// сборке по умолчанию их нет — billing и ads «недоступны», и магазин их не
// показывает. Очки и покупки начисляет только сервер после своей проверки.
(function(){
  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
  var plugins = isNative ? (cap.Plugins || {}) : {};
  var DEFAULT_SERVER = "https://birzha-multiplayer.onrender.com";

  // Что включено в эту сборку, пишет mobile/scripts/copy-web.mjs (window.TM_BUILD).
  // В обычном браузере и в сборке по умолчанию объекта нет.
  var BUILD = (isNative && window.TM_BUILD && typeof window.TM_BUILD === "object") ? window.TM_BUILD : {};
  var STORES = { direct: 1, rustore: 1, googleplay: 1 };
  var store = isNative ? (Object.prototype.hasOwnProperty.call(STORES, BUILD.store) ? BUILD.store : "direct") : "web";
  function pluginAvailable(name){
    return !!(isNative && typeof cap.isPluginAvailable === "function" && cap.isPluginAvailable(name) && plugins[name]);
  }
  // Вызов метода плагина всегда как промис: синхронное исключение (метода нет
  // в старой версии плагина) превращается в отказ, а не роняет вызывающего.
  function callPlugin(name, method, args){
    try {
      var pl = plugins[name];
      if(!pl || typeof pl[method] !== "function") return Promise.reject(new Error(name + "." + method + " недоступен"));
      return Promise.resolve(pl[method](args));
    } catch(e){ return Promise.reject(e); }
  }

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

  // --- Внешние ссылки и возврат в приложение ------------------------------
  // Страница оплаты ЮKassa: только https. В приложении — плагин Browser, если
  // он есть в сборке, иначе переход WebView на чужой хост (Capacitor отдаёт
  // его системному браузеру); в браузере — обычный переход.
  function httpsHref(url){
    try { var u = new URL(String(url)); return u.protocol === "https:" ? u.href : ""; } catch(e){ return ""; }
  }
  // Страница оплаты ЮKassa в сборке для Google Play не открывается никогда
  // (правила Google Play), даже если её прислал неверно настроенный сервер.
  var PAY_HOST_RE = /(^|\.)(yoomoney|yookassa)\.ru$/i;
  function openExternal(url){
    var href = httpsHref(url);
    if(!href) return false;
    if(store === "googleplay"){
      try { if(PAY_HOST_RE.test(new URL(href).hostname)) return false; } catch(e){ return false; }
    }
    if(!isNative){ location.assign(href); return true; }
    if(pluginAvailable("Browser")){
      callPlugin("Browser", "open", { url: href }).catch(function(){ location.href = href; });
    } else {
      location.href = href;
    }
    return true;
  }
  // Игрок вернулся в приложение (из браузера с оплатой, из другого
  // приложения). Подписка на событие — только при первом onResume.
  var resumeCallbacks = null;
  function fireResume(){
    resumeCallbacks.slice().forEach(function(cb){ try { cb(); } catch(e){ console.error(e); } });
  }
  function onResume(cb){
    if(typeof cb !== "function") return;
    if(!resumeCallbacks){
      resumeCallbacks = [];
      if(isNative && plugins.App && plugins.App.addListener){
        plugins.App.addListener("appStateChange", function(s){ if(s && s.isActive) fireResume(); });
      } else {
        document.addEventListener("visibilitychange", function(){ if(document.visibilityState === "visible") fireResume(); });
      }
    }
    resumeCallbacks.push(cb);
  }
  // Отмену покупки игроком магазин показывает тихо: RuStorePay отклоняет с
  // code "cancelled", NativePurchases (Google Play) — с code "USER_CANCELED"
  // (текст ошибки там «Purchase is not purchased», слова cancel в нём нет).
  function isCancel(e){
    return !!e && (e.code === "cancelled" || /cancel/i.test(String(e.code || "")) || /cancel/i.test(String(e.message || e)));
  }
  function cancelledError(){ var e = new Error("cancelled"); e.code = "cancelled"; return e; }

  // --- Покупки в магазине приложений --------------------------------------
  // RuStore — свой плагин RuStorePay (mobile/native/rustore-pay), Google Play —
  // @capgo/native-purchases. Подходящий плагин должен быть в сборке и
  // совпадать с её типом (TM_BUILD.store).
  var billingProvider = (store === "rustore" && pluginAvailable("RuStorePay")) ? "rustore"
    : (store === "googleplay" && pluginAvailable("NativePurchases")) ? "googleplay" : null;
  // RuStore Pay может быть недоступен на устройстве (нет RuStore, регион и т. п.):
  // узнаём один раз при запуске, и тогда магазин покажет «Скоро» или другие способы
  // оплаты, а не кнопку, которая упадёт уже после нажатия.
  var billingUsable = true;
  if(billingProvider === "rustore"){
    callPlugin("RuStorePay", "isAvailable", {}).then(function(r){
      if(!r || r.available !== false) return;
      billingUsable = false;
      console.warn("RuStore Pay недоступен: " + String(r.reason || "без причины"));
      if(window.Shop && typeof window.Shop.render === "function") window.Shop.render();
    }, function(){});
  }
  var billing = {
    provider: billingProvider,
    isAvailable: function(){ return !!billingProvider && billingUsable; },
    // Цены из консоли магазина: { [id]: { priceText } }. Ошибка — пустой объект
    // (кнопка покупки тогда просто без цены).
    getProducts: function(ids){
      ids = (ids || []).filter(function(id){ return typeof id === "string" && id; });
      if(!billingProvider || !ids.length) return Promise.resolve({});
      var out = {};
      var p = billingProvider === "rustore"
        ? callPlugin("RuStorePay", "getProducts", { productIds: ids }).then(function(r){
            ((r && r.products) || []).forEach(function(x){
              if(x && x.productId && x.amountLabel) out[String(x.productId)] = { priceText: String(x.amountLabel) };
            });
            return out;
          })
        : callPlugin("NativePurchases", "getProducts", { productIdentifiers: ids, productType: "inapp" }).then(function(r){
            ((r && r.products) || []).forEach(function(x){
              if(x && x.identifier && x.priceString) out[String(x.identifier)] = { priceText: String(x.priceString) };
            });
            return out;
          });
      return p.catch(function(){ return {}; });
    },
    // Покупка: { provider, productId, purchaseToken, sandbox }. Токен — номер
    // счёта RuStore или purchaseToken Google; проверяет его сервер (/api/shop/verify).
    // Подтверждение/списание покупки в Google делает тоже сервер — поэтому
    // autoAcknowledgePurchases:false и isConsumable:false.
    purchase: function(storeProductId, opts){
      opts = opts || {};
      if(!billingProvider) return Promise.reject(new Error("Покупки недоступны в этой сборке."));
      var fail = function(e){
        if(isCancel(e)) throw cancelledError();
        // Google Play: оплата отложена (наличные и т. п.) — покупку потом
        // подхватит pending() при запуске, когда платёж пройдёт.
        if(e && !e.code && /^Purchase is pending/i.test(String(e.message || ""))){
          var p = new Error("Платёж ещё не завершён — покупка появится автоматически после оплаты.");
          p.code = "pending";
          throw p;
        }
        throw e;
      };
      if(billingProvider === "rustore"){
        return callPlugin("RuStorePay", "purchase", { productId: storeProductId, orderId: opts.orderId, appUserId: opts.userId })
          .then(function(r){
            if(!r || r.invoiceId == null || r.invoiceId === "") throw new Error("RuStore не вернул номер счёта.");
            return { provider: "rustore", productId: String(r.productId || storeProductId), purchaseToken: String(r.invoiceId), sandbox: !!r.sandbox };
          }, fail);
      }
      return callPlugin("NativePurchases", "purchaseProduct", {
        productIdentifier: storeProductId, productType: "inapp", appAccountToken: opts.userId,
        isConsumable: false, autoAcknowledgePurchases: false,
      }).then(function(t){
        if(!t || !t.purchaseToken) throw new Error("Google Play не вернул токен покупки.");
        return { provider: "googleplay", productId: String(t.productIdentifier || storeProductId), purchaseToken: String(t.purchaseToken), sandbox: false };
      }, fail);
    },
    // Оплаченные, но, возможно, не зачисленные покупки (приложение закрылось
    // до ответа сервера): [{ productId, purchaseToken, sandbox }]. Ошибка — [].
    // restorePurchases() у NativePurchases не зовём: он может сам подтвердить покупку.
    pending: function(){
      if(!billingProvider) return Promise.resolve([]);
      var p = billingProvider === "rustore"
        ? callPlugin("RuStorePay", "getPurchases", {}).then(function(r){
            return ((r && r.purchases) || []).filter(function(x){ return x && x.invoiceId != null && x.productId; })
              .map(function(x){ return { productId: String(x.productId), purchaseToken: String(x.invoiceId), sandbox: !!x.sandbox }; });
          })
        : callPlugin("NativePurchases", "getPurchases", { productType: "inapp" }).then(function(r){
            // purchaseState "2" — Purchase.PurchaseState.PENDING (ещё не оплачена):
            // такую проверим при следующем запуске, когда оплата пройдёт.
            return ((r && r.purchases) || []).filter(function(x){ return x && x.purchaseToken && x.productIdentifier && String(x.purchaseState) !== "2"; })
              .map(function(x){ return { productId: String(x.productIdentifier), purchaseToken: String(x.purchaseToken), sandbox: false }; });
          });
      return p.catch(function(){ return []; });
    },
  };

  // --- Видео с наградой ----------------------------------------------------
  // Яндекс (YandexRewarded) — в сборках direct и rustore, AdMob — только в
  // googleplay; никогда оба сразу. id блока — из TM_BUILD, с той же проверкой,
  // что в скриптах сборки. Плагин сообщает лишь «досмотрел/нет»: очки даёт
  // сервер по одноразовому билету (POST /api/ads/reward).
  var YANDEX_UNIT_RE = /^(demo-rewarded-yandex|R-M-\d+-\d+)$/;
  var ADMOB_UNIT_RE = /^ca-app-pub-\d{16}\/\d{10}$/;
  var adsProvider = null, adUnit = "";
  if((store === "direct" || store === "rustore") && YANDEX_UNIT_RE.test(String(BUILD.yandexRewarded || "")) && pluginAvailable("YandexRewarded")){
    adsProvider = "yandex"; adUnit = String(BUILD.yandexRewarded);
  } else if(store === "googleplay" && ADMOB_UNIT_RE.test(String(BUILD.admobRewarded || "")) && pluginAvailable("AdMob")){
    adsProvider = "admob"; adUnit = String(BUILD.admobRewarded);
  }
  var adsBlocked = false;  // AdMob: по согласию (UMP) рекламу запрашивать нельзя
  var adShowing = false;
  var admobReady = null;   // initialize + согласие — один раз за запуск
  // UMP: игроку из ЕЭЗ/Великобритании нужна постоянная кнопка, чтобы изменить
  // согласие на рекламу (privacyOptionsRequirementStatus === "REQUIRED").
  var privacyRequired = false;
  function noteConsent(info){
    if(info && typeof info.privacyOptionsRequirementStatus === "string") privacyRequired = info.privacyOptionsRequirementStatus === "REQUIRED";
    if(info && info.canRequestAds === false) adsBlocked = true;
    else if(info && info.canRequestAds === true) adsBlocked = false;
    return info;
  }
  function admobPrepare(){
    if(!admobReady){
      admobReady = callPlugin("AdMob", "initialize", {})
        .then(function(){ return callPlugin("AdMob", "requestConsentInfo", {}); })
        .then(function(info){
          noteConsent(info);
          if(info && info.status === "REQUIRED" && info.isConsentFormAvailable) return callPlugin("AdMob", "showConsentForm").then(noteConsent);
          return info;
        })
        .then(function(info){
          if(info && info.canRequestAds === false){ adsBlocked = true; throw new Error("Реклама недоступна без согласия."); }
        });
      // Сбой (нет сети) — в следующий раз попробуем снова.
      admobReady.catch(function(){ admobReady = null; });
    }
    return admobReady;
  }
  // Форма «Настройки рекламы» (UMP) и свежий статус согласия после неё.
  function admobPrivacyOptions(){
    return callPlugin("AdMob", "showPrivacyOptionsForm", {})
      .then(function(){ return callPlugin("AdMob", "requestConsentInfo", {}); })
      .then(function(info){
        noteConsent(info);
        // Согласие могли дать или отозвать — магазин покажет или скроет видео.
        if(window.Shop && typeof window.Shop.render === "function") window.Shop.render();
        return info;
      });
  }
  // Показ видео может не вернуть события (WebView перезагрузили, пока открыт
  // экран рекламы): без срока кнопка видео висела бы «занятой» до перезапуска.
  function withTimeout(p, ms, message){
    return new Promise(function(resolve, reject){
      var t = setTimeout(function(){ reject(new Error(message)); }, ms);
      p.then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
    });
  }
  function admobShow(nonce, userId){
    return admobPrepare().then(function(){
      return new Promise(function(resolve, reject){
        var earned = false, done = false, timer = null, handles = [];
        function finish(err){
          if(done) return;
          done = true;
          if(timer) clearTimeout(timer);
          handles.forEach(function(h){ Promise.resolve(h).then(function(x){ if(x && x.remove) x.remove(); }).catch(function(){}); });
          if(err && !earned) reject(err); else resolve({ rewarded: earned });
        }
        function on(ev, fn){ try { handles.push(plugins.AdMob.addListener(ev, fn)); } catch(e){} }
        on("onRewardedVideoAdReward", function(){ earned = true; });
        on("onRewardedVideoAdDismissed", function(){ finish(null); });
        on("onRewardedVideoAdFailedToShow", function(e){ finish(new Error((e && e.message) || "Видео не показалось.")); });
        // ssv: подписанный колбэк Google на сервер (/api/ads/admob-ssv) несёт
        // user_id и custom_data = одноразовый билет сервера.
        callPlugin("AdMob", "prepareRewardVideoAd", { adId: adUnit, ssv: { userId: String(userId || ""), customData: String(nonce || "") } })
          .then(function(){
            // Ждём закрытия видео, но не дольше 120 с (событие могло потеряться).
            timer = setTimeout(function(){ finish(null); }, 120000);
            return callPlugin("AdMob", "showRewardVideoAd");
          })
          .then(function(item){ if(item && typeof item.amount === "number") earned = true; }, function(e){ finish(e); });
      });
    });
  }
  function yandexShow(){
    return withTimeout(callPlugin("YandexRewarded", "load", { adUnitId: adUnit }), 30000, "Видео не загрузилось.")
      .then(function(){ return withTimeout(callPlugin("YandexRewarded", "show", {}), 180000, "Видео не ответило."); })
      .then(function(r){ return { rewarded: !!(r && r.rewarded) }; });
  }
  var ads = {
    provider: adsProvider,
    adUnit: adUnit,
    isAvailable: function(){ return !!adsProvider && !adsBlocked; },
    // { rewarded: boolean }; ошибка загрузки/показа — отказ промиса.
    showRewarded: function(opts){
      opts = opts || {};
      if(!ads.isAvailable()) return Promise.reject(new Error("Видео недоступно в этой сборке."));
      if(adShowing) return Promise.reject(new Error("Видео уже показывается."));
      adShowing = true;
      var p = adsProvider === "admob" ? admobShow(opts.nonce, opts.userId) : yandexShow();
      return p.then(function(r){ adShowing = false; return r; }, function(e){ adShowing = false; throw e; });
    },
    // AdMob: нужна ли кнопка «Настройки рекламы» (UMP требует её для ЕЭЗ/Великобритании).
    privacyOptionsRequired: function(){ return adsProvider === "admob" && privacyRequired; },
    showPrivacyOptions: function(){
      if(adsProvider !== "admob") return Promise.reject(new Error("Настройки рекламы недоступны в этой сборке."));
      return admobPrivacyOptions();
    },
  };
  // Согласие на рекламу (UMP) спрашиваем при запуске, как советует Google:
  // форма появится сразу, где она нужна, а кнопка «Настройки рекламы» — в настройках.
  if(adsProvider === "admob"){
    window.addEventListener("load", function(){
      var rerender = function(){ if(window.Shop && typeof window.Shop.render === "function") window.Shop.render(); };
      admobPrepare().then(rerender, rerender);
    });
  }

  var TMNative = {
    isNative: isNative,
    serverOrigin: serverOrigin,
    // "web" | "direct" | "rustore" | "googleplay" — сервер по нему решает,
    // какие способы оплаты и рекламу предложить (каталог /api/shop/catalog).
    store: store,
    openExternal: openExternal,
    onResume: onResume,
    billing: billing,
    ads: ads,
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
