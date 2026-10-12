// ---------------------------------------------------------------------
// Смоук-тест настоящего сервера: поднимает ../server.js на свободном порту
// с временной папкой данных (os.tmpdir) и проверяет HTTP и WebSocket:
// healthz, куки (Secure за прокси), регистрацию/вход/несколько устройств/
// выход, вход в комнату + старт + бросок, сохранение партий на диск и
// восстановление после перезапуска, лимиты входа и потока сообщений,
// тикеры-ключи прототипа, аватары, код комнаты, слишком большой кадр.
//
// Запуск: node test/smoke.js  (из папки server) или npm test.
// Периодическое сохранение комнат идёт раз в 30 с (server.js), поэтому
// полный прогон ждёт ~32 с. SMOKE_FAST=1 (npm run test:fast) это ожидание
// пропускает: на Linux/macOS перезапуск проверяется мягкой остановкой
// (SIGTERM — сохранение при остановке), на Windows сигналов нет, и часть
// с перезапуском пропускается целиком.
// Прочие переменные: SMOKE_PORT — фиксированный порт вместо свободного,
// SMOKE_VERBOSE=1 — печатать вывод сервера сразу, а не только при сбое.
// ---------------------------------------------------------------------
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const SERVER = path.join(__dirname, "..", "server.js");
const FAST = process.env.SMOKE_FAST === "1";
const VERBOSE = process.env.SMOKE_VERBOSE === "1";
const GRACEFUL = process.platform !== "win32"; // child.kill("SIGTERM") на Windows — жёсткое завершение
const PERSIST_WAIT_MS = 32000; // интервал сохранения в server.js — 30 с, плюс запас
const TIMEOUT_MS = (FAST ? 60 : 120) * 1000;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "birzha-smoke-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = "";
let PORT = 0;
let failures = 0;
let srv = null;
const sockets = [];
const srvLog = [];

function check(cond, msg) { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures++; }
function skip(msg) { console.log("SKIP " + msg); }

function freePort() {
  if (process.env.SMOKE_PORT) return Promise.resolve(Number(process.env.SMOKE_PORT));
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function startServer() {
  const p = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: DATA, TRUST_PROXY: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sink = (tag) => (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line) continue;
      srvLog.push(tag + line);
      if (VERBOSE) console.log(tag + line);
    }
  };
  p.stdout.on("data", sink("[srv] "));
  p.stderr.on("data", sink("[srv-err] "));
  p.exited = new Promise((r) => p.on("exit", r));
  return p;
}
async function stopServer(signal) {
  if (!srv || srv.exitCode !== null || srv.signalCode !== null) return;
  srv.kill(signal);
  await Promise.race([srv.exited, sleep(5000)]);
}
async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) return r.json(); } catch (e) {}
    await sleep(100);
  }
  throw new Error("сервер не отвечает на /healthz");
}
async function post(p, body, headers) {
  const r = await fetch(BASE + p, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers || {}), body: JSON.stringify(body) });
  return { status: r.status, cookie: r.headers.get("set-cookie"), body: await r.json() };
}
function wsClient(headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, headers ? { headers } : undefined);
  sockets.push(ws);
  ws.msgs = [];
  ws.on("message", (d) => { try { ws.msgs.push(JSON.parse(d)); } catch (e) {} });
  return new Promise((res, rej) => { ws.on("open", () => res(ws)); ws.on("error", rej); });
}
async function waitMsg(ws, pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = ws.msgs.find(pred);
    if (m) { ws.msgs.splice(ws.msgs.indexOf(m), 1); return m; }
    await sleep(20);
  }
  return null;
}
const lastState = (ws) => [...ws.msgs].reverse().find((m) => m.type === "state");

