#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFxAgent,
  createFxTerminal,
  fxSdkApiVersion,
  libfxApiVersion,
} from "../node.js";
import * as browser from "../browser.js";

assert.equal(libfxApiVersion, 2);
assert.equal(fxSdkApiVersion, 1);
assert.equal(browser.libfxApiVersion, 2);
assert.equal(typeof browser.createFxAgent, "function");
assert.equal(typeof browser.createFxTerminal, "function");

const dir = await mkdtemp(resolve(tmpdir(), "libfx-loader-"));
const nativePath = resolve(dir, "native.mjs");
await writeFile(nativePath, `
  export async function createFxAgent(options) { return { backend: "native-agent", options }; }
  export async function createFxTerminal(options) { return { backend: "native-terminal", options }; }
`);
const nativeUrl = pathToFileURL(nativePath);

for (const gatewayChatUrl of [
  "http://attacker.example/chat",
  "https://[redacted]@example.com/chat",
  "file:///tmp/socket",
]) {
  await assert.rejects(
    createFxAgent({ nativeAddon: nativeUrl, env: { FX_API_CHAT_URL: gatewayChatUrl } }),
    TypeError,
  );
}

const directAgent = await createFxAgent({
  nativeAddon: nativeUrl,
  env: {
    OPENAI_BASE_URL: "https://models.example/v1",
    OPENAI_API_KEY: "direct-test-key",
  },
});
assert.equal(directAgent.backend, "native-agent");
assert.equal(directAgent.options.env.OPENAI_BASE_URL, "https://models.example/v1");

const agent = await createFxAgent({ nativeAddon: nativeUrl, marker: 1 });
assert.equal(agent.backend, "native-agent");
assert.equal(agent.options.marker, 1);
assert.equal("nativeAddon" in agent.options, false);
assert.equal("backend" in agent.options, false);

const terminal = await createFxTerminal({ nativeAddon: nativeUrl, marker: 2 });
assert.equal(terminal.backend, "native-terminal");
assert.equal(terminal.options.marker, 2);

await assert.rejects(
  createFxAgent({ nativeAddon: nativeUrl, backend: "wasm" }),
  (error) => error?.code === "LIBFX_JSPI_REQUIRED" &&
    error.message.includes("--experimental-wasm-jspi"),
);

const coreOnlyPath = resolve(dir, "core-only.mjs");
await writeFile(coreOnlyPath, `
  export const libfxApiVersion = 2;
  export async function createFxAgent() { return { backend: "core-only" }; }
`);
await assert.rejects(
  createFxTerminal({ nativeAddon: pathToFileURL(coreOnlyPath), backend: "native" }),
  (error) => error?.code === "LIBFX_NATIVE_UNAVAILABLE" &&
    error.message.includes("createFxTerminal"),
);

const incompatiblePath = resolve(dir, "incompatible.mjs");
await writeFile(incompatiblePath, `
  export const libfxApiVersion = 3;
  export async function createFxAgent() {}
`);
await assert.rejects(
  createFxAgent({ nativeAddon: pathToFileURL(incompatiblePath), backend: "native" }),
  (error) => error?.code === "LIBFX_NATIVE_UNAVAILABLE" &&
    error.message.includes("incompatible"),
);

for (const [name, source] of [
  ["missing-version", `
    export function createCore() { throw new Error("missing-version createCore invoked"); }
  `],
  ["unequal-version", `
    export const libfxApiVersion = 3;
    export function createCore() { throw new Error("unequal-version createCore invoked"); }
  `],
]) {
  const modulePath = resolve(dir, `${name}.mjs`);
  await writeFile(modulePath, source);
  await assert.rejects(
    createFxAgent({ nativeAddon: pathToFileURL(modulePath), backend: "native" }),
    (error) => error?.code === "LIBFX_NATIVE_UNAVAILABLE" &&
      error.message.includes("incompatible") &&
      !String(error.cause).includes("createCore invoked"),
    `${name} low-level addon must fail before createCore invocation`,
  );
}

const matchingVersionPath = resolve(dir, "matching-version.mjs");
await writeFile(matchingVersionPath, `
  export const libfxApiVersion = 2;
  export function createCore() {
    const error = new Error("matching-version createCore invoked");
    error.code = "MATCHING_VERSION_INVOKED";
    throw error;
  }
`);
await assert.rejects(
  createFxAgent({ nativeAddon: pathToFileURL(matchingVersionPath), backend: "native" }),
  (error) => error?.code === "MATCHING_VERSION_INVOKED",
  "matching v2 low-level addon must reach createCore",
);

console.log("libfx loader passed: browser exports, native preference, fallback diagnostics, and strict low-level API validation");
