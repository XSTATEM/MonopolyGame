// ---------------------------------------------------------------------
// Магазин (window.Shop): пакеты очков, «Премиум», наборы скинов и видео с
// наградой (docs/MONETIZATION-SPEC.md, §8). Подключается из index.html после
// tutorial.js.
// - Ничего не видно, пока сервер не включил способ оплаты или рекламу для этой
//   платформы: каталог /api/shop/catalog отвечает {enabled:false}, и пункт
//   меню, «Пополнить» в скинах и «Магазин» в модалке аккаунта скрыты.
// - Клиенту сервер не доверяет: сумму платежа ЮKassa берёт из своего каталога,
//   а очки и покупки начисляет только после проверки у провайдера. Здесь —
//   витрина, запуск оплаты и опрос статуса заказа.
// - Сценарии (§8.5): сайт — переход на страницу ЮKassa и возврат на
//   /?order=<id>; приложение без магазина — оплата ЮKassa во внешнем браузере и
//   проверка при возвращении в приложение; RuStore и Google Play — покупка
//   через TMNative.billing и проверка на сервере (/api/shop/verify); mock —
//   тестовая оплата, заказ выдаётся сразу.
// Глобальные accountUser, accountSessionToken, showOnly, apiGet, accountApiPost,
// accountApiGet, showToast, escapeHtml, pointsLabel, ico объявлены позже, во
// встроенном скрипте index.html, — поэтому читаем их только внутри функций.
// ---------------------------------------------------------------------
(function(){
  "use strict";

  const LS_PENDING = "tm_pending_order";   // {id, at} — заказ ЮKassa, ушли платить
  const LS_EMAIL = "tm_receipt_email";     // последний email для чека (удобство на устройстве)
  const ORDER_RE = /^[0-9a-f-]{36}$/;
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
  const PENDING_MAX_AGE = 24 * 3600e3;
  // Опрос заказа после оплаты: каждые 2 с первую минуту, потом каждые 5 с до 10 минут.
  const POLL_FAST_MS = 2000, POLL_SLOW_MS = 5000, POLL_FAST_FOR = 60e3, POLL_MAX = 10 * 60e3;
  const CATALOG_RETRY_MS = 60e3;     // упавший каталог повторяем из меню не чаще раза в минуту
  const CATALOG_STALE_MS = 5 * 60e3; // при открытии магазина каталог старше — перечитываем
  const STORE_VERIFY_TRIES = 10, STORE_VERIFY_GAP = 3000;
  const AD_REWARD_WAIT = 15000, AD_REWARD_GAP = 1500;
  const PROVIDER_LABEL = { yookassa: "Карта или СБП", rustore: "RuStore", googleplay: "Google Play", mock: "Тестовая оплата" };
  const FAIL_PROVIDER = "Платёжная система не ответила — попробуйте ещё раз через минуту.";
  const EXTERNAL_PAY = "Завершите оплату в браузере и вернитесь в приложение.";

  let inited = false;
  let catalog = null;          // последний удачный ответ каталога; {enabled:false} — магазин выключен
  let catalogAt = 0;
  let catalogFailedAt = 0;     // запрос каталога упал (сеть, 5xx) — повторим из меню
  let catalogLoading = null;
  let provider = null;         // выбранный способ оплаты
  let storePrices = {};        // цены из консоли магазина: { storeProductId: {priceText} }
  let ent = null;              // ответ /api/shop/entitlements для accountName
  let entSeq = 0;
  let accountName = null;      // чей аккаунт сейчас учтён (смена — сброс ent)
  let storeSyncedFor = null;   // для какого аккаунта уже досылали покупки магазина
  let busy = false;            // идёт покупка или просмотр — кнопки магазина неактивны
  let poll = null;             // {id, start, timer, once} — опрос заказа ЮKassa
  let awaitLogin = null;       // заказ с возврата оплаты: ждём входа в аккаунт
  let returnOrderId = null;    // заказ из адреса возврата (/?order=…)
  let restoring = false;       // вернулись с оплаты, а сессия ещё восстанавливается
  let adTimer = null;
  let errMsg = "", statusMsg = "", showCheckBtn = false;
  let openedAt = 0;
  let highlight = null;        // {id, until} — подсветка товара, к которому привели

  // --- Мелкие помощники ----------------------------------------------------
  function byId(id){ return document.getElementById(id); }
  function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
  function lsDel(k){ try { localStorage.removeItem(k); } catch(e){} }
  function sleep(ms){ return new Promise((r)=> setTimeout(r, ms)); }
  function platform(){ return (window.TMNative && TMNative.store) || "web"; }
  function shown(id){ const el = byId(id); return !!el && !!el.style.display && el.style.display !== "none"; }
  function shopShown(){ return shown("shopScreen"); }
  function catalogOn(){ return !!(catalog && catalog.enabled); }
  function products(){ return catalogOn() && Array.isArray(catalog.products) ? catalog.products : []; }
  function productById(id){ return products().find((p)=> p && p.id === id) || null; }
  function storeIdOf(p, prov){ return (p.storeIds && p.storeIds[prov]) || p.id; }
  function isStoreProvider(p){ return p === "rustore" || p === "googleplay"; }
  // Ссылки из каталога (оферта, политика) и адрес оплаты: только https —
  // http разрешаем лишь локальному серверу разработки (как YOOKASSA_RETURN_URL).
  function safeHref(url, allowLocalHttp){
    try {
      const u = new URL(String(url || ""));
      if(u.protocol === "https:") return u.href;
      if(allowLocalHttp && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u.href;
    } catch(e){}
    return "";
  }
  function refreshAccountViews(){
    if(typeof updateAccountCornerBtn === "function") updateAccountCornerBtn();
    if(typeof refreshAccountGates === "function") refreshAccountGates();
  }
  // Кнопка по значению data-*: без подстановки значения в CSS-селектор.
  function findButton(sel, key, value){
    return Array.from(document.querySelectorAll(sel)).find((b)=> b.dataset[key] === value) || null;
  }
  function setMsg(err, status){
    errMsg = err || "";
    statusMsg = status || "";
    const e = byId("shopErr"), s = byId("shopStatus");
    if(e) e.textContent = errMsg;
    if(s) s.textContent = statusMsg;
  }

  // --- Каталог и способы оплаты ----------------------------------------------
  function loadCatalog(){
    if(catalogLoading) return catalogLoading;
    catalogLoading = Promise.resolve()
      .then(()=> apiGet("/api/shop/catalog?platform=" + encodeURIComponent(platform())))
      .catch(()=> ({ error: "network", _status: 0 }))
      .then((data)=>{
        catalogLoading = null;
        if(data && !data.error && typeof data.enabled === "boolean"){
          catalog = data.enabled ? data : { enabled: false };
          catalogAt = Date.now(); catalogFailedAt = 0;
        } else if(data && data._status === 404){
          // Сервер без магазина (старая версия) — то же, что выключенный магазин.
          catalog = { enabled: false };
          catalogAt = Date.now(); catalogFailedAt = 0;
        } else {
          catalogFailedAt = Date.now(); // прежний удачный каталог (если был) остаётся
        }
        afterCatalog();
        return catalog;
      });
    return catalogLoading;
  }
  function afterCatalog(){
    if(catalogOn()){
      loadStorePrices();
      if(accountUser){
        syncStorePurchases();
        if(shopShown() || adsAvailable()) loadEntitlements();
      }
    }
    render();
    // Кнопки, которые зависят от каталога: «Пополнить» и премиум-скины на
    // экране «Скины», «Магазин» в модалке аккаунта.
    if(shown("skinsScreen") && typeof renderSkinsScreen === "function") renderSkinsScreen();
    if(accountUser && byId("accountModalOverlay") && byId("accountModalOverlay").style.display === "flex" && typeof renderAccountModal === "function") renderAccountModal();
  }
  // Способы оплаты, доступные на этом устройстве: магазин приложений — только
  // если его плагин есть в сборке. Порядок — как в каталоге (магазин платформы первым).
  // ЮKassa в сборке для Google Play не показываем никогда (правила Google Play),
  // даже если старый или неверно настроенный сервер её пришлёт.
  function usableProviders(){
    const list = catalogOn() && Array.isArray(catalog.providers) ? catalog.providers : [];
    const billing = window.TMNative && TMNative.billing;
    return list.filter((p)=> p === "yookassa" ? platform() !== "googleplay"
      : p === "mock" || (!!billing && billing.isAvailable() && billing.provider === p));
  }
  function currentProvider(){
    const list = usableProviders();
    if(!list.includes(provider)) provider = list[0] || null;
    return provider;
  }
  function loadStorePrices(){
    const billing = window.TMNative && TMNative.billing;
    if(!billing || !billing.isAvailable() || !usableProviders().includes(billing.provider)) return;
    const ids = products().map((p)=> storeIdOf(p, billing.provider));
    billing.getProducts(ids).then((map)=>{ storePrices = map || {}; render(); }, ()=>{});
  }
  function adsAvailable(){
    const a = catalogOn() ? catalog.ads : null;
    const na = window.TMNative && TMNative.ads;
    return !!(a && a.enabled && Array.isArray(a.providers) && na && na.isAvailable() && a.providers.includes(na.provider));
  }
  // Магазину есть что показать: товары за деньги или видео с наградой на этом устройстве.
  function enabled(){ return catalogOn() && (products().length > 0 || adsAvailable()); }
  function productAvailable(id){ return !!productById(id); }

  // Нерасходуемые покупки аккаунта: из профиля (entitlements, premium) и из
  // последнего ответа /api/shop/entitlements.
  function ownedIds(){
    const set = new Set();
    if(accountUser){
      if(Array.isArray(accountUser.entitlements)) accountUser.entitlements.forEach((id)=> set.add(id));
      if(accountUser.premium) set.add("tm_premium");
    }
    if(ent && ent.entitlements && typeof ent.entitlements === "object") Object.keys(ent.entitlements).forEach((id)=> set.add(id));
    return set;
  }
  function owns(p){ return !!p && p.kind === "non-consumable" && ownedIds().has(p.id); }

  // --- Данные аккаунта для магазина (видео за сутки, история покупок) ---------
  function loadEntitlements(){
    if(!accountUser || !catalogOn()) return;
    const name = accountUser.username, seq = ++entSeq;
    accountApiGet("/api/shop/entitlements").then((data)=>{
      if(seq !== entSeq || !accountUser || accountUser.username !== name) return;
      if(data && data.ok){ ent = data; render(); }
    }, ()=>{});
  }

  // --- Отрисовка -------------------------------------------------------------
  function buyLabel(p){
    const prov = currentProvider();
    if(isStoreProvider(prov)){
      const sp = storePrices[storeIdOf(p, prov)];
      return sp && sp.priceText ? "Купить · " + sp.priceText : "Купить";
    }
    return p.price && p.price.text ? "Купить за " + p.price.text : "Купить";
  }
  function buyButtonHtml(p, cls){
    if(owns(p)) return `<button type="button" class="secondary" disabled>Куплено</button>`;
    // Товар есть, а заплатить на этом устройстве нечем (плагина магазина нет в сборке).
    if(!currentProvider()) return `<button type="button" class="secondary" disabled>Скоро</button>`;
    return `<button type="button"${cls ? ` class="${cls}"` : ""} data-product="${escapeHtml(p.id)}"${busy ? " disabled" : ""}>${escapeHtml(buyLabel(p))}</button>`;
  }
  // Что откроет набор: эмодзи аватар-паков и цвета темы стола (из skins.js).
  function previewHtml(p){
    const u = p.unlocks || {};
    const S = window.Skins;
    if(!S) return "";
    const emojis = [].concat(...(u.avatarPacks || []).map((id)=>{ const pk = S.avatarPackById(id); return pk ? pk.emojis.slice(0, 6) : []; }));
    const swatches = [].concat(...(u.boardSkins || []).map((id)=>{ const s = S.boardSkinById(id); return s ? s.stage : []; }))
      .filter((c)=> /^#[0-9a-f]{3,8}$/i.test(c));
    if(!emojis.length && !swatches.length) return "";
    return `<div class="shop-card-preview">${emojis.length ? `<span class="skin-emoji-row">${escapeHtml(emojis.join(""))}</span>` : ""}${swatches.length ? `<span class="skin-preview">${swatches.map((c)=> `<span class="skin-swatch" style="background:${c};"></span>`).join("")}</span>` : ""}</div>`;
  }
  function highlighted(id){ return !!highlight && highlight.id === id && Date.now() < highlight.until; }
  function cardHtml(p){
    const owned = owns(p);
    const icon = p.kind === "consumable" ? ico("coins", "ico-sm") : ico("palette", "ico-sm");
    return `<div class="shop-card${owned ? " owned" : ""}${highlighted(p.id) ? " shop-focus" : ""}" id="shopItem-${escapeHtml(p.id)}">
      <div class="shop-card-title">${icon}<span>${escapeHtml(p.title || p.id)}</span></div>
      ${p.subtitle ? `<div class="shop-card-sub">${escapeHtml(p.subtitle)}</div>` : ""}
      ${previewHtml(p)}
      ${buyButtonHtml(p)}
    </div>`;
  }
  function premiumHtml(p){
    const benefits = Array.isArray(catalog.premiumBenefits) ? catalog.premiumBenefits : [];
    const action = owns(p)
      ? `<div class="shop-premium-active">${ico("check", "ico-sm")} Премиум активен</div>`
      : buyButtonHtml(p, "shop-premium-buy");
    return `<div class="shop-premium-head">
        <span class="shop-premium-icon">${ico("crown")}</span>
        <div><h2 id="shopPremiumTitle">${escapeHtml(p.title || "Премиум")}</h2><div class="shop-premium-sub">Разово и навсегда</div></div>
      </div>
      ${p.subtitle && !benefits.length ? `<p class="shop-premium-text">${escapeHtml(p.subtitle)}</p>` : ""}
      ${benefits.length ? `<ul class="shop-premium-list">${benefits.map((b)=> `<li>${ico("check", "ico-sm")}<span>${escapeHtml(b)}</span></li>`).join("")}</ul>` : ""}
      ${action}`;
  }
  // Видео с наградой: лимит на сутки и пауза между видео — из /api/shop/entitlements.
  function adState(){
    const a = ent && ent.ads;
    if(!a || !a.enabled) return { text: "", blocked: false, nextAt: 0 };
    const now = Date.now();
    if(a.cap && (a.today || 0) >= a.cap) return { text: "На сегодня видео закончились — приходите завтра.", blocked: true, nextAt: 0 };
    if(a.nextAt && a.nextAt > now){
      const min = Math.max(1, Math.ceil((a.nextAt - now) / 60000));
      return { text: `Следующее видео — через ${min} мин.`, blocked: true, nextAt: a.nextAt };
    }
    return { text: `Сегодня: ${a.today || 0} из ${a.cap || 0}`, blocked: false, nextAt: 0 };
  }
  // Пока идёт пауза между видео — обновляем подпись раз в минуту и снимаем блок вовремя.
  function scheduleAdTimer(st){
    if(adTimer){ clearTimeout(adTimer); adTimer = null; }
    if(!st.nextAt || !shopShown()) return;
    const wait = Math.min(Math.max(1000, st.nextAt - Date.now() + 300), 60000);
    adTimer = setTimeout(()=>{ adTimer = null; render(); }, wait);
  }
  function historyHtml(list){
    return list.map((h)=>{
      const p = productById(h.productId);
      const title = p ? p.title : (h.points ? pointsLabel(h.points) : String(h.productId || ""));
      let date = "";
      try { date = new Date(h.at).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }); } catch(e){}
      const notes = [date, h.refundedAt ? "возврат" : "", h.test ? "тест" : ""].filter(Boolean).join(" · ");
      return `<div class="shop-history-row${h.refundedAt ? " refunded" : ""}"><span>${escapeHtml(title)}</span><span class="muted">${escapeHtml(notes)}</span></div>`;
    }).join("");
  }
  function legalHtml(){
    const legal = (catalog && catalog.legal) || {};
    const offer = safeHref(legal.offerUrl), privacy = safeHref(legal.privacyUrl);
    const links = [];
    if(offer) links.push(`<a href="${escapeHtml(offer)}" target="_blank" rel="noopener">Оферта</a>`);
    if(privacy) links.push(`<a href="${escapeHtml(privacy)}" target="_blank" rel="noopener">Политика конфиденциальности</a>`);
    return "Очки — внутриигровая валюта для косметики: на них покупаются скины. Рейтинг за деньги и рекламу не меняется."
      + (legal.seller ? `<br>${escapeHtml(legal.seller)}` : "")
      + (links.length ? `<br>${links.join(" · ")}` : "");
  }

  // Пункт «Магазин» в главном меню (разметка — в #mainMenu, см. §12).
  function updateMenuEntry(){
    const btn = byId("btnGoShop");
    if(!btn) return;
    // Обычно нажатие привязывает меню (btnGoShop.onclick → Shop.open); нет — привязываем сами.
    if(!btn.onclick && !btn.dataset.shopBound){ btn.dataset.shopBound = "1"; btn.addEventListener("click", ()=> open()); }
    const on = enabled();
    btn.hidden = !on;
    if(!on) return;
    const sub = byId("shopEntrySub");
    if(sub){
      sub.textContent = !products().length ? "Бесплатные очки за видео"
        : accountUser && accountUser.premium ? "Премиум активен · скины и очки"
        : productAvailable("tm_premium") ? "Скины, очки и Премиум" : "Скины и очки";
    }
    const bal = byId("shopEntryBalance");
    if(bal){
      bal.hidden = !accountUser;
      bal.textContent = accountUser ? pointsLabel(accountUser.points) : "";
    }
  }

  function render(){
    // Аккаунт сменился мимо onAccountChanged (например, сессия восстановилась
    // позже и refreshAccountGates позвал render) — сначала учитываем смену.
    if((accountUser ? accountUser.username : null) !== accountName){ onAccountChanged(); return; }
    updateMenuEntry();
    if(!shopShown()) return;
    byId("shopMockBanner").hidden = !(catalogOn() && catalog.mock);
    const gate = byId("shopGate"), content = byId("shopContent");
    if(!accountUser){
      gate.hidden = false; content.hidden = true;
      // Вернулись с оплаты, а сессия ещё восстанавливается (сервер медленный или
      // просыпается) — не предлагаем войти заново, а показываем, что идёт проверка.
      const checking = restoring && !!returnOrderId;
      const note = byId("shopGateNote");
      note.textContent = checking ? "Проверяем оплату…" : awaitLogin ? "Войдите в аккаунт, с которого оплачивали: покупка уже на нём." : "";
      note.hidden = !checking && !awaitLogin;
      const intro = byId("shopGateText");
      if(intro) intro.hidden = checking;
      byId("shopGateLoginBtn").hidden = checking;
      return;
    }
    gate.hidden = true; content.hidden = false;
    // Карточки пересобираются — запоминаем, на какой кнопке был фокус клавиатуры.
    const act = document.activeElement;
    const keep = act && content.contains(act) && act.dataset
      ? (act.dataset.product ? ["#shopContent [data-product]", "product", act.dataset.product]
        : act.dataset.provider ? ["#shopProviders [data-provider]", "provider", act.dataset.provider] : null)
      : null;
    byId("shopBalance").textContent = pointsLabel(accountUser.points);
    byId("shopPremiumBadge").hidden = !accountUser.premium;
    // Долг после возврата платежа (очки уже были потрачены): новые очки гасят его первыми.
    const debt = ent && Number(ent.pointsDebt) > 0 ? Math.round(Number(ent.pointsDebt)) : 0;
    const debtNote = byId("shopDebtNote");
    if(debtNote){
      debtNote.hidden = !debt;
      debtNote.textContent = debt ? `После возврата платежа на аккаунте долг ${pointsLabel(debt)}: новые очки сначала погасят его.` : "";
    }

    // Каталог ещё не пришёл, не загрузился или продавать на этой платформе нечего.
    const notice = byId("shopNotice");
    const list = products();
    let noticeText = "";
    if(!catalog) noticeText = catalogLoading ? "Загружаем магазин…" : "Не удалось загрузить магазин — проверьте интернет и откройте его ещё раз.";
    else if(!list.length && !adsAvailable()) noticeText = "Покупки скоро появятся.";
    else if(!list.length) noticeText = "Покупки за деньги скоро появятся.";
    notice.textContent = noticeText;
    notice.hidden = !noticeText;

    const prov = currentProvider();
    const provs = usableProviders();
    const provBox = byId("shopProviders");
    if(list.length && provs.length > 1){
      provBox.hidden = false;
      provBox.innerHTML = `<span class="shop-providers-label" aria-hidden="true">Способ оплаты:</span>` + provs.map((p)=>
        `<button type="button" role="radio" class="chip${p === prov ? " active" : ""}" aria-checked="${p === prov}" tabindex="${p === prov ? 0 : -1}" data-provider="${escapeHtml(p)}"${busy ? " disabled" : ""}>${escapeHtml(PROVIDER_LABEL[p] || p)}</button>`).join("");
    } else {
      provBox.hidden = true; provBox.innerHTML = "";
    }

    const prem = productById("tm_premium");
    const premBox = byId("shopPremium");
    premBox.hidden = !prem;
    premBox.innerHTML = prem ? premiumHtml(prem) : "";
    premBox.classList.toggle("shop-focus", highlighted("tm_premium"));

    const free = byId("shopFree");
    if(adsAvailable()){
      free.hidden = false;
      byId("btnRewardedAdLabel").textContent = `Смотреть видео · +${pointsLabel(catalog.ads.rewardPoints || 0)}`;
      const st = adState();
      byId("shopAdStatus").textContent = st.text;
      byId("btnRewardedAd").disabled = busy || st.blocked;
      scheduleAdTimer(st);
    } else {
      free.hidden = true;
    }

    const points = list.filter((p)=> p.kind === "consumable");
    byId("shopPointsSection").hidden = !points.length;
    byId("shopPointsSection").classList.toggle("shop-focus", highlighted("points"));
    byId("shopPoints").innerHTML = points.map(cardHtml).join("");
    const sets = list.filter((p)=> p.kind === "non-consumable" && !p.premium);
    byId("shopSetsSection").hidden = !sets.length;
    byId("shopSets").innerHTML = sets.map(cardHtml).join("");

    const emailRow = byId("shopEmailRow");
    emailRow.hidden = !(list.length && catalog.receipts && prov === "yookassa");
    const email = byId("shopEmail");
    if(!emailRow.hidden && !email.value) email.value = lsGet(LS_EMAIL) || "";

    byId("shopErr").textContent = errMsg;
    byId("shopStatus").textContent = statusMsg;
    const check = byId("shopCheckBtn");
    check.hidden = !showCheckBtn;
    check.disabled = busy;

    const hist = ent && Array.isArray(ent.purchases) ? ent.purchases : [];
    byId("shopHistory").hidden = !hist.length;
    byId("shopHistoryList").innerHTML = historyHtml(hist);
    byId("shopLegal").innerHTML = catalogOn() ? legalHtml() : "";
    if(keep){
      const again = findButton(keep[0], keep[1], keep[2]);
      if(again && again !== document.activeElement && !again.disabled) again.focus({ preventScroll: true });
    }
  }

  // Пока идёт покупка или просмотр, все кнопки магазина неактивны (как skinsBusy):
  // двойное нажатие «Купить» иначе создало бы два заказа.
  function setBusy(on){
    busy = on;
    document.querySelectorAll("#shopContent [data-product], #shopContent [data-provider], #shopCheckBtn").forEach((b)=>{ b.disabled = on; });
    const ad = byId("btnRewardedAd");
    if(ad) ad.disabled = on || adState().blocked;
  }

  // --- Открытие экрана ---------------------------------------------------------
  function open(focusId){
    const now = Date.now();
    // Один и тот же тап мог дойти двумя обработчиками (меню и магазин) — второй игнорируем.
    if(shopShown() && now - openedAt < 400) return;
    openedAt = now;
    setMsg("", "");
    showCheckBtn = false;
    showOnly("shopScreen");
    if(!catalog || now - catalogAt > CATALOG_STALE_MS) loadCatalog();
    if(accountUser){
      loadEntitlements();
      if(typeof syncAccountFromServer === "function") syncAccountFromServer(); // свежий баланс
    } else if(typeof retryRestoreSession === "function"){
      retryRestoreSession();
    }
    render();
    resumePendingPoll();
    if(focusId) focusProduct(focusId);
  }
  function focusProduct(id){
    // id товара, "tm_premium" — карточка Премиума, "points" — раздел очков («Пополнить» в скинах).
    const el = id === "tm_premium" ? byId("shopPremium") : id === "points" ? byId("shopPointsSection") : byId("shopItem-" + id);
    if(!el || el.hidden) return;
    const reduced = document.body.classList.contains("reduce-motion")
      || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if(typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    // Подсветка переживает перерисовку (render добавляет класс, пока не истекла).
    highlight = { id, until: Date.now() + 1600 };
    el.classList.add("shop-focus");
    setTimeout(()=>{
      highlight = null;
      document.querySelectorAll("#shopContent .shop-focus").forEach((x)=> x.classList.remove("shop-focus"));
    }, 1600);
    const btn = el.querySelector("button[data-product]");
    if(btn && typeof btn.focus === "function") btn.focus({ preventScroll: true });
  }

  // --- Покупка -------------------------------------------------------------------
  async function buy(productId){
    if(busy || !accountUser) return;
    const p = productById(productId);
    const prov = currentProvider();
    if(!p || !prov || owns(p)) return;
    setMsg("", "");
    let email = "";
    if(prov === "yookassa" && catalog.receipts){
      const input = byId("shopEmail");
      email = (input.value || "").trim();
      if(!email || email.length > 254 || !EMAIL_RE.test(email)){
        setMsg("Укажите email — на него придёт чек.", "");
        input.focus();
        return;
      }
      lsSet(LS_EMAIL, email);
    }
    setBusy(true);
    let leaving = false;
    try {
      if(prov === "yookassa") leaving = await buyYookassa(p, email);
      else if(prov === "mock") await buyMock(p);
      else await buyInStore(p, prov);
    } catch(e){
      console.error(e);
      setMsg("Не удалось провести покупку — попробуйте ещё раз.", "");
    } finally {
      // Ушли на страницу оплаты — кнопки остаются неактивными до ухода со страницы.
      if(!leaving){
        setBusy(false);
        render();
        // Карточки пересобраны — возвращаем фокус на кнопку того же товара.
        const again = findButton("#shopContent [data-product]", "product", productId);
        if(again && (!document.activeElement || document.activeElement === document.body)) again.focus();
      }
    }
  }
  function orderError(data){
    setMsg(data.error || FAIL_PROVIDER, "");
    // Уже куплено (например, на другом устройстве) — подтягиваем аккаунт, кнопка станет «Куплено».
    if(data.code === "already_owned"){
      if(typeof refreshAccountUser === "function") refreshAccountUser();
      loadEntitlements();
    }
  }
  function savePending(id){ lsSet(LS_PENDING, JSON.stringify({ id, at: Date.now() })); }
  function readPending(){
    try {
      const v = JSON.parse(lsGet(LS_PENDING) || "null");
      if(v && typeof v.id === "string" && ORDER_RE.test(v.id) && typeof v.at === "number") return v;
    } catch(e){}
    return null;
  }
  function clearPending(id){
    const v = readPending();
    if(!id || !v || v.id === id) lsDel(LS_PENDING);
  }
  // A/B. ЮKassa: заказ на сервере → страница оплаты. Возвращает true, если
  // страница уходит на оплату (кнопки не разблокируем).
  async function buyYookassa(p, email){
    const body = { productId: p.id, provider: "yookassa", platform: platform() };
    if(email) body.email = email;
    const data = await accountApiPost("/api/shop/order", body);
    if(data.error || !data.orderId || !ORDER_RE.test(String(data.orderId))){ orderError(data); return false; }
    const web = platform() === "web";
    const url = safeHref(data.confirmationUrl, web);
    if(!url){ setMsg(FAIL_PROVIDER, ""); return false; }
    savePending(data.orderId);
    if(web){
      setMsg("", "Переходим на страницу оплаты…");
      location.assign(url);
      return true;
    }
    // Приложение: платим во внешнем браузере, проверяем при возвращении (onResume).
    if(!TMNative.openExternal(url)){ setMsg(FAIL_PROVIDER, ""); return false; }
    showCheckBtn = true;
    startPoll(data.orderId, { status: EXTERNAL_PAY });
    return false;
  }
  // D. Тестовая оплата: сервер выдаёт заказ сразу.
  async function buyMock(p){
    const data = await accountApiPost("/api/shop/order", { productId: p.id, provider: "mock", platform: platform() });
    if(data.error || !data.orderId){ orderError(data); return; }
    if(data.status === "granted") onGranted(data, p, false);
    else startPoll(data.orderId, {});
  }
  // C. RuStore и Google Play: заказ → покупка в магазине → проверка на сервере.
  async function buyInStore(p, prov){
    const order = await accountApiPost("/api/shop/order", { productId: p.id, provider: prov, platform: platform() });
    if(order.error || !order.orderId){ orderError(order); return; }
    let r;
    try {
      r = await TMNative.billing.purchase(order.storeProductId || storeIdOf(p, prov), { orderId: order.orderId, userId: order.billingUserId });
    } catch(e){
      if(e && e.code === "cancelled") return; // игрок передумал — молча
      // Оплата отложена (Google: наличными и т. п.) — зачислим при следующем запуске (досылка).
      if(e && e.code === "pending"){ setMsg("", "Платёж ещё не завершён — покупка появится автоматически после оплаты."); return; }
      console.warn("billing:", e && e.message);
      setMsg("Магазин не провёл покупку — попробуйте ещё раз.", "");
      return;
    }
    if(!r || !r.purchaseToken){ setMsg("Магазин не провёл покупку — попробуйте ещё раз.", ""); return; }
    await verifyStorePurchase({ provider: prov, productId: p.id, purchaseToken: r.purchaseToken, orderId: order.orderId, sandbox: !!r.sandbox }, p);
  }
  async function verifyStorePurchase(body, p){
    setMsg("", "Проверяем покупку…");
    for(let i = 0; i < STORE_VERIFY_TRIES; i++){
      if(i) await sleep(STORE_VERIFY_GAP);
      if(!accountUser) return;
      const data = await accountApiPost("/api/shop/verify", body);
      if(data.status === "granted"){ setMsg("", ""); onGranted(data, p, false); return; }
      if(data.status === "pending") continue;
      // Сеть или сервер недоступны — покупка оплачена, пробуем ещё раз.
      if(data.error && (data._status === 0 || data._status >= 500)) continue;
      setMsg(data.error || "Магазин не подтвердил покупку.", "");
      return;
    }
    setMsg("", "Платёж обрабатывается — покупка появится сама.");
  }
  function grantText(p){
    if(!p) return "";
    if(p.premium) return "Премиум активен" + (p.points ? ` · +${pointsLabel(p.points)}` : "");
    if(p.kind === "consumable") return "+" + pointsLabel(p.points || 0);
    return `${p.title} — в разделе «Скины»`;
  }
  function onGranted(data, p, quiet){
    if(data.user && accountUser){
      accountUser = data.user;
      refreshAccountViews();
    }
    clearPending(data.orderId);
    showCheckBtn = false;
    if(!quiet) showToast({ kind: "good", icon: "check", title: "Покупка зачислена", text: grantText(p) });
    loadEntitlements();
    render();
  }

  // --- Опрос заказа ЮKassa ---------------------------------------------------------
  // opts.startAt — время создания заказа (окно 10 минут считается от него),
  // opts.once — одна тихая проверка (тост — только об итоге), opts.status —
  // подпись на время опроса.
  function startPoll(id, opts){
    stopPoll();
    poll = { id, start: opts.startAt || Date.now(), once: !!opts.once, status: opts.status || "Проверяем оплату…", timer: null };
    if(!poll.once) setMsg("", poll.status);
    pollTick();
  }
  function stopPoll(){
    if(poll && poll.timer) clearTimeout(poll.timer);
    poll = null;
  }
  function finishPoll(id){
    stopPoll();
    clearPending(id);
    showCheckBtn = false;
  }
  async function pollTick(){
    const p = poll;
    if(!p) return;
    p.timer = null;
    if(!accountUser){ awaitLogin = p.id; stopPoll(); render(); return; }
    const data = await accountApiGet("/api/shop/order/" + p.id);
    if(poll !== p) return;
    // Сессия истекла во время запроса (тогда опрос уже снял onAccountChanged) или нет токена.
    if(!accountUser || data.code === "auth_required" || data.code === "session"){ awaitLogin = p.id; stopPoll(); render(); return; }
    const product = productById(data.productId);
    if(data.status === "granted"){
      stopPoll();
      setMsg("", "");
      onGranted(data, product, false);
      return;
    }
    if(data.status === "canceled"){
      finishPoll(p.id);
      setMsg("", "");
      if(!p.once) showToast({ kind: "warn", icon: "info", title: "Оплата не завершена — деньги не списаны." });
      render();
      return;
    }
    if(data.status === "failed"){
      finishPoll(p.id);
      const text = `Платёж не прошёл проверку. Напишите в поддержку, указав номер заказа ${p.id.slice(0, 8)}.`;
      setMsg(text, "");
      showToast({ kind: "danger", icon: "alert", title: "Платёж не прошёл проверку", text: `Напишите в поддержку, указав номер заказа ${p.id.slice(0, 8)}.`, duration: 15000 });
      render();
      return;
    }
    // Чужой или неизвестный заказ (сервер отвечает 404 одинаково) или магазин
    // выключили — забываем заказ. Вернулись с оплаты (или ждали её в открытом
    // магазине), а заказ «не найден» — значит, сейчас вход в другой аккаунт:
    // подсказываем, где покупка, а не молчим.
    if(data._status === 404){
      finishPoll(p.id);
      const otherAccount = data.code === "not_found" && (p.id === returnOrderId || !p.once);
      setMsg("", otherAccount ? "Этот заказ оформлен с другого аккаунта — войдите в него: покупка уже там." : "");
      render();
      return;
    }
    if(p.once){ stopPoll(); return; }
    const elapsed = Date.now() - p.start;
    if(elapsed >= POLL_MAX){
      stopPoll();
      setMsg("", "Платёж ещё обрабатывается — покупка появится автоматически.");
      render();
      return;
    }
    // Экран магазина закрыли — опрос продолжится при следующем открытии.
    if(!shopShown()){ stopPoll(); return; }
    p.timer = setTimeout(pollTick, elapsed < POLL_FAST_FOR ? POLL_FAST_MS : POLL_SLOW_MS);
  }
  // Незавершённый заказ (ушли платить и вернулись): в открытом магазине —
  // опрос, иначе одна тихая проверка (тост — только если зачислено).
  function resumePendingPoll(){
    const v = readPending();
    if(!v || !accountUser) return;
    // Тихая разовая проверка уже идёт, а магазин открыт — заменяем её полным
    // опросом (startPoll снимет прежний, а её запоздалый ответ отбросит
    // проверка poll !== p в pollTick). Иначе после возврата с оплаты, когда
    // сессия восстановилась раньше открытия магазина, опрос ограничивался одним
    // запросом: без подписи «Проверяем оплату…» и без тоста об итоге.
    if(poll && !(poll.once && shopShown())) return;
    const age = Date.now() - v.at;
    if(age > PENDING_MAX_AGE){ lsDel(LS_PENDING); return; }
    startPoll(v.id, shopShown() && age < POLL_MAX ? { startAt: v.at } : { once: true });
  }
  function onAppResume(){
    const v = readPending();
    if(!v || !accountUser || Date.now() - v.at > PENDING_MAX_AGE) return;
    // Вернулись из браузера с оплатой — опрашиваем заново, окно 10 минут — с этого момента.
    if(shopShown()) startPoll(v.id, {});
    else if(!poll) startPoll(v.id, { once: true });
  }

  // --- Покупки магазина приложений, не дошедшие до сервера ------------------------
  // Приложение закрылось между оплатой и ответом сервера: при запуске (после
  // входа) отправляем такие покупки на проверку ещё раз. Отказы «чужой аккаунт»
  // и «уже куплено» — молча.
  async function syncStorePurchases(){
    const billing = window.TMNative && TMNative.billing;
    if(!accountUser || !billing || !billing.isAvailable() || !usableProviders().includes(billing.provider)) return;
    const name = accountUser.username;
    if(storeSyncedFor === name) return;
    storeSyncedFor = name;
    const list = await billing.pending();
    let restored = 0;
    for(const it of list){
      if(!accountUser || accountUser.username !== name) return;
      const p = products().find((x)=> storeIdOf(x, billing.provider) === it.productId);
      const data = await accountApiPost("/api/shop/verify", {
        provider: billing.provider, productId: p ? p.id : it.productId, purchaseToken: it.purchaseToken, sandbox: !!it.sandbox,
      });
      if(data.status === "granted"){
        if(data.user && accountUser && accountUser.username === name) accountUser = data.user;
        if(!data.alreadyGranted) restored++;
      }
    }
    if(restored){
      refreshAccountViews();
      showToast({ kind: "good", icon: "check", title: "Покупка восстановлена" });
      loadEntitlements();
      render();
    }
  }

  // --- Видео с наградой --------------------------------------------------------------
  async function watchAd(){
    if(busy || !accountUser || !adsAvailable() || adState().blocked) return;
    const na = TMNative.ads;
    setMsg("", "");
    setBusy(true);
    try {
      const start = await accountApiPost("/api/ads/start", { provider: na.provider, adUnit: na.adUnit, platform: platform() });
      if(start.error || !start.nonce){
        setMsg(start.error || "Видео сейчас недоступно — попробуйте позже.", "");
        if(start.code === "ads_cap" || start.code === "ads_cooldown") loadEntitlements();
        return;
      }
      let r;
      try { r = await na.showRewarded({ nonce: start.nonce, userId: start.userId }); }
      catch(e){
        console.warn("ads:", e && e.message);
        setMsg("Видео сейчас недоступно — попробуйте позже.", "");
        return;
      }
      if(!r || !r.rewarded){ setMsg("", "Видео не досмотрено — очки не начислены."); return; }
      setMsg("", "Начисляем очки…");
      const t0 = Date.now();
      for(;;){
        const data = await accountApiPost("/api/ads/reward", { provider: na.provider, adUnit: na.adUnit, nonce: start.nonce });
        if(data.status === "granted"){
          if(data.user && accountUser) accountUser = data.user;
          if(ent && ent.ads && data.today) ent.ads = Object.assign({}, ent.ads, { today: data.today.count, cap: data.today.cap, nextAt: data.today.nextAt });
          setMsg("", "");
          refreshAccountViews();
          showToast({ kind: "good", icon: "coins", title: "+" + pointsLabel(data.points || start.rewardPoints || 0), text: "Спасибо за просмотр!", duration: 4000 });
          loadEntitlements();
          return;
        }
        // Награда по колбэку AdMob (ssv) или сбой сети — ждём до 15 с.
        const retry = data.status === "pending" || (data.error && (data._status === 0 || data._status >= 500));
        if(retry && Date.now() - t0 < AD_REWARD_WAIT){ await sleep(AD_REWARD_GAP); continue; }
        if(data.status === "pending" || retry){ setMsg("", "Награда придёт в течение минуты."); loadEntitlements(); return; }
        setMsg(data.error || "Просмотр не засчитан — попробуйте ещё раз.", "");
        return;
      }
    } catch(e){
      console.error(e);
      setMsg("Видео сейчас недоступно — попробуйте позже.", "");
    } finally {
      setBusy(false);
      render();
    }
  }

  // --- Жизненный цикл -------------------------------------------------------------
  // После restoreSession (из index.html): каталог, возврат с оплаты (?order=),
  // незавершённый заказ, досылка покупок магазина.
  function init(){
    if(inited) return;
    inited = true;
    let returnId = null;
    try {
      // Остальные параметры (например, ?debug) сохраняем как есть.
      const parts = location.search.replace(/^\?/, "").split("&").filter(Boolean);
      const orderPart = parts.find((x)=> /^order=/.test(x));
      if(orderPart){
        let id = "";
        try { id = decodeURIComponent(orderPart.slice(6)); } catch(e){}
        const q = parts.filter((x)=> !/^order(=|$)/.test(x)).join("&");
        // Номер заказа из адреса убираем сразу: перезагрузка не должна повторять проверку.
        history.replaceState(history.state, "", location.pathname + (q ? "?" + q : "") + location.hash);
        if(ORDER_RE.test(id)) returnId = id;
      }
    } catch(e){}
    if(window.TMNative && typeof TMNative.onResume === "function") TMNative.onResume(onAppResume);
    // Вернулись со страницы оплаты кнопкой «Назад» (страница из bfcache): кнопки снова активны.
    window.addEventListener("pageshow", (e)=>{
      if(!e.persisted) return;
      setBusy(false); setMsg("", "");
      resumePendingPoll();
    });
    loadCatalog();
    const restored = typeof restoreSession === "function" ? Promise.resolve().then(()=> restoreSession()).catch(()=> false) : Promise.resolve(false);
    if(returnId){
      // Возврат со страницы оплаты: магазин открываем сразу, не дожидаясь
      // восстановления сессии (медленный или просыпающийся сервер), — игрок видит
      // «Проверяем оплату…», а не главное меню, и не платит второй раз. Опрос
      // запустит resumePendingPoll, как только аккаунт станет известен.
      returnOrderId = returnId;
      restoring = true;
      savePending(returnId);
      open();
    }
    restored.then(()=>{
      restoring = false;
      if(returnId && !accountUser) awaitLogin = returnId;
      onAccountChanged();
    });
  }
  // Вход, выход, смена аккаунта, обновление accountUser.
  function onAccountChanged(){
    const name = accountUser ? accountUser.username : null;
    if(name !== accountName){
      accountName = name;
      ent = null;
      entSeq++;
      if(!name){
        // Вышли (или истекла сессия) во время ожидания оплаты — после входа продолжим.
        if(poll) awaitLogin = poll.id;
        stopPoll(); showCheckBtn = false; setMsg("", "");
      }
    }
    if(accountUser){
      awaitLogin = null;
      if(catalogOn()){
        if(shopShown() || adsAvailable()) loadEntitlements();
        syncStorePurchases();
      }
      resumePendingPoll(); // незавершённый заказ: опрос в открытом магазине или одна тихая проверка
    }
    render();
  }
  // Показ главного меню: пункт «Магазин» и повтор каталога, если прошлый запрос упал.
  function onMenuShown(){
    updateMenuEntry();
    if(inited && !catalogLoading && catalogFailedAt && Date.now() - catalogFailedAt > CATALOG_RETRY_MS) loadCatalog();
  }

  // --- Кнопки экрана (разметка #shopScreen уже в DOM: скрипт стоит в конце <body>) ---
  function bind(id, ev, fn){ const el = byId(id); if(el) el.addEventListener(ev, fn); }
  bind("btnBackFromShop", "click", ()=>{ stopPoll(); showOnly("mainMenu"); });
  bind("shopGateLoginBtn", "click", ()=> openAccountModal("login"));
  bind("btnRewardedAd", "click", ()=> watchAd());
  bind("shopCheckBtn", "click", ()=>{
    const v = readPending();
    if(v && accountUser && !busy) startPoll(v.id, {});
  });
  bind("shopContent", "click", (e)=>{
    const buyBtn = e.target.closest("button[data-product]");
    if(buyBtn && !buyBtn.disabled){ buy(buyBtn.dataset.product); return; }
    const provBtn = e.target.closest("button[data-provider]");
    if(provBtn && !provBtn.disabled && !busy){
      provider = provBtn.dataset.provider;
      setMsg("", "");
      render();
      const again = findButton("#shopProviders [data-provider]", "provider", provider);
      if(again) again.focus();
    }
  });
  // Переключатель способа оплаты — группа радиокнопок: стрелки двигают выбор.
  bind("shopProviders", "keydown", (e)=>{
    if(!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || busy) return;
    const list = usableProviders();
    const i = list.indexOf(currentProvider());
    if(i < 0 || list.length < 2) return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    provider = list[(i + step + list.length) % list.length];
    render();
    const btn = findButton("#shopProviders [data-provider]", "provider", provider);
    if(btn) btn.focus();
  });
  // Ссылки подвала (оферта, политика) в приложении — во внешнем браузере.
  bind("shopLegal", "click", (e)=>{
    const a = e.target.closest("a[href]");
    if(!a || !window.TMNative || !TMNative.isNative) return;
    e.preventDefault();
    TMNative.openExternal(a.href);
  });

  window.Shop = { init, enabled, productAvailable, adsAvailable, open, render, onAccountChanged, onMenuShown };
  // Короткое имя для меню (btnGoShop) и других экранов.
  window.showShop = (focusId)=> open(focusId);
})();
