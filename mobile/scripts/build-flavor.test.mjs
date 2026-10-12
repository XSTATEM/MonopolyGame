// Проверка правил сборки (build-flavor.mjs) без Android SDK и без установки
// плагинов: node scripts/build-flavor.test.mjs (или npm test в папке mobile).
// Запускается и в CI перед сборкой — ошибка здесь останавливает её сразу.
//
// Главное: опечатка в переменной, которая этой сборке не нужна (например, id AdMob
// при обычной сборке direct из push), не должна ломать сборку — только предупреждение.
import { readFlavor, pluginsFor, webBuildInfo, checkNativeBuild, PLUGINS } from "./build-flavor.mjs";

let failures = 0;
function check(cond, msg, extra) {
  console.log((cond ? "PASS " : "FAIL ") + msg + (cond || extra === undefined ? "" : "  -> " + JSON.stringify(extra)));
  if (!cond) failures++;
}

const ADMOB_APP = "ca-app-pub-3940256099942544~3347511713";
const ADMOB_UNIT = "ca-app-pub-3940256099942544/5224354917";

// 1) Без переменных — direct без плагинов и без TM_BUILD, как раньше.
let f = readFlavor({});
check(f.store === "direct" && !f.errors.length && !f.warnings.length && pluginsFor(f).length === 0 && webBuildInfo(f) === null, "без переменных: direct, без плагинов и TM_BUILD", f);

// 2) direct + кривой id AdMob — не ошибка, а предупреждение; AdMob обнулён.
f = readFlavor({ TM_STORE: "direct", TM_ADMOB_APP_ID: "ca-app-pub-123", TM_ADMOB_REWARDED_ID: "nope" });
check(!f.errors.length && f.admobAppId === "" && f.admobRewarded === "", "direct + кривой AdMob: сборка не падает", f.errors);
check(f.warnings.some((w) => /TM_ADMOB_APP_ID задан с ошибкой/.test(w)) && f.warnings.some((w) => /пропущены: AdMob/.test(w)), "direct + кривой AdMob: предупреждения понятны", f.warnings);
check(webBuildInfo(f) === null && pluginsFor(f).length === 0, "direct + кривой AdMob: в сборке ничего лишнего");

// 3) direct + кривые id RuStore — молча пропущены, только предупреждение о формате.
f = readFlavor({ TM_RUSTORE_CONSOLE_APP_ID: "abc", TM_RUSTORE_PAY_SCHEME: "Bad Scheme" });
check(!f.errors.length && f.rustoreAppId === "" && f.warnings.length === 2, "direct + кривые id RuStore: без ошибки", f);

// 4) googleplay + кривой id Яндекса — пропущен с предупреждением.
f = readFlavor({ TM_STORE: "googleplay", TM_YANDEX_REWARDED_ID: "R-M-bad" });
check(!f.errors.length && f.yandexRewarded === "" && JSON.stringify(pluginsFor(f)) === JSON.stringify([PLUGINS.googleBilling]), "googleplay + кривой Яндекс: без ошибки, только Google Billing", f);

// 5) Нужные этой сборке значения по-прежнему проверяются строго.
f = readFlavor({ TM_STORE: "googleplay", TM_ADMOB_APP_ID: "ca-app-pub-123", TM_ADMOB_REWARDED_ID: ADMOB_UNIT });
check(f.errors.some((e) => /TM_ADMOB_APP_ID: неверный формат/.test(e)), "googleplay + кривой AdMob: ошибка", f.errors);
f = readFlavor({ TM_STORE: "googleplay", TM_ADMOB_APP_ID: ADMOB_APP });
check(f.errors.some((e) => /нужны оба значения/.test(e)), "googleplay + только один id AdMob: ошибка", f.errors);
f = readFlavor({ TM_YANDEX_REWARDED_ID: "R-M-12" });
check(f.errors.some((e) => /TM_YANDEX_REWARDED_ID: неверный формат/.test(e)), "direct + кривой Яндекс: ошибка (он нужен этой сборке)", f.errors);
f = readFlavor({ TM_STORE: "rustore" });
check(f.errors.length === 2, "rustore без id и схемы: две ошибки", f.errors);
f = readFlavor({ TM_STORE: "web" });
check(f.errors.some((e) => /TM_STORE/.test(e)), "неизвестный TM_STORE: ошибка", f.errors);

// 6) Тестовые id Google проходят проверку формата (первые сборки googleplay — с ними).
f = readFlavor({ TM_STORE: "googleplay", TM_ADMOB_APP_ID: ADMOB_APP, TM_ADMOB_REWARDED_ID: ADMOB_UNIT });
check(!f.errors.length && pluginsFor(f).includes(PLUGINS.admob) && webBuildInfo(f).admobRewarded === ADMOB_UNIT, "тестовые id AdMob от Google принимаются");

// 7) .native-build.json и переменные этой сборки должны совпадать.
const rs = readFlavor({ TM_STORE: "rustore", TM_RUSTORE_CONSOLE_APP_ID: "2063512345", TM_RUSTORE_PAY_SCHEME: "trademonopoly.rustore" });
check(!checkNativeBuild(rs, { store: "rustore", plugins: [PLUGINS.rustore] }).errors.length, "rustore + .native-build.json rustore: совпадают");
check(checkNativeBuild(readFlavor({}), { store: "rustore", plugins: [PLUGINS.rustore] }).errors.length === 1, "direct, а .native-build.json от rustore: ошибка");
check(checkNativeBuild(readFlavor({}), null).warnings.length === 0, "direct без .native-build.json: тихо");
check(checkNativeBuild(rs, null).warnings.length === 1, "rustore без .native-build.json: предупреждение");
const dy = readFlavor({ TM_YANDEX_REWARDED_ID: "demo-rewarded-yandex" });
check(!checkNativeBuild(dy, { store: "direct", plugins: [PLUGINS.yandex] }).warnings.length, "direct + Яндекс: совпадают");
check(checkNativeBuild(readFlavor({}), { store: "direct", plugins: [PLUGINS.yandex] }).warnings.length === 1, "плагин Яндекса есть, переменной нет: предупреждение");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
