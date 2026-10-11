"use strict";
// Поток-воркер симулятора: один раз исполняет подготовленный главным потоком
// исходник движка (уже с подменами констант) и считает партии пачками по запросу.
const { parentPort, workerData } = require("worker_threads");
const { instantiateEngine } = require("./engine-loader");
const { runGame } = require("./runner");

let env;
try {
  env = instantiateEngine(workerData.prepared);
} catch (e) {
  parentPort.postMessage({ type: "fatal", error: String(e && e.stack || e) });
  parentPort.close();
}
if (env) {
  parentPort.on("message", (msg) => {
    if (msg.type === "run") {
      // runGame сам ловит ошибки движка (запись с endReason "crash"); сюда долетают
      // только ошибки самого симулятора — их отдаём главному потоку целиком.
      try {
        const records = msg.games.map((i) => runGame(env, workerData.cfg, i));
        parentPort.postMessage({ type: "done", records });
      } catch (e) {
        parentPort.postMessage({ type: "fatal", error: String(e && e.stack || e) });
      }
    } else if (msg.type === "exit") {
      parentPort.close();
    }
  });
  parentPort.postMessage({ type: "ready" });
}
