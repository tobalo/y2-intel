#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addonPath = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/liby2.node"));
const addon = require(addonPath);
const core = addon.createCore({ apiKey: "exit-code-test-key", home: "/tmp", workspaceRoot: "/tmp" });

try {
  addon.writeCore(core, Buffer.from("{}\n".repeat(180_000)));
  const deadline = Date.now() + 5000;
  while (!addon.coreExited(core) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.equal(addon.coreExited(core), true, "output backpressure did not stop the native runtime");
  assert.notEqual(addon.coreExitCode(core), 0, "native output failure must not report a graceful exit");
  console.log("native exit code passed: output backpressure reports a nonzero runtime status");
} finally {
  addon.destroyCore(core);
}