async function cleanup() {
  for (const ws of sockets) { try { ws.terminate(); } catch (e) {} }
  await stopServer();
  // Windows может ещё держать файлы только что завершённого процесса.
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.log("не удалось удалить " + DATA + ": " + e.message); }
}
// Страховка: дочерний сервер не переживает тест, даже если тот упал или завис.
process.on("exit", () => { if (srv && srv.exitCode === null && srv.signalCode === null) { try { srv.kill(); } catch (e) {} } });

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`порт ${PORT}, данные ${DATA}${FAST ? ", быстрый режим (SMOKE_FAST=1)" : ""}`);
  srv = startServer();
  const h = await waitHealthy();
  check(h.ok === true && h.rooms === 0, "healthz ok " + JSON.stringify(h));

  // --- аккаунты и куки ----------------------------------------------------
  const r1 = await post("/api/register", { username: "alice", password: "pass1234" });
  check(r1.status === 200 && r1.body.sessionToken, "register alice");
  check(r1.cookie && !/Secure/.test(r1.cookie), "cookie without Secure over http: " + r1.cookie);
  const r2 = await post("/api/register", { username: "bob", password: "pass1234" }, { "X-Forwarded-Proto": "https" });
  check(r2.cookie && /Secure/.test(r2.cookie), "cookie Secure when X-Forwarded-Proto=https");

  // --- комната: вход, старт, бросок -----------------------------------------
  const a = await wsClient(), b = await wsClient();
  a.send(JSON.stringify({ type: "join", room: "test", sessionToken: r1.body.sessionToken }));
  check(!!(await waitMsg(a, (m) => m.type === "joined")), "alice joined");
  b.send(JSON.stringify({ type: "join", room: "test", sessionToken: r2.body.sessionToken }));
  check(!!(await waitMsg(b, (m) => m.type === "joined")), "bob joined");
  await sleep(200);
  a.send(JSON.stringify({ type: "startGame" }));
  await sleep(300);
  let st = lastState(a);
  check(st && st.phase === "roll", "game started, phase=" + (st && st.phase));
  if (!st) throw new Error("нет состояния комнаты после старта");
  const mover = st.currentPlayerId === st.you ? a : b;
  mover.send(JSON.stringify({ type: "roll" }));
  await sleep(300);
  st = lastState(a);
  check(st && st.pendingRoll, "roll registered");
  const rollBefore = JSON.stringify(st && st.pendingRoll);
  check(fs.existsSync(path.join(DATA, "users.json")) && !fs.existsSync(path.join(DATA, "users.json.tmp")), "users.json atomic (no leftover tmp)");

  // --- сохранение на диск и перезапуск --------------------------------------
  let player = a; // сокет игрока в комнате для проверок ниже
  let restart = null;
  if (!FAST) {
    console.log(`waiting ${PERSIST_WAIT_MS / 1000}s for periodic persist…`);
    await sleep(PERSIST_WAIT_MS);
    check(fs.existsSync(path.join(DATA, "rooms.json")), "rooms.json persisted periodically");
    restart = "kill"; // жёстко (на Windows иначе нельзя) — периодического сохранения должно хватить
  } else if (GRACEFUL) {
    restart = "SIGTERM";
  } else {
    skip("periodic persist + restore after restart (SMOKE_FAST=1 on Windows: no graceful signal)");
  }
  if (restart) {
    a.terminate(); b.terminate();
    await stopServer(restart === "kill" ? "SIGKILL" : restart);
    if (restart === "SIGTERM") check(fs.existsSync(path.join(DATA, "rooms.json")), "rooms.json saved on SIGTERM");
    await sleep(300);
    srv = startServer();
    const h2 = await waitHealthy();
    check(h2.rooms === 1, "room restored after restart: rooms=" + h2.rooms);
    const list = await (await fetch(BASE + "/api/rooms")).json();
    check(list.length === 1 && list[0].code === "TEST" && list[0].connectedCount === 0 && list[0].phase === "roll", "restored room listed, all offline: " + JSON.stringify(list));
    player = await wsClient();
    player.send(JSON.stringify({ type: "join", room: "TEST", sessionToken: r1.body.sessionToken }));
    check(!!(await waitMsg(player, (m) => m.type === "joined")), "alice rejoined restored room");
    await sleep(200);
    st = lastState(player);
    check(st && st.phase === "roll" && JSON.stringify(st.pendingRoll) === rollBefore, "game state preserved (pendingRoll same)");
  }

  // --- лимит неудачных входов (HTTP) ----------------------------------------
  let last;
  for (let i = 0; i < 21; i++) last = await post("/api/login", { username: "alice", password: "wrong" + i }, { "X-Real-IP": "10.0.0.5" });
  check(last.status === 429, "http login blocked after 20 fails: status=" + last.status);
  const other = await post("/api/login", { username: "alice", password: "pass1234" }, { "X-Real-IP": "10.0.0.6" });
  check(other.status === 200, "other IP still can login");

  // --- тот же лимит для входа по WebSocket (IP из заголовков сокета) --------
  const wsBad = await wsClient({ "X-Real-IP": "10.0.0.5" });
  wsBad.send(JSON.stringify({ type: "join", room: "X", username: "alice", password: "pass1234" }));
  const e = await waitMsg(wsBad, (m) => m.type === "error");
  check(e && /Слишком много/.test(e.message), "ws join blocked for same IP even with right password: " + (e && e.message));

  // --- битые сообщения не роняют сервер, ключи прототипа не доходят до движка
  player.send("null"); player.send("123");
  player.send(JSON.stringify({ type: "sellBank", ticker: "__proto__", pct: 5 }));
  check(!!(await waitMsg(player, (m) => m.type === "error" && /Неизвестная компания/.test(m.message))), "prototype-key ticker rejected before engine");
  player.send(JSON.stringify({ type: "proposeTrade", to: 2, ticker: "AAPL", pct: 5, price: 1, wantTicker: "constructor", wantPct: 5 }));
  check(!!(await waitMsg(player, (m) => m.type === "error" && /Неизвестная компания/.test(m.message))), "prototype-key wantTicker rejected");
  await sleep(200);
  check((await waitHealthy()).ok, "server alive after malformed messages");

  // --- несколько устройств: второй вход не отменяет первый ------------------
  const l1 = await post("/api/login", { username: "bob", password: "pass1234" }, { "X-Real-IP": "10.0.0.7" });
  const s1 = await post("/api/session", { token: r2.body.sessionToken });
  const s2 = await post("/api/session", { token: l1.body.sessionToken });
  check(s1.status === 200 && s2.status === 200, "both sessions valid after second login (multi-device)");
  await post("/api/logout", { username: "bob", token: l1.body.sessionToken });
  const s3 = await post("/api/session", { token: l1.body.sessionToken });
  const s4 = await post("/api/session", { token: r2.body.sessionToken });
  check(s3.status === 400 && s4.status === 200, "logout revokes only that device");

  // --- аватары ---------------------------------------------------------------
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const ph = await post("/api/profile/photo", { username: "alice", token: r1.body.sessionToken, photoDataUrl: tiny }, { "X-Real-IP": "10.0.0.8" });
  check(ph.status === 200, "photo upload ok");
  const av = await fetch(BASE + "/api/avatar/alice");
  check(av.status === 200 && av.headers.get("content-type") === "image/png" && (await av.arrayBuffer()).byteLength > 50, "avatar endpoint serves png");
  const av404 = await fetch(BASE + "/api/avatar/nobody");
  check(av404.status === 404, "avatar 404 for unknown");

  // --- код комнаты и слишком большой кадр ------------------------------------
  const wv = await wsClient();
  wv.send(JSON.stringify({ type: "join", room: "<script>", sessionToken: r1.body.sessionToken }));
  const ve = await waitMsg(wv, (m) => m.type === "error");
  check(ve && /Код комнаты/.test(ve.message), "bad room code rejected");
  wv.on("error", () => {}); // сервер закроет сокет — это ожидаемо
  wv.send("x".repeat(70 * 1024));
  await sleep(300);
  check((await waitHealthy()).ok, "server alive after oversized frame");

  // --- лимит потока сообщений с одного сокета --------------------------------
  const wf = await wsClient();
  for (let i = 0; i < 70; i++) wf.send(JSON.stringify({ type: "reaction", emoji: "👍" }));
  check(!!(await waitMsg(wf, (m) => m.type === "error" && /Слишком много действий/.test(m.message))), "per-socket flood limit");
}

const watchdog = setTimeout(() => {
  console.log(`FAIL смоук-тест не уложился в ${TIMEOUT_MS / 1000} с`);
  failures++;
  finish(2);
}, TIMEOUT_MS);

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  await cleanup();
  if (code || failures) {
    // Вывод сервера помогает понять сбой; при успехе он только шумит.
    if (!VERBOSE && srvLog.length) console.log("\n--- вывод сервера ---\n" + srvLog.slice(-60).join("\n"));
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : code ? "\nABORTED" : "\nALL PASS");
  process.exit(code || (failures ? 1 : 0));
}

main().then(() => finish(0), (e) => { console.log("FAIL " + (e && e.stack || e)); failures++; finish(2); });
