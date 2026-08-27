#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createY2Agent } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addon = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/liby2.node"));
let timeoutId;
const agent = await createY2Agent({
  nativeAddon: addon,
  backend: "native",
  fetch() {
    const error = new Error("host timeout");
    error.name = "AbortError";
    throw error;
  },
  env: {
    OPENAI_BASE_URL: "https://models.example/v1",
    OPENAI_API_KEY: "native-core-fetch-failure-key",
    Y2_MODEL: "native/test-model",
  },
});

let closed = false;
try {
  const session = await agent.createSession();
  const turn = session.prompt("fail host fetch");
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("native host-fetch failure hung")), 5000);
  });
  await assert.rejects(
    Promise.race([turn.result, timeout]),
    (error) => error.message !== "native host-fetch failure hung",
  );
  await session.close();
  assert.equal(await agent.close(), 0);
  closed = true;
  console.log("native host-fetch failure passed: independent AbortError fails without hanging");
} finally {
  clearTimeout(timeoutId);
  if (!closed) agent.abort();
}
