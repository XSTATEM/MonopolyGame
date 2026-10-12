// Тип сборки и id рекламы/магазинов из переменных окружения — общая проверка
// для enable-native.mjs, copy-web.mjs и patch-android.mjs (docs/MONETIZATION-SPEC.md, §10.1).
// Значения попадают в <script>, XML манифеста и gradle, поэтому принимаются
// только строки строго известного вида; всё прочее — ошибка сборки.
//
// Без переменных получается {store:"direct"} без плагинов — сборка как раньше.

export const RE = {
  store: /^(direct|rustore|googleplay)$/,
  yandexRewarded: /^(demo-rewarded-yandex|R-M-\d+-\d+)$/,
  admobAppId: /^ca-app-pub-\d{16}~\d{10}$/,
  admobRewarded: /^ca-app-pub-\d{16}\/\d{10}$/,
  rustoreAppId: /^\d{1,20}$/,
  rustoreScheme: /^[a-z][a-z0-9+.-]{2,40}$/,
};

// Имена npm-пакетов плагинов (они же — записи plugins в .native-build.json).
export const PLUGINS = {
  yandex: "tm-yandex-rewarded",
  rustore: "tm-rustore-pay",
  googleBilling: "@capgo/native-purchases",
  admob: "@capacitor-community/admob",
};

function val(env, name) { return String(env[name] || "").trim(); }

// Имя переменной и пример верного значения — для текстов ошибок.
const VARS = {
  yandexRewarded: ["TM_YANDEX_REWARDED_ID", "R-M-123456-1 или demo-rewarded-yandex"],
  admobAppId: ["TM_ADMOB_APP_ID", "ca-app-pub-1234567890123456~1234567890"],
  admobRewarded: ["TM_ADMOB_REWARDED_ID", "ca-app-pub-1234567890123456/1234567890"],
  rustoreAppId: ["TM_RUSTORE_CONSOLE_APP_ID", "2063512345 (только цифры)"],
  rustoreScheme: ["TM_RUSTORE_PAY_SCHEME", "trademonopoly.rustore (строчные латинские буквы, цифры, «.», «-», «+»)"],
};

// → { store, yandexRewarded, admobAppId, admobRewarded, rustoreAppId, rustoreScheme, errors[], warnings[] }
// Пустая строка — «не задано». Значения, не подходящие к типу сборки, сначала
// обнуляются с предупреждением (Яндекс и AdMob никогда не попадают в одну
// сборку), и только оставшиеся проверяются на формат: опечатка в переменной
// другой сборки (скажем, AdMob при обычной direct) не должна ломать сборку,
// которой эта переменная не нужна, — в том числе сборку по умолчанию из push.
export function readFlavor(env = process.env) {
  const errors = [], warnings = [];
  const store = val(env, "TM_STORE") || "direct";
  if (!RE.store.test(store)) errors.push(`TM_STORE должен быть direct, rustore или googleplay (сейчас «${store.slice(0, 40)}»).`);
  const f = {
    store,
    yandexRewarded: val(env, "TM_YANDEX_REWARDED_ID"),
    admobAppId: val(env, "TM_ADMOB_APP_ID"),
    admobRewarded: val(env, "TM_ADMOB_REWARDED_ID"),
    rustoreAppId: val(env, "TM_RUSTORE_CONSOLE_APP_ID"),
    rustoreScheme: val(env, "TM_RUSTORE_PAY_SCHEME"),
    errors, warnings,
  };
  const bad = (key) => !!f[key] && !RE[key].test(f[key]);
  // Переменная не нужна этой сборке: обнуляем; кривое значение — только предупреждение.
  // why = null — пропускаем молча (переменные RuStore заданы для всех сборок сразу).
  const skip = (keys, why) => {
    const set = keys.filter((k) => f[k]);
    if (!set.length) return;
    if (why) warnings.push(`${set.map((k) => VARS[k][0]).join(", ")} пропущен${set.length > 1 ? "ы" : ""}: ${why}.`);
    for (const k of set) {
      if (bad(k)) warnings.push(`${VARS[k][0]} задан с ошибкой (нужен вид ${VARS[k][1]}), но в сборке ${store} не используется — исправьте его до сборки, где он нужен.`);
      f[k] = "";
    }
  };
  if (store === "googleplay") skip(["yandexRewarded"], "в сборке для Google Play реклама — только AdMob");
  else skip(["admobAppId", "admobRewarded"], "AdMob ставится только в сборку googleplay");
  if (store !== "rustore") skip(["rustoreAppId", "rustoreScheme"], null);

  for (const key of Object.keys(VARS)) {
    if (bad(key)) errors.push(`${VARS[key][0]}: неверный формат, нужен вид ${VARS[key][1]}.`);
  }
  if (store === "googleplay" && Boolean(f.admobAppId) !== Boolean(f.admobRewarded)) {
    errors.push("Для рекламы AdMob нужны оба значения: TM_ADMOB_APP_ID и TM_ADMOB_REWARDED_ID.");
  }
  if (store === "rustore") {
    if (!f.rustoreAppId) errors.push("Для сборки rustore нужна переменная TM_RUSTORE_CONSOLE_APP_ID (id приложения в RuStore Консоли).");
    if (!f.rustoreScheme) errors.push("Для сборки rustore нужна переменная TM_RUSTORE_PAY_SCHEME (схема возврата из банковских приложений).");
  }
  return f;
}

