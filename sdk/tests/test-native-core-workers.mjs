#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addonPath = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/liby2.node"));

function runWorker(index) {
  return new Promise((resolveWorker, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const addon = require(workerData.addonPath);
      const core = addon.createCore({
        apiKey: "worker-test-key",
        home: process.cwd(),
        workspaceRoot: process.cwd(),
      });
      addon.writeCore(core, Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: workerData.index + 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }) + "\\n"));
      const deadline = Date.now() + 5000;
      let output = "";
      while (Date.now() < deadline && !output.includes('"result"')) {
        output += addon.drainCore(core).toString("utf8");
      }
      addon.closeCore(core);
      addon.destroyCore(core);
      parentPort.postMessage(output);
    `, { eval: true, workerData: { addonPath, index } });
    worker.once("message", (output) => resolveWorker(output));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

const outputs = await Promise.all(Array.from({ length: 4 }, (_, index) => runWorker(index)));
for (const output of outputs) assert.match(output, /"result"/);

const addon = require(addonPath);
const localCores = Array.from({ length: 3 }, () => addon.createCore({
  apiKey: "same-env-test-key",
  home: process.cwd(),
  workspaceRoot: process.cwd(),
}));
for (const core of localCores) addon.closeCore(core);
for (const core of localCores) addon.destroyCore(core);

let finalized = false;
const registry = new FinalizationRegistry(() => { finalized = true; });
{
  let abandoned = addon.createCore({ apiKey: "gc-test-key", home: process.cwd(), workspaceRoot: process.cwd() });
  registry.register(abandoned, "abandoned");
  abandoned = null;
}
if (typeof global.gc === "function") {
  const deadline = Date.now() + 5000;
  while (!finalized && Date.now() < deadline) {
    global.gc();
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.equal(finalized, true, "abandoned external handle was not finalized");
}

console.log("native core workers passed: worker isolation, same-environment concurrency, and GC cleanup");
