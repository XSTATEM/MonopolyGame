// ---------------------------------------------------------------------
// Анимации партии (window.Anim). Подключается из index.html перед основным
// скриптом. render() пересобирает панели через innerHTML на каждом
// состоянии (офлайн с ботами — каждые ~650 мс), поэтому CSS-анимация,
// просто прописанная в шаблоне, перезапускалась бы при любом ходе любого
// игрока. Здесь одна точка сравнения: afterRender() в конце render()
// сравнивает новое состояние со СВОИМ прошлым снимком и регистрирует
// эффекты в реестре, а реестр после каждой перерисовки заново вешает класс
// на новые узлы с отрицательной задержкой (--d-<класс>) — анимация
// продолжается с того же места, а не начинается сначала.
// Только оформление: игровой логики нет, send()/render() отсюда не
// вызываются, наложения не перехватывают нажатия (pointer-events:none) и
// скрыты от экранного диктора (aria-hidden) — всё то же есть в ленте и чипах.
// ---------------------------------------------------------------------
(function(){
  "use strict";

  const MQ = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  // «Сократить анимации» в настройках игры или системная настройка.
  function reduced(){
    return document.body.classList.contains("reduce-motion") || !!(MQ && MQ.matches);
  }
  const now = ()=> performance.now();
  // Значение для селектора атрибута — в кавычках, с экранированием.
  const q = (v)=> '"' + String(v).replace(/["\\]/g, "\\$&") + '"';
  function esc(v){
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c)=> ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  }
  function haptic(kind){
    try { if(window.TMNative) window.TMNative.haptic(kind); } catch(e){}
  }
  // Цвета конфетти: цвета мест за столом + золото и крем дизайн-системы.
  const CONFETTI_COLORS = ["#E0B168","#7DB8E8","#C58BE6","#E88C8C","#8CC2AE","#D9D2C3","#F3EEE4"];

  // Таймеры наложений и отложенных шагов — все снимаются в reset().
  const timers = new Set();
  function later(fn, ms){
    const id = setTimeout(()=>{ timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }

  // --- Реестр эффектов ------------------------------------------------
  // key → {sel, cls, slot, t0, delay, dur, vars, each, timer}. Ключ несёт
  // идентичность события (бросок, сделка, номер события), поэтому одно и то
  // же событие второй раз не регистрируется. Слот sel|cls: новый эффект с
  // тем же классом на тех же узлах вытесняет старый и начинается заново.
  const fx = new Map();
  const slots = new Map();
  function add(key, sel, cls, opts){
    if(fx.has(key)) return;
    opts = opts || {};
    const slot = sel + "|" + cls;
    if(slots.has(slot)) drop(slots.get(slot), true);
    const e = { sel, cls, slot, t0: now(), delay: opts.delay || 0, dur: opts.dur || 600, vars: opts.vars || null, each: opts.each || null };
    e.timer = setTimeout(()=> drop(key), e.delay + e.dur + 60);
    fx.set(key, e);
    slots.set(slot, key);
  }
  function drop(key, restart){
    const e = fx.get(key);
    if(!e) return;
    clearTimeout(e.timer);
    fx.delete(key);
    if(slots.get(e.slot) === key) slots.delete(e.slot);
    document.querySelectorAll(e.sel).forEach((el)=>{
      const had = el.classList.contains(e.cls);
      el.classList.remove(e.cls);
      el.style.removeProperty("--d-" + e.cls);
      if(e.vars) Object.keys(e.vars).forEach((k)=> el.style.removeProperty(k));
      // Тот же класс сейчас же повесит новый эффект: без пересчёта стилей
      // браузер не заметил бы снятия, и анимация не началась бы заново.
      // Пересобранным узлам (класса ещё нет) пересчёт не нужен.
      if(restart && had) void el.offsetWidth;
    });
  }
  function dropSlot(sel, cls){
    const k = slots.get(sel + "|" + cls);
    if(k) drop(k);
  }
  // Вешает классы живых эффектов на узлы, которых ещё нет (пересобранные
  // перерисовкой), с отрицательной задержкой по возрасту эффекта.
  function reapply(){
    if(fx.size){
      const t = now();
      fx.forEach((e)=>{
        const nodes = document.querySelectorAll(e.sel);
        for(let i = 0; i < nodes.length; i++){
          const el = nodes[i];
          if(el.classList.contains(e.cls)) continue;
          const d = e.delay - (t - e.t0) + (e.each ? e.each(el) : 0);
          el.style.setProperty("--d-" + e.cls, Math.round(d) + "ms");
          if(e.vars) for(const k in e.vars) el.style.setProperty(k, e.vars[k]);
          el.classList.add(e.cls);
        }
      });
    }
    writeAll(now());
  }
  // Для постоянных узлов (кнопки вкладок, карточка события): перезапуск через reflow.
  function retrigger(el, cls){
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // --- Покадровые «писатели» (кости, счётчики) и общий цикл rAF ---------
  // Писатель — функция времени: apply(t) находит узлы заново (DOM мог
  // пересобраться), пишет нужный текст и возвращает false, когда закончил;
  // последний кадр — всегда точное итоговое значение. Поэтому его можно
  // звать и из rAF, и сразу после перерисовки — без мигания итоговой цифры.
  const writers = new Map();
  let raf = 0;
  let confetti = null;
  function writeAll(t){
    writers.forEach((w, key)=>{
      let alive = false;
      try { alive = w.apply(t); } catch(e){}
      if(!alive) writers.delete(key);
    });
  }
  function frame(){
    raf = 0;
    const t = now();
    writeAll(t);
    if(confetti && !confetti.step(t)) killConfetti();
    if(writers.size || confetti) raf = requestAnimationFrame(frame);
  }
  function kick(){ if(!raf) raf = requestAnimationFrame(frame); }

  // Плавный пересчёт числа (easeOutCubic). Узел трогаем, только если в нём
  // сейчас итоговое значение или наше промежуточное: в чипе вместо суммы
  // может стоять «выбыл» / «не в сети».
  function tween(key, sel, from, to, dur, format){
    const prevW = writers.get(key);
    if(prevW && prevW.cur != null) from = prevW.cur; // продолжаем с промежуточного
    if(Math.abs(to - from) < 1) return;
    const t0 = now();
    const fin = format(to);
    const w = {
      cur: from,
      last: prevW ? prevW.last : null,
      apply(t){
        const p = Math.min(1, Math.max(0, (t - t0) / dur));
        const v = p >= 1 ? to : from + (to - from) * (1 - Math.pow(1 - p, 3));
        const text = p >= 1 ? fin : format(v);
        document.querySelectorAll(sel).forEach((el)=>{
          const cur = el.textContent;
          if(cur !== fin && cur !== w.last) return;
          if(cur !== text) el.textContent = text;
        });
        w.cur = v;
        w.last = text;
        if(p >= 1){ w.cur = null; return false; }
        return true;
      },
    };
    writers.set(key, w);
    w.apply(t0);
    kick();
  }

  // «Прокрутка» кости d12: цифры без повторов подряд, интервал растёт
  // 40→110 мс (замедление), затем — выпавшее значение.
  function diceSchedule(dur, final){
    const seq = [];
    let t = 0, last = final;
    while(t < dur){
      let v;
      do { v = 1 + Math.floor(Math.random() * 12); } while(v === last);
      seq.push([t, v]);
      last = v;
      const p = t / dur;
      t += 40 + 70 * p * p;
    }
    return seq;
  }
  function spinDie(key, sel, dur, final, onLand){
    const seq = diceSchedule(dur, final);
    const t0 = now();
    let landed = false;
    writers.set(key, {
      apply(t){
        const el = t - t0;
        const nodes = document.querySelectorAll(sel);
        if(el >= dur){
          nodes.forEach((n)=>{
            n.classList.remove("anim-die-spin");
            const b = n.querySelector("b");
            if(b && b.textContent !== String(final)) b.textContent = final;
          });
          if(!landed){ landed = true; if(onLand) onLand(); }
          return false;
        }
        let v = seq.length ? seq[0][1] : final;
        for(let i = seq.length - 1; i >= 0; i--) if(seq[i][0] <= el){ v = seq[i][1]; break; }
        nodes.forEach((n)=>{
          n.classList.add("anim-die-spin");
          const b = n.querySelector("b");
          if(b && b.textContent !== String(v)) b.textContent = v;
        });
        return true;
      },
    });
    writers.get(key).apply(t0);
    kick();
  }

  // --- Слой наложений поверх стола (#animLayer) ------------------------
  // Внутри #stage, перед панелью хода: .stage (z1) — свой контекст наложения,
  // и слой в #app рисовался поверх всего стола, в том числе нижнего листа и
  // панели хода. Здесь он выше поля, ниже панели хода (z20) и листа (z21),
  // ниже оверлеев вкладок (z22) и таб-бара (z23); прячется вместе с #app.
  function layer(){
    let el = document.getElementById("animLayer");
    if(!el){
      const stage = document.getElementById("stage");
      if(!stage) return null;
      el = document.createElement("div");
      el.id = "animLayer";
      el.setAttribute("aria-hidden", "true");
      stage.insertBefore(el, document.getElementById("cornerAction"));
    }
    return el;
  }
  function spawn(cls, html, x, y, life){
    const L = layer();
    if(!L) return null;
    const n = document.createElement("div");
    n.className = cls;
    if(html) n.innerHTML = html;
    n.style.left = Math.round(x) + "px";
    n.style.top = Math.round(y) + "px";
    const kill = ()=> n.remove();
    n.addEventListener("animationend", (ev)=>{ if(ev.target === n) kill(); });
    later(kill, life);
    L.appendChild(n);
    return n;
  }
  // Сначала все замеры, потом все записи — один пересчёт раскладки на состояние.
  let io = [];
  function measure(read, write){ io.push({ read, write }); }
  function flushIO(){
    const list = io;
    io = [];
    const data = list.map((x)=>{ try { return x.read(); } catch(e){ return null; } });
    list.forEach((x, i)=>{ try { x.write(data[i]); } catch(e){} });
  }
  function visibleRect(el){
    if(!el) return null;
    const r = el.getBoundingClientRect();
    if(!r.width || !r.height || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
    return r;
  }
  // Аватар игрока в ленте чипов, если он реально виден (лента на телефоне
  // прокручивается по горизонтали, в узком ландшафте — по вертикали).
  function chipRect(pid){
    const av = document.querySelector(`.pchip[data-pid=${q(pid)}] .pchip-av`);
    const r = visibleRect(av);
    if(!r) return null;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for(const box of [av.closest(".players-rail"), document.getElementById("cornerRating")]){
      if(!box) continue;
      const br = box.getBoundingClientRect();
      if(cx < br.left || cx > br.right || cy < br.top || cy > br.bottom) return null;
    }
    return r;
  }
  // Точка на поле (доли ширины/высоты) или, если поля не видно, на экране.
  function boardPoint(fx_, fy){
    const r = visibleRect(document.querySelector("#tableBody .stage-board"));
    if(r) return { x: r.left + r.width * fx_, y: r.top + r.height * fy, rect: r };
    return { x: window.innerWidth / 2, y: window.innerHeight * 0.3, rect: null };
  }
  function eventOpen(){
    const ov = document.getElementById("marketEventOverlay");
    return !!ov && !!ov.style.display && ov.style.display !== "none";
  }

  // Всплывающие суммы над чипами. Боты ходят каждые 650 мс, поэтому
  // изменения одного игрока за 400 мс складываются в одну всплывашку.
  const floats = new Map(); // ключ → {node, sum, t0}
  function floatLabel(d){
    const F = C.fmtShort || ((n)=> "$" + Math.round(n));
    return (d >= 0 ? "+" : "−") + F(Math.abs(d));
  }
  function floatAt(key, rect, delta, delay){
    const t = now();
    const cur = floats.get(key);
    if(cur && cur.node.isConnected && t - cur.t0 < 400){
      cur.sum += delta;
      cur.node.textContent = floatLabel(cur.sum);
      cur.node.classList.toggle("up", cur.sum >= 0);
      cur.node.classList.toggle("down", cur.sum < 0);
      return;
    }
    // Ещё живую прошлую всплывашку сдвигаем выше, чтобы не наложились.
    if(cur && cur.node.isConnected) cur.node.style.top = (parseFloat(cur.node.style.top) - 18) + "px";
    const n = spawn("anim-float " + (delta >= 0 ? "up" : "down"), "", rect.left + rect.width / 2, rect.top - 4, 1500);
    if(!n) return;
    n.textContent = floatLabel(delta);
    if(delay) n.style.animationDelay = delay + "ms";
    floats.set(key, { node: n, sum: delta, t0: t });
  }

  // --- Снимок состояния --------------------------------------------------
  let snap = null, lastState = null, C = {}, gen = 0;
  let pulse = null;       // {key, t}: когда закончился «прилёт» клетки — фаза пульсации
  let rollFx = [];        // ключи эффектов текущего броска — снимаются, когда бросок решён
  const deferred = [];    // эффекты, ждущие закрытия сводки биржевого события
  function snapshot(s){
    const players = {};
    (s.players || []).forEach((p)=>{
      players[String(p.id)] = { cash: +p.cash || 0, net: +p.netWorth || 0, bankrupt: !!p.bankrupt, kicked: !!p.kicked, isBot: !!p.isBot, name: p.name || "" };
    });
    const prices = {}, ctrl = {};
    (s.companies || []).forEach((c)=>{
      prices[c.ticker] = +c.price || 0;
      ctrl[c.ticker] = c.controllerId == null ? null : String(c.controllerId);
    });
    const re = {};
    (s.realEstate || []).forEach((r)=>{ re[r.id] = { owner: r.ownerId == null ? null : String(r.ownerId), level: r.level || 0 }; });
    const r = s.pendingRoll;
    // turn и eventCount растут между бросками — ключ уникален, даже если тот
    // же игрок второй раз попал на ту же клетку.
    const rollKey = r ? `${s.eventCount}:${s.turn}:${r.playerId}:${r.row}:${r.col}` : "";
    const meta = s.pendingRollMeta;
    const fpKey = r && meta && meta.kind === "stock" && meta.controllerId === s.you && !s.pendingForcedPrice ? rollKey : "";
    const me = (s.players || []).find((p)=> p.id === s.you);
    let cap = null;
    if(me){
      let assets = 0;
      try { assets = C.assetsOf ? C.assetsOf(s, me) : 0; } catch(e){}
      cap = { cash: +me.cash || 0, assets: +assets || 0, net: +me.netWorth || 0 };
    }
    return {
      room: s.room, gameId: s.gameId || 0, you: String(s.you), phase: s.phase,
      cur: s.phase === "roll" && s.currentPlayerId != null ? String(s.currentPlayerId) : null,
      eventCount: s.eventCount || 0, turn: s.turn || 0,
      round: s.roundNumber || 1, maxRounds: s.maxRounds || 0,
      rollKey, roll: r ? { pid: String(r.playerId), row: r.row, col: r.col } : null,
      players, prices, ctrl, re, cap, fpKey,
      inTrades: new Set((s.pendingTrades || []).filter((t)=> t.toId === s.you).map((t)=> String(t.id))),
      gameOver: s.phase === "ended" && !!s.gameResult,
    };
  }

  // --- Бросок: кости, перекрестие, прилёт клетки ------------------------
  function diffRoll(prev, next, s){
    if(!next.roll || next.rollKey === prev.rollKey) return;
    const r = next.roll, k = next.rollKey;
    // Свой бросок — кости в нижнем листе; чужой или бота — фишка над полем.
    const own = r.pid === next.you && !!document.querySelector('#contextPopup [data-die="row"]');
    const pl = next.players[r.pid];
    const sc = pl && pl.isBot ? 0.7 : 1;
    rollFx = [];
    const reg = (key, sel, cls, opts)=>{ add(key, sel, cls, opts); rollFx.push(key); };
    if(own){
      reg("rr:" + k, "#contextPopup .popup-card", "roll-reveal", { dur: 700 });
      reg("rg:" + k, "#contextPopup .popup-card", "anim-gated", { dur: 700 });
      // Сначала ложится кость строки, затем столбца — порядок объясняет смысл.
      spinDie("dr:" + k, '#contextPopup [data-die="row"]', 380, r.row);
      spinDie("dc:" + k, '#contextPopup [data-die="col"]', 480, r.col, ()=> haptic("light"));
      reg("dlr:" + k, '#contextPopup [data-die="row"]', "anim-die-land", { delay: 380, dur: 260 });
      reg("dlc:" + k, '#contextPopup [data-die="col"]', "anim-die-land", { delay: 480, dur: 260 });
    } else {
      diceChip(r, k, sc, s);
    }
    // И у фишки над полем перекрестие начинается, когда легла кость строки, —
    // иначе клетка «прилетала» раньше, чем останавливались кости. У бота всё
    // укладывается в паузу перед его следующим шагом (1100 мс, scheduleBotPump).
    crosshair(r, k, own ? 380 : Math.round(380 * sc), sc, reg);
  }
  // Перекрестие: метки строки/столбца, бегущая подсветка по линиям, затем
  // «прилёт» выпавшей клетки и её пульсация.
  function crosshair(r, k, t0, sc, reg){
    const hr = r.row, hc = r.col, step = 22 * sc;
    const part = (el, i)=> +((el.dataset.rc || "0-0").split("-")[i]) || 0;
    reg("hr:" + k, `.stage-label[data-row=${q(hr)}]`, "anim-hot", { delay: t0, dur: 320 });
    reg("hc:" + k, `.stage-label[data-col=${q(hc)}]`, "anim-hot", { delay: t0 + 100 * sc, dur: 320 });
    reg("sr:" + k, `.stage-cell[data-rc^="${hr}-"]:not(.active-cell)`, "anim-sweep", { delay: t0, dur: 420 + 12 * step, each: (el)=> part(el, 1) * step });
    reg("sc:" + k, `.stage-cell[data-rc$="-${hc}"]:not(.active-cell)`, "anim-sweep", { delay: t0 + 100 * sc, dur: 420 + 12 * step, each: (el)=> part(el, 0) * step });
    reg("dim:" + k, ".stage-cells.has-roll", "anim-dim", { delay: t0, dur: 300 });
    const land = t0 + 100 * sc + Math.max(hr, hc) * step;
    reg("land:" + k, ".stage-cells.has-roll .stage-cell.active-cell", "anim-land", { delay: land, dur: 500 });
    pulse = { key: k, t: now() + land + 500 };
  }
  // Бросок решён (куплено / пропущено): плавно возвращаем яркость полю.
  function endRoll(prev, next){
    rollFx.forEach((key)=> drop(key));
    rollFx = [];
    writers.forEach((w, key)=>{ if(/^d[rc]:/.test(key)){ w.apply(Infinity); writers.delete(key); } });
    if(next.roll) return;
    const r = prev.roll;
    add("undim:" + prev.rollKey, `.stage-cell:not([data-rc^="${r.row}-"]):not([data-rc$="-${r.col}"])`, "anim-undim", { dur: 350 });
    add("settle:" + prev.rollKey, `.stage-cell[data-rc="${r.row}-${r.col}"]`, "anim-settle", { dur: 300 });
  }
  // Пульсация выпавшей клетки непрерывна, хотя поле пересобирается на каждом
  // состоянии: задержка = момент окончания «прилёта» относительно сейчас.
  function syncPulse(){
    const cell = document.querySelector(".stage-cells.has-roll .stage-cell.active-cell");
    if(!cell) return;
    const k = snap ? snap.rollKey : "";
    if(!pulse || pulse.key !== k) pulse = { key: k, t: now() };
    const d = pulse.t - now();
    cell.style.setProperty("--pulse-delay", (d > 0 ? Math.round(d) : -Math.round(-d % 1600)) + "ms");
  }
  // Фишка с костями над полем для чужого броска (и бота).
  let chipSeq = 0;
  function diceChip(r, k, sc, s){
    const p = (s.players || []).find((x)=> String(x.id) === r.pid);
    const color = C.seatColor ? C.seatColor(s, p ? p.id : null) : "var(--stage-accent)";
    const id = ++chipSeq;
    measure(()=> boardPoint(0.5, 0), (pt)=>{
      if(!pt.rect) return;
      const html = `<span class="anim-chip-dot" style="background:${esc(color)}"></span><span class="anim-chip-name">${esc(p ? p.name : "")}</span>`
        + `<span class="anim-mini-die" data-chipdie="row"><b>${r.row}</b></span><span class="anim-mini-die" data-chipdie="col"><b>${r.col}</b></span>`;
      // Нижний край фишки — на рамке поля: метки строк/столбцов и клетки
      // (перекрестие броска) остаются открытыми.
      const n = spawn("anim-dice-chip", html, pt.x, Math.max(44, pt.y + 10), 1800);
      if(!n) return;
      n.dataset.chip = id;
      const base = `#animLayer [data-chip="${id}"] `;
      spinDie("cr:" + k, base + '[data-chipdie="row"]', 380 * sc, r.row);
      spinDie("cc:" + k, base + '[data-chipdie="col"]', 480 * sc, r.col);
      add("clr:" + k, base + '[data-chipdie="row"]', "anim-die-land", { delay: 380 * sc, dur: 260 });
      add("clc:" + k, base + '[data-chipdie="col"]', "anim-die-land", { delay: 480 * sc, dur: 260 });
    });
  }

  // --- Ход: кольцо на чипе, подсказка на кнопке, баннер ----------------
  function diffTurn(prev, next, s){
    if(next.phase !== "roll" || next.cur == null || prev.cur === next.cur) return;
    const p = next.players[next.cur];
    if(!p || p.bankrupt) return;
    // Номер хода повторяется в каждом раунде — в ключе вместе с номером события.
    const cur = next.cur, turn = next.eventCount + ":" + next.turn;
    add(`turn:${turn}:${cur}`, `.pchip[data-pid=${q(cur)}]`, "anim-turn", { dur: 1200 });
    if(cur !== next.you) return;
    // Офлайн с несколькими людьми — «передайте устройство»: называем, чей ход.
    const humans = (s.players || []).filter((x)=> !x.isBot && !x.bankrupt).length;
    const text = C.mode === "offline" && humans > 1 ? `Ход: ${p.name}` : "Ваш ход";
    const mine = ()=>{
      if(!snap || snap.cur !== cur || snap.eventCount + ":" + snap.turn !== turn) return; // ход уже ушёл
      add("nudge:" + turn, ".dock-main.roll-btn", "anim-nudge", { delay: 150, dur: 900 });
      haptic("light");
      measure(()=> boardPoint(0.5, 0.18), (pt)=> spawn("anim-banner", esc(text), pt.x, pt.y, 1600));
    };
    // Конец раунда: сводка события закрывает стол — покажем после её закрытия.
    if(eventOpen()) deferred.push(mine); else mine();
  }

  // --- Деньги: всплывающие суммы и плавные счётчики --------------------
  function diffCash(prev, next){
    let i = 0;
    Object.keys(next.players).forEach((id)=>{
      const a = prev.players[id], b = next.players[id];
      // Только что выбывший: над его чипом уже плашка «Банкрот» на том же месте.
      if(!a || !b || (b.bankrupt && !a.bankrupt)) return;
      const d = Math.round(b.cash - a.cash);
      if(Math.abs(d) < 1) return;
      const delay = (i++) * 60;
      measure(()=> chipRect(id), (r)=>{ if(r) floatAt("p" + id, r, d, delay); });
      if(id === next.you && prev.you === next.you){
        measure(()=> visibleRect(document.querySelector('[data-num="cash"]')), (r)=>{ if(r) floatAt("cash", r, d, delay); });
      }
    });
  }
  function flash(sel, up){
    dropSlot(sel, up ? "anim-loss" : "anim-gain");
    add(`fl:${gen}:${sel}`, sel, up ? "anim-gain" : "anim-loss", { dur: 800 });
  }
  function diffTicks(prev, next){
    const F = C.fmt || ((n)=> String(Math.round(n)));
    const FS = C.fmtShort || F;
    if(prev.you === next.you && prev.cap && next.cap){
      ["cash", "assets", "net"].forEach((k)=>{
        const a = prev.cap[k], b = next.cap[k];
        if(Math.abs(b - a) < 1) return;
        // Активы и капитал меняются на каждом броске (фон рынка: до ±1,5% ×
        // волатильность 1,6 = 2,4%) — их подсвечиваем только при изменении
        // заметнее этого шума (покупка, PR, событие, IPO), наличные — всегда.
        const big = k === "cash" || Math.abs(b - a) >= Math.max(1, Math.abs(a)) * 0.03;
        // От $1 000 000 полоса показывает $1,2M с подсказкой — такие не пересчитываем.
        const compact = Math.max(Math.abs(a), Math.abs(b)) >= 1e6;
        const sels = [`[data-num="${k}"]`].concat(k === "net" ? ['[data-num="net-big"]'] : []);
        sels.forEach((sel)=>{
          if(sel !== '[data-num="net-big"]' && compact){ if(big) flash(sel, b > a); return; }
          tween("num:" + sel, sel, a, b, 450, F);
          if(big) flash(sel, b > a);
        });
      });
    }
    Object.keys(next.players).forEach((id)=>{
      const a = prev.players[id], b = next.players[id];
      if(!a || !b || Math.abs(b.net - a.net) < 1) return;
      const sel = `[data-num=${q("pw-" + id)}]`;
      tween("num:" + sel, sel, a.net, b.net, 350, FS);
    });
  }

  // --- Поле: смена контроля и владельцев, скачки цен --------------------
  function diffOwners(prev, next, s){
    let n = 0;
    const seat = (id)=> C.seatColor ? C.seatColor(s, +id) : "var(--stage-accent)";
    const mark = (sel, owner, popSel)=>{
      if(n >= 8) return; // ликвидация банкрота меняет многое разом — не больше 8
      const delay = (n++) * 50;
      if(owner && popSel) add(`pop:${gen}:${popSel}`, popSel, "anim-pop", { delay, dur: 500 });
      add(`own:${gen}:${sel}`, sel, "anim-owned", { delay, dur: 800, vars: { "--flash": owner ? seat(owner) : "var(--down)" } });
    };
    Object.keys(next.ctrl).forEach((t)=>{
      if(!(t in prev.ctrl) || prev.ctrl[t] === next.ctrl[t]) return;
      const sel = `.stage-cell[data-ticker=${q(t)}]`;
      mark(sel, next.ctrl[t], sel + " .cell-owner");
    });
    Object.keys(next.re).forEach((id)=>{
      const a = prev.re[id], b = next.re[id];
      if(!a) return;
      const sel = `.stage-cell[data-city=${q(id)}]`;
      if(a.owner !== b.owner) mark(sel, b.owner, sel + " .cell-owner");
      else if(b.level > a.level && n < 8) add(`lvl:${gen}:${id}`, sel + " .re-stars", "anim-pop", { delay: (n++) * 50, dur: 500 });
    });
  }
  function diffPrices(prev, next){
    // Фоновое дрожание рынка двигает все цены на каждом броске: на поле —
    // только крупные скачки (PR, негатив, IPO, крупные покупки), в таблице
    // «Биржи» — тонкая подсветка цифры, и только когда она открыта.
    const sameEvent = next.eventCount === prev.eventCount;
    const table = C.activeTab === "market";
    Object.keys(next.prices).forEach((t, i)=>{
      const a = prev.prices[t], b = next.prices[t];
      if(!a || a === b) return;
      const pct = (b - a) / a, up = pct > 0;
      const cls = up ? "anim-px-up" : "anim-px-down", other = up ? "anim-px-down" : "anim-px-up";
      if(sameEvent && Math.abs(pct) >= 0.04){
        const sel = `.stage-cell[data-ticker=${q(t)}]`;
        dropSlot(sel, other);
        add(`px:${gen}:${t}`, sel, cls, { dur: 800 });
      }
      if(table && Math.abs(pct) >= 0.001){
        const row = `#marketBody tr[data-ticker=${q(t)}]`, delay = (i % 10) * 20;
        dropSlot(row + " td.price", other);
        add(`pxt:${gen}:${t}`, row + " td.price", cls, { delay, dur: 900 });
        add(`pxd:${gen}:${t}`, row + " .delta", "anim-pop", { delay, dur: 350 });
      }
    });
  }
  // Биржевое событие: после закрытия сводки по полю проходит волна
  // зелёного/красного над компаниями, чья цена заметно изменилась.
  function diffEvent(prev, next){
    if(next.eventCount <= prev.eventCount) return;
    const list = [];
    Object.keys(next.prices).forEach((t)=>{
      const a = prev.prices[t], b = next.prices[t];
      if(!a) return;
      const pct = (b - a) / a * 100;
      if(Math.abs(pct) >= 0.5) list.push({ t, pct });
    });
    if(!list.length) return;
    const ec = next.eventCount;
    const play = ()=>{
      if(!snap || snap.eventCount !== ec) return;
      list.forEach((it)=>{
        const sel = `.stage-cell[data-ticker=${q(it.t)}]`;
        const cell = document.querySelector(sel);
        const rc = (cell && cell.dataset.rc ? cell.dataset.rc : "6-6").split("-").map(Number);
        add(`wave:${ec}:${it.t}`, sel, it.pct > 0 ? "anim-wave-up" : "anim-wave-down", {
          delay: Math.min(380, (rc[0] + rc[1]) * 16), dur: 650,
          vars: { "--wave-a": Math.min(0.75, 0.25 + Math.abs(it.pct) / 20).toFixed(2) },
        });
      });
    };
    if(eventOpen()) deferred.push(play); else play();
  }

  // --- Сделки, банкротство, конец партии --------------------------------
  function diffTrades(prev, next){
    if(prev.you !== next.you) return;
    let fresh = false;
    next.inTrades.forEach((id)=>{
      if(prev.inTrades.has(id)) return;
      add(`offer:${next.room}:${id}`, `.trade-offer[data-trade-id=${q(id)}]`, "anim-offer-in", { dur: 650 });
      fresh = true;
    });
    if(!fresh) return;
    haptic("light");
    measure(()=> document.querySelector('.tab-btn[data-tab="capital"]'), (btn)=>{
      if(!btn) return;
      retrigger(btn, "anim-bump");
      later(()=> btn.classList.remove("anim-bump"), 600);
    });
  }
  function diffBankrupt(prev, next){
    let any = false;
    Object.keys(next.players).forEach((id)=>{
      const a = prev.players[id], b = next.players[id];
      if(!a || !b || a.bankrupt || !b.bankrupt) return;
      any = true;
      add(`bk:${gen}:${id}`, `.pchip[data-pid=${q(id)}]`, "anim-bankrupt", { dur: 1050 });
      // Исключённого голосованием движок тоже помечает банкротом, но это не
      // крах на рынке: другая подпись и без «землетрясения» поля.
      measure(()=> chipRect(id), (r)=>{
        if(!r) return;
        const n = spawn("anim-float bk", "", r.left + r.width / 2, r.top - 4, 1500);
        if(n) n.textContent = b.kicked ? "Исключён" : "Банкрот";
      });
      if(id === next.you && !b.kicked){
        add("quake:" + gen, "#tableBody .stage-board", "anim-quake", { dur: 450 });
        haptic("heavy");
      }
    });
    return any;
  }
  function diffEnd(prev, next, s, afterBankrupt){
    if(prev.gameOver || !next.gameOver) return;
    const gr = s.gameResult;
    const winner = String(gr.winnerId);
    const room = next.room;
    const show = (deferredShow)=>{
      if(!snap || !snap.gameOver || snap.room !== room) return;
      // Лист итогов въезжает один раз, места — по очереди (см. --i в шаблоне).
      add(`end:${room}:${winner}`, "#contextPopup .popup-card", "roll-reveal", { dur: 1100 });
      // Офлайн празднуем победу любого человека за устройством, но не бота.
      const wp = snap.players[winner];
      if(winner === snap.you || (C.mode === "offline" && wp && !wp.isBot)){
        later(()=>{ confettiBurst(); if(winner === snap.you) haptic("medium"); }, afterBankrupt && !deferredShow ? 350 : 120);
      } else {
        add(`win:${room}:${winner}`, `.pchip[data-pid=${q(winner)}]`, "anim-turn", { dur: 1200, vars: { "--ring": "#E0B168" } });
      }
    };
    // Последний раунд кончается событием: пока открыта его сводка, финал
    // ждёт — иначе конфетти и въезд листа прошли бы под затемнением.
    if(eventOpen()) deferred.push(()=> show(true)); else show(false);
  }
  function diffFpWait(prev, next){
    if(prev.fpKey && prev.fpKey !== next.fpKey) drop("fp:" + prev.fpKey);
    if(next.fpKey && next.fpKey !== prev.fpKey) add("fp:" + next.fpKey, "#contextPopup .popup-card", "roll-reveal", { dur: 400 });
  }
  // Партия с лимитом раундов: метка финала в шапке (index.html, statusRowHtml,
  // класс g-final) вспыхивает на каждом новом раунде финала. Метка есть только
  // в последних раундах — раньше селектор просто ничего не находит. Пока
  // открыта сводка события, ждём её закрытия, как «Ваш ход».
  function diffFinal(prev, next){
    if(!next.maxRounds || next.phase !== "roll" || next.round <= prev.round) return;
    const round = next.round, key = `final:${next.room}:${next.gameId}:${round}`;
    const play = ()=>{
      if(!snap || snap.round !== round || snap.phase !== "roll") return;
      add(key, "#cornerStatus .g-final", "anim-final", { dur: 1400 });
    };
    if(eventOpen()) deferred.push(play); else play();
  }

  // --- Конфетти победы -------------------------------------------------
  function killConfetti(){
    if(confetti){ confetti.cv.remove(); confetti = null; }
  }
  function confettiBurst(){
    if(reduced() || document.hidden) return;
    killConfetti();
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = document.createElement("canvas");
    cv.className = "anim-confetti";
    cv.setAttribute("aria-hidden", "true");
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    const ctx = cv.getContext("2d");
    if(!ctx) return;
    const icon = visibleRect(document.querySelector("#contextPopup .end-screen-icon"));
    const ox = icon ? icon.left + icon.width / 2 : W / 2;
    const oy = icon ? icon.top + icon.height / 2 : H * 0.35;
    const parts = [];
    const count = W < 600 ? 70 : 110;
    for(let i = 0; i < count; i++){
      parts.push({
        x: ox, y: oy,
        vx: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 5),
        vy: -(7 + Math.random() * 6),
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.4,
        tilt: Math.random() * Math.PI * 2, vt: 0.08 + Math.random() * 0.2,
        c: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      });
    }
    document.body.appendChild(cv);
    const t0 = now();
    let last = t0;
    confetti = {
      cv,
      step(t){
        const age = t - t0;
        if(age >= 2600 || document.hidden) return false;
        // Физика рассчитана на 60 кадров/с — на экранах 120 Гц шаг меньше.
        const k = Math.min(3, Math.max(0, (t - last) / 16.67));
        last = t;
        const drag = Math.pow(0.985, k);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.globalAlpha = age > 1900 ? Math.max(0, (2600 - age) / 700) : 1;
        for(const p of parts){
          p.vx *= drag;
          p.vy = p.vy * drag + 0.28 * k;
          p.x += p.vx * k; p.y += p.vy * k;
          p.rot += p.vr * k; p.tilt += p.vt * k;
          if(p.y > H + 20) continue;
          const cos = Math.cos(p.rot) * dpr, sin = Math.sin(p.rot) * dpr;
          ctx.setTransform(cos, sin, -sin, cos, p.x * dpr, p.y * dpr);
          const w = 5 * Math.abs(Math.cos(p.tilt)) + 0.6; // «трепет» листика
          ctx.fillStyle = p.c;
          ctx.fillRect(-w / 2, -4.5, w, 9);
        }
        return true;
      },
    };
    kick();
  }

  // --- Публичное API ----------------------------------------------------
  // Досрочно завершить всё: итоговые цифры, без классов, без наложений.
  function settle(){
    writers.forEach((w)=>{ try { w.apply(Infinity); } catch(e){} });
    writers.clear();
    Array.from(fx.keys()).forEach((k)=> drop(k));
    timers.forEach(clearTimeout);
    timers.clear();
    deferred.length = 0;
    floats.clear();
    io = [];
    rollFx = [];
    const L = document.getElementById("animLayer");
    if(L) L.textContent = "";
    // Кнопка вкладки постоянна, и класс с неё снимал только таймер later(),
    // снятый выше, — иначе «прыжок» повторялся бы при каждом показе #app.
    document.querySelectorAll(".anim-bump").forEach((el)=> el.classList.remove("anim-bump"));
    killConfetti();
    if(raf){ cancelAnimationFrame(raf); raf = 0; }
  }
  // Сброс при выходе со стола (меню, лобби, правила) и переподключении:
  // следующее состояние только запоминается, без «догоняющих» эффектов.
  function reset(){
    try {
      settle();
      snap = null; lastState = null; pulse = null;
    } catch(e){ console.error(e); }
  }
  function afterRender(s, ctx){
    if(!s) return;
    try {
      C = ctx || C;
      // Перерисовка того же объекта (раскрытие акции, возврат из правил).
      if(s === lastState){ syncPulse(); reapply(); return; }
      lastState = s;
      const prev = snap, next = snapshot(s);
      snap = next;
      // «Запомнить без анимации»: первое состояние, другая комната, лобби,
      // новая партия (другой gameId, счётчики пошли назад или «конец» сменился
      // игрой), скрытая вкладка, сокращённые анимации. turn считается внутри
      // раунда и после каждого события снова 1 — назад он идёт только в том же
      // раунде. gameId ловит и сброс на первом же ходу, когда счётчики совпали.
      const newGame = !!prev && (prev.room !== next.room || prev.gameId !== next.gameId || next.eventCount < prev.eventCount
        || (next.eventCount === prev.eventCount && next.turn < prev.turn)
        || (prev.phase === "ended" && next.phase !== "ended"));
      // Стол не на экране (открыты правила, а боты офлайн играют дальше):
      // только запоминаем — иначе конфетти и вибрация сработали бы поверх правил.
      const app = document.getElementById("app");
      const offTable = !app || getComputedStyle(app).display === "none";
      if(!prev || newGame || next.phase === "lobby" || prev.phase === "lobby" || document.hidden || offTable || reduced()){
        if(newGame || reduced()) settle();
        syncPulse();
        reapply();
        return;
      }
      gen++;
      if(prev.roll && next.rollKey !== prev.rollKey) endRoll(prev, next);
      const bankrupt = diffBankrupt(prev, next);
      diffRoll(prev, next, s);
      diffTurn(prev, next, s);
      diffCash(prev, next);
      diffTicks(prev, next);
      diffOwners(prev, next, s);
      diffPrices(prev, next);
      diffEvent(prev, next);
      diffTrades(prev, next);
      diffEnd(prev, next, s, bankrupt);
      diffFpWait(prev, next);
      diffFinal(prev, next);
      flushIO();
      syncPulse();
      reapply();
    } catch(e){
      // Анимации никогда не должны ломать партию (после render() идут
      // автосохранение и ход ботов).
      console.error(e);
    }
  }
  // Карточка биржевого события: переворот и строки по очереди. Модалку
  // render() не пересобирает, поэтому хватает перезапуска через reflow.
  function eventCardIn(card){
    if(!card || reduced()) return;
    try {
      card.querySelectorAll(".cap-row, .log-entry").forEach((el, i)=> el.style.setProperty("--i", Math.min(i, 12)));
      // Карточка события (правила 3): шапка, заголовок, затем последствия по очереди.
      card.querySelectorAll(".ev-card-top, .ev-title, .ev-desc").forEach((el, i)=> el.style.setProperty("--i", i));
      card.querySelectorAll(".ev-chip, .ev-cons-row, .board-dec").forEach((el, i)=> el.style.setProperty("--i", Math.min(i, 14)));
      retrigger(card, "anim-flip");
    } catch(e){ console.error(e); }
  }
  // Сводка события закрыта — проигрываем то, что ждало (волна, «Ваш ход»).
  function flushDeferred(){
    try {
      const list = deferred.splice(0);
      list.forEach((fn)=> fn());
      flushIO();
      reapply();
    } catch(e){ console.error(e); }
  }
  // Короткое проявление содержимого после частичной перерисовки (подвкладки).
  function fade(sel){
    if(reduced()) return;
    add("fade:" + now(), sel, "anim-fade", { dur: 220 });
    reapply();
  }
  if(MQ){
    const onMq = ()=>{ if(MQ.matches) settle(); };
    if(MQ.addEventListener) MQ.addEventListener("change", onMq);
    else if(MQ.addListener) MQ.addListener(onMq);
  }

  // reapply() — после частичных перерисовок (лента чипов по таймеру, фильтры
  // «Биржи», подвкладки «Портфеля»). Фазу пульсации здесь не трогаем: поле
  // не пересобиралось, и смена задержки у идущей анимации дала бы рывок.
  window.Anim = {
    afterRender, reset, eventCardIn, flushDeferred, reduced, fade,
    reapply(){ try { reapply(); } catch(e){ console.error(e); } },
  };
})();