// Сверка с .native-build.json (что поставил enable-native.mjs): веб-слой
// (window.TM_BUILD из copy-web.mjs) и нативные плагины должны быть от одной
// сборки. Иначе, например, APK с плагином RuStore получил бы TMNative.store =
// "direct" и предлагал ЮKassa вместо оплаты RuStore. nb — разобранный файл или
// null, если его нет. → { errors[], warnings[] }
export function checkNativeBuild(f, nb) {
  const errors = [], warnings = [];
  const fix = "удалите mobile/.native-build.json или запустите scripts/enable-native.mjs заново с теми же переменными";
  if (!nb) {
    if (f.store !== "direct" || f.yandexRewarded) warnings.push(`.native-build.json нет — плагины покупок и рекламы для сборки ${f.store} не установлены (сначала node scripts/enable-native.mjs).`);
    return { errors, warnings };
  }
  if (String(nb.store) !== f.store) {
    errors.push(`.native-build.json — от сборки «${String(nb.store).slice(0, 20)}», а TM_STORE сейчас «${f.store}»: ${fix}.`);
    return { errors, warnings };
  }
  const plugins = Array.isArray(nb.plugins) ? nb.plugins : [];
  if (plugins.includes(PLUGINS.yandex) !== Boolean(f.yandexRewarded && f.store !== "googleplay")) {
    warnings.push(`Видео Яндекса: плагин в .native-build.json и TM_YANDEX_REWARDED_ID не совпадают — видео в этой сборке не будет (${fix}).`);
  }
  if (plugins.includes(PLUGINS.admob) !== Boolean(f.store === "googleplay" && f.admobAppId && f.admobRewarded)) {
    warnings.push(`AdMob: плагин в .native-build.json и TM_ADMOB_* не совпадают — видео в этой сборке не будет (${fix}).`);
  }
  return { errors, warnings };
}

// Плагины, которые нужны этой сборке (имена npm-пакетов).
export function pluginsFor(f) {
  const list = [];
  if (f.store === "rustore") list.push(PLUGINS.rustore);
  if (f.store === "googleplay") list.push(PLUGINS.googleBilling);
  if (f.store !== "googleplay" && f.yandexRewarded) list.push(PLUGINS.yandex);
  if (f.store === "googleplay" && f.admobAppId && f.admobRewarded) list.push(PLUGINS.admob);
  return list;
}

// Объект window.TM_BUILD для веб-клиента (native.js) или null, если в сборке
// нечего включать — тогда тег <script> не вставляется вовсе.
export function webBuildInfo(f) {
  const yandexRewarded = f.store !== "googleplay" ? f.yandexRewarded : "";
  const admobRewarded = f.store === "googleplay" && f.admobAppId ? f.admobRewarded : "";
  if (f.store === "direct" && !yandexRewarded && !admobRewarded) return null;
  return { store: f.store, yandexRewarded, admobRewarded };
}
