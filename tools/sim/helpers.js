"use strict";
// ---------------------------------------------------------------------
// Контекст решений для профилей стратегий (tools/sim/profiles.js).
// Даёт профилю доступ к движку и типовые расчёты: свободные доли, стоимость
// покупки с комиссией, плата за отказ, стоимость мер контроля и т.п.
// Стоимости берутся из внутренних функций движка (их отдаёт крючок
// engine-loader), а если движок их переименовал — из копий формул ниже.
// Профили видят все пакеты соперников (упрощение симуляции: в игре чужие
// портфели скрыты до шпионажа, но доля компании «в руках игроков» публична).
// ---------------------------------------------------------------------

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Действие для драйвера: имя функции движка + аргументы после (room, playerId).
function act(type, ...args) { return { type, args }; }
function actionSig(a) { return a ? a.type + ":" + JSON.stringify(a.args || []) : ""; }

function makeCtx(S, me) {
  const { E, I, room } = S;
  const startCash = S.startCash;
  let mem = S.mem.get(me.id);
  if (!mem) { mem = {}; S.mem.set(me.id, mem); }

  const ctx = {
    E, I, room, me, mem, startCash,
    rng: S.rng,
    cfg: S.cfg,
    tried: S.phase.tried, // подписи действий, уже отклонённых движком в этой фазе хода
    act,

    // --- компании ---
    live() { return E.COMPANIES.filter((c) => !room.companies[c.ticker].merged); },
    price(t) { return room.companies[t].price; },
    tier(t) { return E.companyByTicker(t).tier; },
    sector(t) { return E.companyByTicker(t).sector; },
    vol(t) { return (E.TIER_VOL && E.TIER_VOL[ctx.tier(t)]) || 1; },
    held(t, p) { return ((p || me).holdings[t]) || 0; },
    free(t) { return 100 - E.totalOwnedPct(room, t); },
    others() { return room.players.filter((p) => p.id !== me.id && !p.bankrupt); },
    othersPct(t) { return ctx.others().reduce((s, p) => s + (p.holdings[t] || 0), 0); },
    owners(t) { return ctx.others().filter((p) => (p.holdings[t] || 0) > 0); },
    // Единоличный контролёр (кроме меня): единственный другой держатель с >50%.
    controller(t) {
      const o = ctx.owners(t);
      return o.length === 1 && o[0].holdings[t] > 50 ? o[0] : null;
    },
    controlled() { return E.controlledTickers(room, me.id).filter((t) => !room.companies[t].merged); },
    myTickers() { return ctx.live().map((c) => c.ticker).filter((t) => ctx.held(t) > 0); },
    atFloor(t) { const c = E.companyByTicker(t); return room.companies[t].price <= E.TIER_PRICE[c.tier] * 0.1 * 1.0001; },

    // --- деньги ---
    feePct() { return E.bankFeePct(me.reputation); },
    buyCost(t, pct) { return ctx.price(t) * (pct / 100) * (1 + ctx.feePct()); },
    // Сколько % можно купить на budget (с учётом комиссии, лимита 25% за бросок и свободных акций).
    affordablePct(t, budget) {
      const per = ctx.buyCost(t, 1);
      if (!(per > 0) || !(budget > 0)) return 0;
      const pct = Math.floor((budget - 1e-6) / per);
      return clamp(pct, 0, Math.min(25, ctx.free(t)));
    },
    nw(p) { return E.netWorth(room, p || me); },
    stockValue(p) {
      p = p || me;
      let v = 0;
      for (const t in p.holdings) v += ((p.holdings[t] || 0) / 100) * room.companies[t].price;
      return v;
    },
    reOwned(p) { p = p || me; return E.CITIES.filter((ct) => room.realEstate[ct.id].ownerId === p.id).map((ct) => ct.id); },
    reCost(cityId) { return E.realEstatePrice(room, cityId) * (1 + ctx.feePct()); },
    forcedPct(tier) {
      if (typeof I.getForcedPaymentPct === "function") return I.getForcedPaymentPct(room, tier);
      const arr = room.settings && room.settings.tierForcedPaymentPct;
      if (Array.isArray(arr) && arr.length === 3) return (arr[tier === "A" ? 0 : tier === "B" ? 1 : 2] || 0) / 100;
      return (E.TIER_FORCED_PAYMENT_PCT && E.TIER_FORCED_PAYMENT_PCT[tier]) || 0.05;
    },
    // Плата за отказ от покупки (как в dividendFromRoll), без учёта шанса пропуска.
    refuseCost(t) {
      const others = ctx.othersPct(t);
      if (others <= 0 || ctx.controller(t)) return 0;
      if (typeof I.refuseRollAmount === "function") return I.refuseRollAmount(room, t, others);
      const c = room.companies[t];
      const tier = ctx.tier(t);
      const squeeze = c.fullyOwned ? 3 : (c.squeezedOut ? 2 : 1);
      return c.price * ctx.forcedPct(tier) * (others / 100) * (room.dividendMultiplier || 1) * squeeze * ((E.TIER_DIVIDEND_MULT && E.TIER_DIVIDEND_MULT[tier]) || 1);
    },
    // Ожидаемая плата за отказ — с учётом шанса, что выплату пропустят.
    expectedRefuseCost(t) {
      const skip = (E.TIER_DIVIDEND_SKIP_CHANCE && E.TIER_DIVIDEND_SKIP_CHANCE[ctx.tier(t)]) || 0.12;
      return ctx.refuseCost(t) * (1 - skip);
    },
    // «Справедливая» цена выкупа, от которой движок считает завышение (setForcedPrice).
    fairForcedPrice(t, controllerP) {
      const held = ctx.held(t, controllerP || me);
      return ctx.price(t) * ctx.forcedPct(ctx.tier(t)) * (held / 100);
    },
    excessiveMult() { return Number.isFinite(I.FORCED_PRICE_EXCESSIVE_MULT) ? I.FORCED_PRICE_EXCESSIVE_MULT : 4; },

    // --- стоимость мер (внутренние функции движка или копии формул) ---
    cost: {
      espionage: () => (I.espionageCost ? I.espionageCost(room, me) : clamp(Math.round(ctx.nw() * 0.05), 6000, 45000)),
      negativeInfo: () => (I.negativeInfoCost ? I.negativeInfoCost(room, me) : clamp(Math.round(ctx.nw() * 0.06), 8000, 55000)),
      insiderPeek: () => (I.insiderPeekCost ? I.insiderPeekCost(room, me) : clamp(Math.round(ctx.nw() * 0.03), 4000, 28000)),
      shortDeposit: () => (I.shortDepositCost ? I.shortDepositCost(room, me) : clamp(Math.round(ctx.nw() * 0.04), 4000, 32000)),
      discredit: (target) => (I.discreditCost ? I.discreditCost(room, me, target)
        : clamp(Math.round(ctx.nw() * 0.05) + (target.reputation == null ? 50 : target.reputation) * 250, 6000, 80000)),
      personalPr: () => (I.personalPrCostFor ? I.personalPrCostFor(room, me)
        : Math.max(5000 + 3000 * (me.personalPrCount || 0), Math.round(ctx.nw() * 0.03))),
      squeeze: (t) => {
        if (I.squeezeOutCost) return I.squeezeOutCost(room, me, t);
        return ctx.owners(t).reduce((s, x) => s + ctx.price(t) * (x.holdings[t] / 100), 0);
      },
      investigate: () => (E.investigationCost ? E.investigationCost(room, me) : 5000),
      publicIpo: () => Math.max(5000, Math.round(Math.max(0, ctx.nw()) * 0.08)),
      pr: (t) => ctx.price(t) * 0.05,
    },

    // Продать акции банку, чтобы набрать need наличных: одна продажа ≤25% одного
    // тикера за вызов (драйвер переспросит профиль на следующем шаге). Контрольные
    // пакеты (>50%) не трогаем. null — продавать нечего или не хватит всё равно.
    sellToRaise(need) {
      if (!(need > 0)) return null;
      const pos = ctx.myTickers()
        .filter((t) => ctx.held(t) <= 50)
        .map((t) => ({ t, value: ctx.price(t) * ctx.held(t) / 100 }))
        .sort((a, b) => b.value - a.value || (a.t < b.t ? -1 : 1));
      const total = pos.reduce((s, x) => s + x.value, 0);
      if (!pos.length || total < need) return null;
      const { t } = pos[0];
      const pct = clamp(Math.ceil(need / (ctx.price(t) / 100)), 1, Math.min(25, ctx.held(t)));
      return act("sellBank", t, pct);
    },

    // Не повторять действие, которое движок уже отклонил в этой фазе хода.
    fresh(a) { return a && !ctx.tried.has(actionSig(a)) ? a : null; },
    pick(arr) { return arr.length ? arr[Math.floor(ctx.rng() * arr.length)] : undefined; },
  };
  return ctx;
}

module.exports = { makeCtx, act, actionSig, clamp };
