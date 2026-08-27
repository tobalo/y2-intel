#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createY2Agent,
  createY2Terminal,
  y2SdkApiVersion,
  liby2ApiVersion,
} from "../node.js";
import * as browser from "../browser.js";

assert.equal(liby2ApiVersion, 2);
assert.equal(y2SdkApiVersion, 1);
assert.equal(browser.liby2ApiVersion, 2);
assert.equal(typeof browser.createY2Agent, "function");
assert.equal(typeof browser.createY2Terminal, "function");

const dir = await mkdtemp(resolve(tmpdir(), "liby2-loader-"));
const nativePath = resolve(dir, "native.mjs");
await writeFile(nativePath, `
  export async function createY2Agent(options) { return { backend: "native-agent", options }; }
  export async function createY2Terminal(options) { return { backend: "native-terminal", options }; }
`);
const nativeUrl = pathToFileURL(nativePath);

for (const gatewayChatUrl of [
  "http://attacker.example/chat",
  "https://[redacted]@example.com/chat",
  "file:///tmp/socket",
]) {
  await assert.rejects(
    createY2Agent({ nativeAddon: nativeUrl, env: { Y2_API_CHAT_URL: gatewayChatUrl } }),
    TypeError,
  );
}

const directAgent = await createY2Agent({
  nativeAddon: nativeUrl,
  env: {
    OPENAI_BASE_URL: "https://models.example/v1",
    OPENAI_API_KEY: "direct-test-key",
  },
});
assert.equal(directAgent.backend, "native-agent");
assert.equal(directAgent.options.env.OPENAI_BASE_URL, "https://models.example/v1");

const agent = await createY2Agent({ nativeAddon: nativeUrl, marker: 1 });
assert.equal(agent.backend, "native-agent");
assert.equal(agent.options.marker, 1);
assert.equal("nativeAddon" in agent.options, false);
assert.equal("backend" in agent.options, false);

const terminal = await createY2Terminal({ nativeAddon: nativeUrl, marker: 2 });
assert.equal(terminal.backend, "native-terminal");
assert.equal(terminal.options.marker, 2);

await assert.rejects(
  createY2Agent({ nativeAddon: nativeUrl, backend: "wasm" }),
  (error) => error?.code === "LIBY2_JSPI_REQUIRED" &&
    error.message.includes("--experimental-wasm-jspi"),
);

const coreOnlyPath = resolve(dir, "core-only.mjs");
await writeFile(coreOnlyPath, `
  export const liby2ApiVersion = 2;
  export async function createY2Agent() { return { backend: "core-only" }; }
`);
await assert.rejects(
  createY2Terminal({ nativeAddon: pathToFileURL(coreOnlyPath), backend: "native" }),
  (error) => error?.code === "LIBY2_NATIVE_UNAVAILABLE" &&
    error.message.includes("createY2Terminal"),
);

const incompatiblePath = resolve(dir, "incompatible.mjs");
await writeFile(incompatiblePath, `
  export const liby2ApiVersion = 3;
  export async function createY2Agent() {}
`);
await assert.rejects(
  createY2Agent({ nativeAddon: pathToFileURL(incompatiblePath), backend: "native" }),
  (error) => error?.code === "LIBY2_NATIVE_UNAVAILABLE" &&
    error.message.includes("incompatible"),
);

for (const [name, source] of [
  ["missing-version", `
    export function createCore() { throw new Error("missing-version createCore invoked"); }
  `],
  ["unequal-version", `
    export const liby2ApiVersion = 3;
    export function createCore() { throw new Error("unequal-version createCore invoked"); }
  `],
]) {
  const modulePath = resolve(dir, `${name}.mjs`);
  await writeFile(modulePath, source);
  await assert.rejects(
    createY2Agent({ nativeAddon: pathToFileURL(modulePath), backend: "native" }),
    (error) => error?.code === "LIBY2_NATIVE_UNAVAILABLE" &&
      error.message.includes("incompatible") &&
      !String(error.cause).includes("createCore invoked"),
    `${name} low-level addon must fail before createCore invocation`,
  );
}

const matchingVersionPath = resolve(dir, "matching-version.mjs");
await writeFile(matchingVersionPath, `
  export const liby2ApiVersion = 2;
  export function createCore() {
    const error = new Error("matching-version createCore invoked");
    error.code = "MATCHING_VERSION_INVOKED";
    throw error;
  }
`);
await assert.rejects(
  createY2Agent({ nativeAddon: pathToFileURL(matchingVersionPath), backend: "native" }),
  (error) => error?.code === "MATCHING_VERSION_INVOKED",
  "matching v2 low-level addon must reach createCore",
);

console.log("liby2 loader passed: browser exports, native preference, fallback diagnostics, and strict low-level API validation");
