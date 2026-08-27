#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addonPath = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/liby2.node"));
const addon = require(addonPath);
const core = addon.createCore({
  apiKey: "cancel-before-fetch-key",
  model: "native/test-model",
  home: "/tmp",
  workspaceRoot: "/tmp",
  gatewayChatUrl: "http://127.0.0.1:31337/chat",
});

let nextId = 1;
let buffered = "";
async function request(method, params = {}) {
  const id = nextId++;
  addon.writeCore(core, Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    buffered += addon.drainCore(core).toString("utf8");
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === id) return message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
  throw new Error(`timed out waiting for ${method}`);
}

try {
  assert.ok((await request("initialize", { protocolVersion: 1, clientCapabilities: {} })).result);
  const created = await request("session/new");
  const promptId = nextId++;
  addon.writeCore(core, Buffer.from(`${JSON.stringify({
    jsonrpc: "2.0",
    id: promptId,
    method: "session/prompt",
    params: { sessionId: created.result.sessionId, prompt: [{ type: "text", text: "cancel before host fetch" }] },
  })}\n`));
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  addon.writeCore(core, Buffer.from(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: created.result.sessionId },
  })}\n`));
  addon.abortCoreFetch(core);
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(addon.takeCoreFetch(core), null, "cancelled native request remained available to the Node fetch poller");
  console.log("native pre-fetch cancellation passed: no stale request survives abort");
} finally {
  addon.closeCore(core);
  addon.destroyCore(core);
}
