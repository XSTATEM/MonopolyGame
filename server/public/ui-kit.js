// ---------------------------------------------------------------------
// UI-кит интерфейса (window.UIKit): подсказка «?» и выбор из списка.
// Подключается из index.html до основного скрипта. Описание паттернов,
// состояния и критерии приёмки — docs/UI-PATTERNS.md.
//
// 1. Подсказка «?» (toggletip). Пояснения больше не висят текстом в
//    интерфейсе: рядом с заголовком или полем стоит круглая кнопка «?»,
//    по нажатию раскрывается пузырь с текстом. hintBtn(key, html) возвращает
//    разметку кнопки; key — стабильный ключ: интерфейс пересобирается через
//    innerHTML на каждом состоянии, и открытая подсказка по ключу находит
//    новую кнопку и остаётся на месте. html — уже экранированная разметка.
//    Закрывается повторным нажатием, нажатием мимо, Esc/«Назад», прокруткой.
// 2. Выбор из списка. Каждый <select> получает кнопку-двойника в стиле
//    игры, а по нажатию открывается лист снизу (на широком экране — список
//    под кнопкой) с крупными строками и галочкой у выбранного. Сам <select>
//    остаётся в DOM источником значения: выбор ставит ему value и шлёт
//    input/change, поэтому onchange-обработчики и сохранение полей при
//    перерисовке (withPreservedInputs) работают как раньше.
//    <select data-native> не трогаем.
// ---------------------------------------------------------------------
(function(root){
  "use strict";
  if(typeof document === "undefined") return;

  const HELP_ICON = '<svg class="ico" aria-hidden="true"><use href="#i-help"/></svg>';
  const CHECK_ICON = '<svg class="ico ico-sm" aria-hidden="true"><use href="#i-check"/></svg>';
  const CLOSE_ICON = '<svg class="ico" aria-hidden="true"><use href="#i-x"/></svg>';
  const CHEV_ICON = '<svg class="ico ico-sm" aria-hidden="true"><use href="#i-chev-down"/></svg>';

  function escAttr(s){
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escText(s){
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function reduced(){
    return document.body.classList.contains("reduce-motion")
      || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  // Внутри партии (#app) и в тёмных слоях — тёмная тема, в меню — светлая.
  function darkFor(el){ return !!(el && el.closest && el.closest("#app, .theme-dark")); }

  // --- 1. Подсказка «?» ---------------------------------------------------
  let pop = null;        // пузырь (один на страницу)
  let popKey = "";       // ключ открытой подсказки
  let popAnchor = null;  // кнопка, у которой он открыт

  function hintBtn(key, html, label){
    return `<button type="button" class="hint-q" data-hint-key="${escAttr(key)}" data-fkey="hint:${escAttr(key)}" data-hint="${escAttr(html)}"`
      + ` aria-label="${escAttr(label || "Подсказка")}" aria-expanded="false">${HELP_ICON}</button>`;
  }
  function ensurePop(){
    if(pop) return pop;
    pop = document.createElement("div");
    pop.id = "hintPop";
    pop.className = "hint-pop";
    pop.setAttribute("role", "status");
    pop.setAttribute("aria-live", "polite");
    pop.hidden = true;
    pop.innerHTML = '<div class="hint-pop-body"></div><i class="hint-pop-arrow" aria-hidden="true"></i>';
    document.body.appendChild(pop);
    return pop;
  }
  function placePop(){
    if(!pop || !popAnchor) return;
    const r = popAnchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const GAP = 10, EDGE = 12;
    pop.style.maxWidth = Math.min(320, vw - EDGE * 2) + "px";
    pop.style.left = "0px"; pop.style.top = "0px";
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const cx = r.left + r.width / 2;
    let left = Math.round(Math.max(EDGE, Math.min(vw - EDGE - pw, cx - pw / 2)));
    const below = vh - r.bottom - GAP - EDGE >= ph || r.top - GAP - EDGE < ph;
    const top = below ? r.bottom + GAP : r.top - GAP - ph;
    pop.style.left = left + "px";
    pop.style.top = Math.round(Math.max(EDGE, top)) + "px";
    pop.classList.toggle("below", below);
    pop.classList.toggle("above", !below);
    const arrow = pop.querySelector(".hint-pop-arrow");
    arrow.style.left = Math.round(Math.max(14, Math.min(pw - 14, cx - left))) + "px";
  }
  function openHint(btn){
    ensurePop();
    if(popAnchor && popAnchor !== btn) popAnchor.setAttribute("aria-expanded", "false");
    popAnchor = btn;
    popKey = btn.getAttribute("data-hint-key") || "";
    btn.setAttribute("aria-expanded", "true");
    pop.classList.toggle("theme-dark", darkFor(btn));
    pop.classList.toggle("no-anim", reduced());
    const body = pop.querySelector(".hint-pop-body");
    body.innerHTML = "";
    pop.hidden = false;
    // Текст — следующим кадром после показа: так живой регион объявит его
    // экранному диктору (изменение в том же кадре, что и показ, часто теряется).
    const html = btn.getAttribute("data-hint") || "";
    requestAnimationFrame(()=>{
      if(!pop || pop.hidden || popAnchor !== btn) return;
      body.innerHTML = html;
      placePop();
      pop.classList.add("open");
    });
  }
  function closeHint(){
    if(!pop || pop.hidden) return false;
    pop.classList.remove("open");
    pop.hidden = true;
    if(popAnchor && popAnchor.isConnected) popAnchor.setAttribute("aria-expanded", "false");
    popAnchor = null; popKey = "";
    return true;
  }
  // Интерфейс пересобрался: кнопка открытой подсказки заменена новой с тем же
  // ключом — переезжаем к ней; кнопки больше нет — закрываемся.
  function reanchorHint(){
    if(!pop || pop.hidden || !popAnchor || popAnchor.isConnected) return;
    const next = popKey ? document.querySelector(`.hint-q[data-hint-key="${CSS.escape(popKey)}"]`) : null;
    if(next && next.getClientRects().length){
      popAnchor = next;
      next.setAttribute("aria-expanded", "true");
      const body = pop.querySelector(".hint-pop-body");
      const html = next.getAttribute("data-hint") || "";
      if(body.innerHTML !== html) body.innerHTML = html;
      placePop();
    } else closeHint();
  }

  // --- 2. Выбор из списка ---------------------------------------------------
  let sheet = null;      // {overlay, panel, list, title, select, btn, items, active}

  function labelFor(select){
    if(select.id){
      const l = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
      if(l) return l.textContent.trim();
    }
    const wrap = select.closest("label");
    if(wrap){
      const t = Array.from(wrap.childNodes).filter((n)=> n.nodeType === 3).map((n)=> n.textContent).join(" ").trim();
      if(t) return t;
    }
    return select.getAttribute("aria-label") || "";
  }
  function selectedText(select){
    const o = select.options[select.selectedIndex];
    return o ? o.text : "";
  }
  function syncProxy(select){
    const btn = select._pickBtn;
    if(!btn) return;
    const text = selectedText(select);
    const span = btn.querySelector(".pick-value");
    if(span.textContent !== text) span.textContent = text;
    const label = labelFor(select);
    const aria = label ? `${label}: ${text}` : text;
    if(btn.getAttribute("aria-label") !== aria) btn.setAttribute("aria-label", aria);
    btn.disabled = select.disabled || select.options.length === 0;
  }
  function enhance(select){
    if(select._pickBtn || select.hasAttribute("data-native") || select.multiple) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pick-btn";
    if(select.getAttribute("style")) btn.setAttribute("style", select.getAttribute("style"));
    btn.setAttribute("aria-haspopup", "listbox");
    if(select.id) btn.dataset.fkey = "pick:" + select.id; // фокус переживает перерисовку (captureFocus)
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = `<span class="pick-value"></span>${CHEV_ICON}`;
    btn.addEventListener("click", ()=> openPicker(select));
    select.classList.add("pick-native");
    select.setAttribute("data-pick", "1");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    select._pickBtn = btn;
    select.insertAdjacentElement("afterend", btn);
    syncProxy(select);
  }
  function enhanceAll(){
    document.querySelectorAll("select:not([data-pick]):not([data-native])").forEach(enhance);
    document.querySelectorAll("select[data-pick]").forEach((s)=>{
      // Кнопку-двойника могли выбросить вместе с соседями — вернём.
      if(!s._pickBtn || !s._pickBtn.isConnected || s._pickBtn.previousElementSibling !== s){
        if(s._pickBtn && s._pickBtn.isConnected) s._pickBtn.remove();
        s._pickBtn = null;
        s.removeAttribute("data-pick");
        enhance(s);
      } else syncProxy(s);
    });
  }

  function buildItems(select){
    const items = [];
    Array.from(select.children).forEach((node)=>{
      if(node.tagName === "OPTGROUP"){
        items.push({ group: node.label });
        Array.from(node.children).forEach((o)=> items.push({ opt: o, disabled: o.disabled || node.disabled }));
      } else if(node.tagName === "OPTION") items.push({ opt: node, disabled: node.disabled });
    });
    return items;
  }
  function openPicker(select){
    if(select.disabled) return;
    closeHint();
    closePicker(false);
    const items = buildItems(select);
    const dark = darkFor(select._pickBtn || select);
    const title = labelFor(select) || "Выберите";
    const overlay = document.createElement("div");
    overlay.className = "pick-overlay" + (dark ? " theme-dark" : "") + (reduced() ? " no-anim" : "");
    const listId = "pickList";
    let html = `<div class="pick-panel" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">
      <div class="pick-head"><span class="pick-title">${escText(title)}</span>
        <button type="button" class="pick-close" aria-label="Закрыть">${CLOSE_ICON}</button></div>
      <div class="pick-list" id="${listId}" role="listbox" tabindex="-1" aria-label="${escAttr(title)}">`;
    items.forEach((it, i)=>{
      if(it.group != null){ html += `<div class="pick-group" role="presentation">${escText(it.group)}</div>`; return; }
      const sel = it.opt.selected;
      html += `<div class="pick-opt${sel ? " selected" : ""}${it.disabled ? " disabled" : ""}" role="option" id="pickOpt${i}" data-i="${i}"`
        + ` aria-selected="${sel}"${it.disabled ? ' aria-disabled="true"' : ""}><span>${escText(it.opt.text)}</span>${sel ? CHECK_ICON : ""}</div>`;
    });
    html += `</div></div>`;
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    const panel = overlay.querySelector(".pick-panel");
    const list = overlay.querySelector(".pick-list");
    const btn = select._pickBtn;
    // Широкий экран — список под кнопкой, телефон — лист снизу.
    const wide = window.matchMedia && window.matchMedia("(min-width: 720px) and (pointer: fine)").matches;
    if(wide && btn){
      overlay.classList.add("anchored");
      const r = btn.getBoundingClientRect();
      const vh = window.innerHeight, vw = document.documentElement.clientWidth;
      const w = Math.max(240, Math.min(420, r.width));
      panel.style.width = w + "px";
      panel.style.left = Math.round(Math.max(12, Math.min(vw - 12 - w, r.left))) + "px";
      const spaceBelow = vh - r.bottom - 16, spaceAbove = r.top - 16;
      if(spaceBelow >= 240 || spaceBelow >= spaceAbove){
        panel.style.top = Math.round(r.bottom + 6) + "px";
        panel.style.maxHeight = Math.max(160, spaceBelow) + "px";
      } else {
        panel.style.bottom = Math.round(vh - r.top + 6) + "px";
        panel.style.maxHeight = Math.max(160, spaceAbove) + "px";
      }
    }
    sheet = { overlay, panel, list, select, btn, items, active: -1 };
    if(btn) btn.setAttribute("aria-expanded", "true");
    overlay.addEventListener("pointerdown", (e)=>{ if(e.target === overlay) e.preventDefault(); });
    overlay.addEventListener("click", (e)=>{
      if(e.target === overlay || e.target.closest(".pick-close")){ closePicker(true); return; }
      const row = e.target.closest(".pick-opt");
      if(row && !row.classList.contains("disabled")) choose(+row.getAttribute("data-i"));
    });
    list.addEventListener("keydown", onListKey);
    panel.addEventListener("keydown", (e)=>{
      if(e.key === "Tab"){ // ловушка фокуса: крестик ↔ список
        e.preventDefault();
        const closeBtn = panel.querySelector(".pick-close");
        (document.activeElement === list ? closeBtn : list).focus();
      }
    });
    const cur = items.findIndex((it)=> it.opt && it.opt.selected);
    setActive(cur >= 0 ? cur : items.findIndex((it)=> it.opt && !it.disabled), true);
    requestAnimationFrame(()=>{ overlay.classList.add("open"); list.focus({ preventScroll: true }); });
  }
  function setActive(i, center){
    if(!sheet || i < 0) return;
    sheet.active = i;
    sheet.list.querySelectorAll(".pick-opt.active").forEach((el)=> el.classList.remove("active"));
    const el = sheet.list.querySelector(`.pick-opt[data-i="${i}"]`);
    if(!el) return;
    el.classList.add("active");
    sheet.list.setAttribute("aria-activedescendant", el.id);
    el.scrollIntoView({ block: center ? "center" : "nearest" });
  }
  function moveActive(step){
    if(!sheet) return;
    const n = sheet.items.length;
    let i = sheet.active;
    for(let k = 0; k < n; k++){
      i = (i + step + n) % n;
      const it = sheet.items[i];
      if(it.opt && !it.disabled){ setActive(i); return; }
    }
  }
  function onListKey(e){
    if(!sheet) return;
    if(e.key === "ArrowDown"){ e.preventDefault(); moveActive(1); }
    else if(e.key === "ArrowUp"){ e.preventDefault(); moveActive(-1); }
    else if(e.key === "Home"){ e.preventDefault(); sheet.active = -1; moveActive(1); }
    else if(e.key === "End"){ e.preventDefault(); sheet.active = sheet.items.length; moveActive(-1); }
    else if(e.key === "Enter" || e.key === " "){ e.preventDefault(); if(sheet.active >= 0) choose(sheet.active); }
  }
  // Панель могли пересобрать, пока лист открыт (ход бота, новое состояние):
  // тогда старый <select> уже вне DOM — берём живой с тем же id.
  function liveSelect(select){
    if(select.isConnected || !select.id) return select;
    return document.getElementById(select.id) || select;
  }
  function choose(i){
    if(!sheet) return;
    const it = sheet.items[i];
    if(!it || !it.opt || it.disabled) return;
    const select = liveSelect(sheet.select);
    const idx = Array.from(select.options).findIndex((o)=> o.value === it.opt.value && o.text === it.opt.text);
    const target = idx >= 0 ? idx : Array.from(select.options).findIndex((o)=> o.value === it.opt.value);
    closePicker(true);
    if(target < 0 || !select.isConnected) return; // варианта больше нет — ничего не меняем
    if(select.selectedIndex !== target){
      select.selectedIndex = target;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    syncProxy(select);
  }
  function closePicker(returnFocus){
    if(!sheet) return false;
    const { overlay, btn } = sheet;
    sheet = null;
    overlay.style.pointerEvents = "none"; // угасающий слой не должен глотать следующий тап
    if(btn && btn.isConnected){ btn.setAttribute("aria-expanded", "false"); if(returnFocus) btn.focus({ preventScroll: true }); }
    overlay.classList.remove("open");
    if(overlay.classList.contains("no-anim")) overlay.remove();
    else setTimeout(()=> overlay.remove(), 200);
    return true;
  }

  // --- Общие обработчики ------------------------------------------------------
  document.addEventListener("click", (e)=>{
    const q = e.target.closest && e.target.closest(".hint-q");
    if(q){
      e.preventDefault();
      e.stopPropagation(); // не раскрывать строку/карточку, внутри которой стоит «?»
      if(popAnchor === q && pop && !pop.hidden) closeHint(); else openHint(q);
      return;
    }
    if(pop && !pop.hidden && !(e.target.closest && e.target.closest("#hintPop"))) closeHint();
    // Нажатие на <label for> скрытого списка — фокус на кнопку-двойника.
    const lab = e.target.closest && e.target.closest("label[for]");
    if(lab){
      const s = document.getElementById(lab.getAttribute("for"));
      if(s && s._pickBtn){ e.preventDefault(); s._pickBtn.focus(); }
    }
  }, true);
  document.addEventListener("keydown", (e)=>{
    if(e.key !== "Escape") return;
    if(closePicker(true) || closeHint()){ e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // Прокрутка уводит кнопку из-под пузыря — закрываем (кроме прокрутки самого пузыря).
  window.addEventListener("scroll", (e)=>{
    if(pop && !pop.hidden && !(e.target && e.target.closest && e.target.closest("#hintPop"))) closeHint();
  }, true);
  window.addEventListener("resize", ()=>{ closeHint(); });
  document.addEventListener("change", (e)=>{
    if(e.target && e.target.tagName === "SELECT" && e.target._pickBtn) syncProxy(e.target);
  }, true);
  // Фокус на скрытый <select> (восстановление фокуса после перерисовки по id) —
  // переводим на видимую кнопку-двойника.
  document.addEventListener("focusin", (e)=>{
    const t = e.target;
    if(t && t.tagName === "SELECT" && t._pickBtn && t._pickBtn.isConnected) t._pickBtn.focus({ preventScroll: true });
  });

  let mo = null, queued = false;
  function onMutations(){
    if(queued) return;
    queued = true;
    Promise.resolve().then(()=>{
      queued = false; enhanceAll(); reanchorHint();
      // Открытый лист — к живому <select> и его новой кнопке.
      if(sheet && !sheet.select.isConnected){
        const live = liveSelect(sheet.select);
        if(live !== sheet.select && live._pickBtn){ sheet.select = live; sheet.btn = live._pickBtn; live._pickBtn.setAttribute("aria-expanded", "true"); }
      }
    });
  }
  function start(){
    enhanceAll();
    mo = new MutationObserver(onMutations);
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // Верхний слой для «Назад»/Esc в handleBackNavigation.
  function closeTop(){ return closePicker(true) || closeHint(); }

  root.UIKit = { hintBtn, closeHint, closePicker, closeTop, enhanceAll, sync: syncProxy };
  root.hintBtn = hintBtn;
})(typeof self !== "undefined" ? self : this);
