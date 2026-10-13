"use strict";
// ---------------------------------------------------------------------
// Профили стратегий ботов для симулятора баланса (tools/sim).
//
// Профиль — набор НЕОБЯЗАТЕЛЬНЫХ «крючков» решений. Чего профиль не
// переопределяет, решает сам движок (engine.botStep), поэтому партия никогда
// не встаёт на обязательствах: оплата назначенной цены выкупа, рента за
// чужой город и ответы на сделки всегда доводятся до конца.
//
// Крючок получает ctx (см. helpers.js) и возвращает действие act(type, ...args)
// — имя функции движка и аргументы после (room, playerId) — или null = «как движок».
//   preRoll(ctx)            до броска: меры контроля, кредиты, продажи, сделки.
//                           act("rollDice") — бросить, не отдавая ход мерам движка;
//   stock(ctx, roll)        бросок на компанию: act("buyFromRoll", pct) / act("dividendFromRoll")
//                           (отказ) или промежуточное действие (sellBank, takeLoan…);
//   realEstate(ctx, roll)   бросок на свободный или свой город: buyRealEstateFromRoll /
//                           upgradeRealEstateFromRoll / skipRoll (ренту за чужой драйвер платит сам);
//   postRoll(ctx)           после броска до конца хода; null = endTurn;
//   forcedPrice(ctx, info)  я единоличный контролёр (>50%) — сумма выкупа (число) или null;
//   respondTrade(ctx, t)    входящая сделка: true / false / null (как движок);
//   insider(ctx, card)      подсмотренная карта: "moveToBack" | "keep".
// Ошибочное действие драйвер запоминает (ctx.tried) и не даёт повторить в той же
// фазе хода; после лимита действий за фазу ход принудительно идёт дальше.
// ---------------------------------------------------------------------
const { act } = require("./helpers");

const buy = (pct) => act("buyFromRoll", pct);
const refuse = () => act("dividendFromRoll");

// Купить 1%, если это дешевле ожидаемой платы за отказ (и деньги есть).
function dodgePct(ctx, t) {
  if (ctx.free(t) < 1) return 0;
  const one = ctx.buyCost(t, 1);
  return ctx.expectedRefuseCost(t) > one && ctx.me.cash >= one ? 1 : 0;
}

const PROFILES = {
  // Чистый engine.botStep — эталон, с которым сравниваются остальные.
  engine: {
    pure: true,
    desc: "Бот движка как есть (engine.botStep): случайная доля до 35% свободного кэша, редкие меры.",
  },

  // Сильный бот движка (engine.botStep с botLevel "strong", подписка «Трейдер»).
  strong: {
    pure: true,
    botLevel: "strong",
    desc: "Сильный бот движка (botLevel \"strong\"): максимум доступного на бросок при резерве $15 000, города без случайных пропусков.",
  },

  passive: {
    desc: "Ничего не покупает (ни акций, ни недвижимости), всегда отказывается и платит, мер не применяет.",
    preRoll: (ctx) => act("rollDice"),
    stock: (ctx) => refuse(),
    realEstate: (ctx) => act("skipRoll"),
    postRoll: () => act("endTurn"),
    respondTrade: () => false,
  },

  greedy: {
    desc: "Покупает максимум доступного (до 25%) при каждом броске и любую недвижимость/улучшение, на что хватает денег.",
    stock(ctx, roll) {
      const pct = ctx.affordablePct(roll.ticker, ctx.me.cash);
      return pct >= 1 ? buy(pct) : refuse();
    },
    realEstate(ctx, roll) {
      const re = ctx.room.realEstate[roll.realEstateId];
      if (!re.ownerId) return ctx.me.cash >= ctx.reCost(roll.realEstateId) ? act("buyRealEstateFromRoll") : act("skipRoll");
      if ((re.level || 0) < ctx.E.MAX_RE_LEVEL && ctx.me.cash >= ctx.E.realEstateUpgradeCost(ctx.room, roll.realEstateId)) return act("upgradeRealEstateFromRoll");
      return act("skipRoll");
    },
  },

  saver: {
    desc: "Держит крупный резерв (50% старта или 30% капитала), покупает понемногу (≤5%); 1% — если это дешевле платы за отказ.",
    reserve: (ctx) => Math.max(0.5 * ctx.startCash, 0.3 * ctx.nw()),
    preRoll: (ctx) => act("rollDice"),
    stock(ctx, roll) {
      const t = roll.ticker;
      let pct = Math.min(5, ctx.affordablePct(t, ctx.me.cash - PROFILES.saver.reserve(ctx)));
      if (pct < 1) pct = dodgePct(ctx, t);
      return pct >= 1 ? buy(pct) : refuse();
    },
    realEstate(ctx, roll) {
      const re = ctx.room.realEstate[roll.realEstateId];
      const reserve = PROFILES.saver.reserve(ctx);
      if (!re.ownerId) return ctx.me.cash - ctx.reCost(roll.realEstateId) >= reserve ? act("buyRealEstateFromRoll") : act("skipRoll");
      if ((re.level || 0) < ctx.E.MAX_RE_LEVEL && ctx.me.cash - ctx.E.realEstateUpgradeCost(ctx.room, roll.realEstateId) >= reserve) return act("upgradeRealEstateFromRoll");
      return act("skipRoll");
    },
    postRoll(ctx) {
      const loan = ctx.me.loan;
      if (loan && ctx.me.cash - loan.principal >= PROFILES.saver.reserve(ctx)) return ctx.fresh(act("repayLoan", Math.ceil(loan.principal)));
      return null;
    },
  },

  controller: {
    desc: "Концентрируется на ≤3 компаниях до >50% (покупки + бартер), затем PR своих, негатив по чужим, сквиз-аут, инсайд, слияния; цену выкупа ставит у порога завышения.",
    // Фокус — до трёх компаний с моей долей (≤50%), где контроль ещё достижим.
    focus(ctx) {
      return ctx.live()
        .map((c) => c.ticker)
        .filter((t) => ctx.held(t) > 0 && ctx.held(t) <= 50 && ctx.othersPct(t) < 50)
        .sort((a, b) => ctx.held(b) - ctx.held(a) || (a < b ? -1 : 1))
        .slice(0, 3);
    },
    stock(ctx, roll) {
      const t = roll.ticker;
      const mine = ctx.held(t);
      const focus = PROFILES.controller.focus(ctx);
      let pct = 0;
      if (mine > 50) {
        // Уже контроль: добираем к 75% (сквиз-аут) и 100% (поглощение), если деньги лишние.
        pct = ctx.affordablePct(t, ctx.me.cash - 0.25 * ctx.startCash);
      } else if (focus.includes(t) || (focus.length < 3 && mine === 0 && ctx.othersPct(t) < 50)) {
        pct = ctx.affordablePct(t, ctx.me.cash - 0.1 * ctx.startCash);
      } else {
        // Вне фокуса: небольшой пакет как разменная монета для бартера — только при запасе.
        pct = Math.min(5, ctx.affordablePct(t, ctx.me.cash - 0.6 * ctx.startCash));
        if (pct < 1) pct = dodgePct(ctx, t);
      }
      return pct >= 1 ? buy(pct) : refuse();
    },
    preRoll(ctx) {
      const { room, me, E } = ctx;
      const ev = room.eventCount;
      const reserve = 0.15 * ctx.startCash;
      const mine = ctx.controlled();
      if (!room.frozen && mine.length) {
        // 1) Слияние: 2+ полностью своих компании одного сектора.
        if (room.lastMergeEvent !== ev) {
          const full = mine.filter((t) => room.companies[t].fullyOwned && ctx.held(t) >= 100);
          const bySector = {};
          full.forEach((t) => { (bySector[ctx.sector(t)] = bySector[ctx.sector(t)] || []).push(t); });
          for (const sec of Object.keys(bySector).sort()) {
            const list = bySector[sec].sort((a, b) => ctx.price(b) - ctx.price(a));
            if (list.length >= 2) {
              const a = ctx.fresh(act("ctrlMergeCompanies", list[0], list.slice(1)));
              if (a) return a;
            }
          }
        }
        // 2) Сквиз-аут: >75% и есть миноритарии.
        for (const t of mine) {
          if (ctx.held(t) > 75 && ctx.owners(t).length && me.cash - ctx.cost.squeeze(t) >= reserve) {
            const a = ctx.fresh(act("ctrlSqueezeOut", t));
            if (a) return a;
          }
        }
        // 3) PR своих — когда прирост моего пакета окупает цену PR с запасом 10%.
        const prs = mine
          .filter((t) => room.companies[t].lastPrEvent !== ev && (ctx.held(t) / 100) * 0.1 * ctx.vol(t) * ctx.price(t) >= 1.1 * ctx.cost.pr(t))
          .sort((a, b) => ctx.held(b) * ctx.price(b) - ctx.held(a) * ctx.price(a));
        for (const t of prs) {
          if (me.cash - ctx.cost.pr(t) >= reserve) {
            const a = ctx.fresh(act("ctrlPrCampaign", t));
            if (a) return a;
          }
        }
        // 4) Негатив по компании, где у соперников больше всего денег (раз в событие).
        if (ctx.mem.lastNegEvent !== ev) {
          const best = ctx.live()
            .map((c) => c.ticker)
            .filter((t) => !mine.includes(t) && ctx.held(t) < 10 && ev - room.companies[t].lastNegInfoEvent >= 2 && !ctx.atFloor(t))
            .map((t) => ({ t, dmg: (ctx.othersPct(t) / 100) * ctx.price(t) * 0.15 * ctx.vol(t) }))
            .sort((a, b) => b.dmg - a.dmg || (a.t < b.t ? -1 : 1))[0];
          const cost = best ? ctx.cost.negativeInfo(best.t) : 0;
          if (best && best.dmg >= 0.6 * cost && me.cash - cost >= reserve) {
            const a = ctx.fresh(act("ctrlNegativeInfo", best.t));
            if (a) { ctx.mem.lastNegEvent = ev; return a; }
          }
        }
        // 5) Инсайд (раз в событие): окупается, только когда портфель велик — плохая
        // глобальная карта (−10%) должна стоить заметно дороже самого подсматривания.
        const peek = ctx.cost.insiderPeek();
        if (room.insiderUsedEvent[me.id] !== ev && !room.pendingInsider && ctx.stockValue() >= 15 * peek && me.cash - peek >= reserve) {
          const a = ctx.fresh(act("ctrlInsiderPeek"));
          if (a) return a;
        }
      }
      // 6) Народное IPO против чужой монополии, если урон соперника окупает цену.
      if (!room.frozen) {
        const ipoCost = ctx.cost.publicIpo();
        for (const c of ctx.live()) {
          const t = c.ticker;
          if (!room.companies[t].fullyOwned || ctx.held(t) >= 100) continue;
          const dmg = ctx.price(t) * (0.25 + 0.75 * 0.12 * ctx.vol(t));
          if (dmg >= ipoCost && me.cash - ipoCost >= reserve) {
            const a = ctx.fresh(act("ctrlPublicIPO", t));
            if (a) return a;
          }
        }
      }
      // 7) Бартер: свой пакет вне фокуса — за долю соперника в компании из фокуса.
      const key = ev + ":" + room.turn;
      if (ctx.mem.lastProposeKey !== key) {
        const a = PROFILES.controller.barter(ctx);
        if (a) { ctx.mem.lastProposeKey = key; return a; }
      }
      return act("rollDice");
    },
    barter(ctx) {
      const { room, me } = ctx;
      if (room.pendingTrades.filter((t) => t.fromId === me.id).length >= 5) return null;
      const focus = PROFILES.controller.focus(ctx);
      const mineCtrl = ctx.controlled();
      const fodder = ctx.myTickers().filter((t) => !focus.includes(t) && !mineCtrl.includes(t));
      for (const F of focus) {
        const need = 51 - ctx.held(F);
        if (need <= 0) continue;
        const holders = ctx.owners(F).sort((a, b) => b.holdings[F] - a.holdings[F]);
        for (const R of holders) {
          for (const N of fodder) {
            // Бот движка соглашается, если получает ≥ 90% стоимости отдаваемого — даём 100%.
            const maxGive = Math.min(25, ctx.held(N));
            let wantPct = Math.min(25, need, R.holdings[F], Math.floor((ctx.price(N) * maxGive) / ctx.price(F)));
            if (wantPct < 1) continue;
            const givePct = Math.min(maxGive, Math.max(1, Math.ceil((ctx.price(F) * wantPct) / ctx.price(N))));
            const a = ctx.fresh(act("proposeTrade", R.id, N, givePct, 0, F, wantPct));
            if (a) return a;
          }
        }
      }
      return null;
    },
    // Максимум без штрафа за завышение (порог FORCED_PRICE_EXCESSIVE_MULT × справедливая).
    forcedPrice(ctx, info) {
      const fair = ctx.fairForcedPrice(info.ticker);
      return Math.max(1, Math.floor(fair * ctx.excessiveMult() * 0.98));
    },
    insider(ctx, card) {
      if (!card) return "keep";
      if (card.type === "global") return card.percent < 0 ? "moveToBack" : "keep";
      if (card.type === "sector") {
        const exposure = ctx.myTickers().filter((t) => ctx.sector(t) === card.sector).length;
        return card.percent < 0 && exposure > 0 ? "moveToBack" : "keep";
      }
      if (card.type === "special") return card.key === "tax" ? "moveToBack" : "keep";
      return "keep";
    },
  },

  realestate: {
    desc: "Приоритет — недвижимость: покупает и улучшает города, продавая ради этого акции; акции берёт, только если остаётся запас на ближайший город.",
    realEstate(ctx, roll) {
      const { room, me, E } = ctx;
      const id = roll.realEstateId;
      const re = room.realEstate[id];
      if (!re.ownerId) {
        const cost = ctx.reCost(id);
        if (me.cash >= cost) return act("buyRealEstateFromRoll");
        return ctx.fresh(ctx.sellToRaise(cost - me.cash + 1)) || act("skipRoll");
      }
      if (re.ownerId === me.id && (re.level || 0) < E.MAX_RE_LEVEL) {
        const cost = E.realEstateUpgradeCost(room, id);
        if (me.cash >= cost) return act("upgradeRealEstateFromRoll");
        return ctx.fresh(ctx.sellToRaise(cost - me.cash + 1)) || act("skipRoll");
      }
      return act("skipRoll");
    },
    stock(ctx, roll) {
      const { room } = ctx;
      // Резерв — цена самого дешёвого свободного города (или 20% старта, если всё раскуплено).
      const freeCities = ctx.E.CITIES.filter((ct) => !room.realEstate[ct.id].ownerId).map((ct) => ctx.reCost(ct.id));
      const reserve = freeCities.length ? Math.min(...freeCities) : 0.2 * ctx.startCash;
      const pct = Math.min(10, ctx.affordablePct(roll.ticker, ctx.me.cash - reserve));
      return pct >= 1 ? buy(pct) : refuse();
    },
  },

  leverage: {
    desc: "Берёт кредит на максимум лимита и покупает как greedy; гасит, когда наличных хватает с запасом, и берёт снова.",
    reserve: (ctx) => (ctx.me.loan ? ctx.me.loan.principal * 0.3 : 0),
    preRoll(ctx) {
      if (!ctx.me.loan) {
        const lim = ctx.E.loanTerms(ctx.room, ctx.me).limit;
        if (lim >= 0.05 * ctx.startCash) {
          const a = ctx.fresh(act("takeLoan", lim));
          if (a) return a;
        }
      }
      return null; // дальше — как движок (его меры и бросок)
    },
    stock(ctx, roll) {
      const pct = ctx.affordablePct(roll.ticker, ctx.me.cash - PROFILES.leverage.reserve(ctx));
      return pct >= 1 ? buy(pct) : refuse();
    },
    realEstate(ctx, roll) {
      const re = ctx.room.realEstate[roll.realEstateId];
      const reserve = PROFILES.leverage.reserve(ctx);
      if (!re.ownerId) return ctx.me.cash - ctx.reCost(roll.realEstateId) >= reserve ? act("buyRealEstateFromRoll") : act("skipRoll");
      if ((re.level || 0) < ctx.E.MAX_RE_LEVEL && ctx.me.cash - ctx.E.realEstateUpgradeCost(ctx.room, roll.realEstateId) >= reserve) return act("upgradeRealEstateFromRoll");
      return act("skipRoll");
    },
    postRoll(ctx) {
      const loan = ctx.me.loan;
      if (loan && ctx.me.cash >= loan.principal + 0.3 * ctx.startCash) return ctx.fresh(act("repayLoan", Math.ceil(loan.principal)));
      return null;
    },
  },

  // Испытание мер: обычный бот движка (покупки как у него), который пользуется
  // мерами, когда они окупаются: PR своих компаний, негатив по компании, где у
  // соперников больше всего денег, инсайд при большом портфеле.
  meddler: {
    pure: false,
    desc: "Бот движка + меры по расчёту: PR своих (если прирост пакета окупает цену), негатив по чужой компании, инсайд при большом портфеле.",
    preRoll(ctx) {
      const { room, me } = ctx;
      const ev = room.eventCount;
      const reserve = 0.15 * ctx.startCash;
      const mine = ctx.controlled();
      if (room.frozen || !mine.length) return null;
      for (const t of mine) {
        if (room.companies[t].lastPrEvent === ev) continue;
        const gain = (ctx.held(t) / 100) * 0.1 * ctx.vol(t) * ctx.price(t);
        const cost = ctx.cost.pr(t);
        if (gain >= 1.1 * cost && me.cash - cost >= reserve) { const a = ctx.fresh(act("ctrlPrCampaign", t)); if (a) return a; }
      }
      if (ctx.mem.lastNegEvent !== ev) {
        const best = ctx.live().map((c) => c.ticker)
          .filter((t) => !mine.includes(t) && ctx.held(t) < 10 && ev - room.companies[t].lastNegInfoEvent >= 2 && !ctx.atFloor(t))
          .map((t) => ({ t, dmg: (ctx.othersPct(t) / 100) * ctx.price(t) * 0.15 * ctx.vol(t) }))
          .sort((a, b) => b.dmg - a.dmg || (a.t < b.t ? -1 : 1))[0];
        const cost = best ? ctx.cost.negativeInfo(best.t) : 0;
        if (best && best.dmg >= 0.6 * cost && me.cash - cost >= reserve) { const a = ctx.fresh(act("ctrlNegativeInfo", best.t)); if (a) { ctx.mem.lastNegEvent = ev; return a; } }
      }
      const peek = ctx.cost.insiderPeek();
      if (room.insiderUsedEvent[me.id] !== ev && !room.pendingInsider && ctx.stockValue() >= 15 * peek && me.cash - peek >= reserve) {
        const a = ctx.fresh(act("ctrlInsiderPeek"));
        if (a) return a;
      }
      return null;
    },
  },

  // Испытание «покупка вне броска» (engine DIRECT_BUY): бот движка, который
  // каждый ход добирает до 5% компании, где у него больше всего (к контролю),
  // а без своих — самой дешёвой со свободными акциями; резерв $15 000.
  direct: {
    pure: false,
    desc: "Бот движка + покупка вне броска каждый ход: до 5% своей главной компании (иначе самой дешёвой), резерв $15 000.",
    preRoll(ctx) {
      if (typeof ctx.E.buyDirect !== "function") return null;
      const cands = ctx.live().map((c) => c.ticker).filter((t) => ctx.free(t) >= 1 && ctx.othersPct(t) < 50);
      if (!cands.length) return null;
      cands.sort((a, b) => ctx.held(b) - ctx.held(a) || ctx.price(a) - ctx.price(b) || (a < b ? -1 : 1));
      const t = cands[0];
      const pct = Math.min(5, ctx.free(t));
      const cost = ctx.price(t) * (pct / 100) * 1.25 * (1 + ctx.feePct());
      if (ctx.me.cash - cost < 15000) return null;
      return ctx.fresh(act("buyDirect", t, pct));
    },
  },

  dodger: {
    desc: "Проверка лазейки: при свободных акциях всегда покупает ровно 1% (вместо платы за отказ), недвижимость — как движок.",
    stock(ctx, roll) {
      const t = roll.ticker;
      return ctx.free(t) >= 1 && ctx.me.cash >= ctx.buyCost(t, 1) ? buy(1) : refuse();
    },
  },

  // Хаос-обезьяна: случайные (в том числе бессмысленные) действия из всего набора
  // движка — для поиска зависаний, падений и нарушений инвариантов, а не для баланса.
  chaos: {
    desc: "Случайные действия из всего набора (меры, сделки, кредиты, продажи) — фаззинг движка на зависания и ошибки.",
    measure(ctx) {
      const { room, me, E } = ctx;
      const r = ctx.rng;
      const others = ctx.others();
      const live = ctx.live().map((c) => c.ticker);
      const mine = ctx.myTickers();
      const options = [
        () => others.length && act("ctrlEspionage", ctx.pick(others).id),
        () => others.length && act("ctrlDiscredit", ctx.pick(others).id),
        () => act("ctrlNegativeInfo", ctx.pick(live)),
        () => mine.length && act("ctrlPrCampaign", ctx.pick(mine)),
        () => mine.length && act("ctrlSqueezeOut", ctx.pick(mine)),
        () => act("ctrlShort", ctx.pick(live)),
        () => act("ctrlInsiderPeek"),
        () => act("ctrlPublicIPO", ctx.pick(live)),
        () => mine.length >= 2 && act("ctrlMergeCompanies", mine[0], mine.slice(1, 3)),
        () => act("personalPr"),
        () => act("ctrlInvestigate"),
        () => act("takeLoan", Math.round(E.loanTerms(room, me).limit * r())),
        () => me.loan && act("repayLoan", Math.round(me.loan.principal * r())),
        () => mine.length && act("sellBank", ctx.pick(mine), 1 + Math.floor(r() * 25)),
        () => {
          if (!others.length || !mine.length) return null;
          const t = ctx.pick(mine);
          const want = r() < 0.5 ? ctx.pick(live.filter((x) => x !== t)) : null;
          return act("proposeTrade", ctx.pick(others).id, t, 1 + Math.floor(r() * Math.min(25, ctx.held(t))),
            Math.round(r() * ctx.price(t) * 0.3), want, want ? 1 + Math.floor(r() * 10) : 0);
        },
      ];
      return ctx.fresh(ctx.pick(options)() || null);
    },
    preRoll(ctx) { return (ctx.rng() < 0.5 && PROFILES.chaos.measure(ctx)) || act("rollDice"); },
    stock(ctx, roll) { return ctx.rng() < 0.5 ? buy(1 + Math.floor(ctx.rng() * 25)) : refuse(); },
    realEstate(ctx) { return ctx.pick([act("buyRealEstateFromRoll"), act("upgradeRealEstateFromRoll"), act("skipRoll")]); },
    postRoll(ctx) { return (ctx.rng() < 0.35 && PROFILES.chaos.measure(ctx)) || act("endTurn"); },
    forcedPrice(ctx, info) { return Math.max(1, Math.round(ctx.fairForcedPrice(info.ticker) * (0.2 + ctx.rng() * 6))); },
    respondTrade(ctx) { return ctx.rng() < 0.5; },
    insider(ctx) { return ctx.rng() < 0.5 ? "moveToBack" : "keep"; },
  },
};

module.exports = { PROFILES };
