#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFxTerminal, supportsJspi } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const defaultWasm = resolve(scriptDir, "../../zig-out/bin/fx-term.wasm");
const wasmPath = resolve(process.argv[2] || defaultWasm);

if (!supportsJspi()) {
  console.error("Node JSPI is disabled. Run with: node --experimental-wasm-jspi sdk/scripts/test-term.mjs");
  process.exit(2);
}

const output = [];
const streamedDecoder = new TextDecoder();
let streamedText = "";
const liveDraft = "queued draft";
const queuedAnswer = "§";
let draftVisibleAt;
let queuedVisibleAt;
const originalSetTimeout = globalThis.setTimeout;
let observeZeroTimeouts = false;
let zeroTimeoutCount = 0;
globalThis.setTimeout = (callback, delay = 0, ...args) => {
  if (observeZeroTimeouts && Number(delay) === 0) zeroTimeoutCount += 1;
  return originalSetTimeout(callback, delay, ...args);
};
const dataListeners = new Set();
const resizeListeners = new Set();
let drainCalls = 0;
let drainCompleted = false;
const terminal = {
  cols: 80,
  rows: 24,
  write(bytes) {
    const chunk = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
    output.push(chunk);
    streamedText += streamedDecoder.decode(chunk, { stream: true });
    if (draftVisibleAt === undefined && streamedText.includes(liveDraft)) draftVisibleAt = performance.now();
    if (queuedVisibleAt === undefined && streamedText.includes("queued 1")) queuedVisibleAt = performance.now();
    process.stdout.write(chunk);
  },
  async drain() {
    drainCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    drainCompleted = true;
  },
  onData(callback) {
    dataListeners.add(callback);
    return () => dataListeners.delete(callback);
  },
  onResize(callback) {
    resizeListeners.add(callback);
    return () => resizeListeners.delete(callback);
  },
};

const persistedConfig = new Map([
  ["model", "sdk/term-model"],
  ["mode", "plan"],
]);
const events = [];
const encoded = new TextEncoder();
let requestedModel;
let streamStartedAt;
let streamFinishedAt;
let releaseFirstStream;
const firstStreamRelease = new Promise((resolve) => {
  releaseFirstStream = resolve;
});
let secondRequestAt;
let secondRequestBody;
let requestCount = 0;
const mockFetch = async (_url, init) => {
  const requestBody = JSON.parse(new TextDecoder().decode(init.body));
  requestedModel = requestBody.model;
  requestCount += 1;
  if (requestCount === 2) {
    secondRequestAt = performance.now();
    secondRequestBody = requestBody;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.encode(`data: ${JSON.stringify({ id: "chat_queued", choices: [{ index: 0, delta: { content: queuedAnswer }, finish_reason: null }] })}\n\n`));
        controller.enqueue(encoded.encode('data: {"id":"chat_queued","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n'));
        controller.enqueue(encoded.encode("data: [DONE]\n"));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoded.encode('data: {"id":"chat_term","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n'));
      streamStartedAt = performance.now();
      const interval = setInterval(() => {
        controller.enqueue(encoded.encode('data: {"id":"chat_term","choices":[{"index":0,"delta":{"content":"."},"finish_reason":null}]}\n\n'));
      }, 20);
      await firstStreamRelease;
      clearInterval(interval);
      controller.enqueue(encoded.encode('data: {"id":"chat_term","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n'));
      controller.enqueue(encoded.encode('data: {"id":"chat_term","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n'));
      controller.enqueue(encoded.encode("data: [DONE]\n"));
      controller.close();
      streamFinishedAt = performance.now();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const runtime = await createFxTerminal({
  backend: "wasm",
  wasm: await readFile(wasmPath),
  terminal,
  env: { OPENAI_BASE_URL: "https://models.example/v1", OPENAI_API_KEY: "term-test-key" },
  fetch: mockFetch,
  configStore: {
    get(configId) { return persistedConfig.get(configId) ?? null; },
    set(configId, value) { persistedConfig.set(configId, value); },
  },
  onEvent(event) { events.push(event); },
  traceWasi: process.env.FX_WASI_TRACE === "1",
  stderr(bytes) { process.stderr.write(bytes); },
});
await Promise.race([
  runtime.interactive,
  new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for fx-term to become interactive")), 5000)),
]);
const startupDeadline = performance.now() + 5000;
while (!streamedText.includes("Run /help for commands")) {
  if (performance.now() >= startupDeadline) throw new Error("timed out waiting for startup output");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (drainCalls !== 1 || !drainCompleted) throw new Error("interactive resolved before the terminal adapter drained");
runtime.write("hello");
runtime.write("\x1b[D");
runtime.write("!");
runtime.write("\x7f");
runtime.write("\r");
const deadline = performance.now() + 5000;
while (streamStartedAt === undefined) {
  if (performance.now() >= deadline) throw new Error("timed out waiting for continuous fx-term response");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
observeZeroTimeouts = true;
runtime.write(liveDraft);
while (draftVisibleAt === undefined) {
  if (streamFinishedAt !== undefined) throw new Error("terminal did not render follow-up input while the response was active");
  if (performance.now() >= deadline) throw new Error("timed out waiting for live follow-up input");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
runtime.write("\r");
while (queuedVisibleAt === undefined) {
  if (streamFinishedAt !== undefined) throw new Error("terminal did not queue follow-up input while the response was active");
  if (performance.now() >= deadline) throw new Error("timed out waiting for queued follow-up input");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
observeZeroTimeouts = false;
if (secondRequestAt !== undefined) throw new Error("queued follow-up started before the active response finished");
releaseFirstStream();
while (streamFinishedAt === undefined) {
  if (performance.now() >= deadline) throw new Error("timed out waiting for streamed fx-term response");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const queuedDeadline = performance.now() + 5000;
while (secondRequestAt === undefined || !streamedText.includes(queuedAnswer)) {
  if (performance.now() >= queuedDeadline) throw new Error("timed out waiting for queued fx-term response");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
runtime.write("/exit\r");
const exitCode = await Promise.race([
  runtime.exited,
  new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for fx-term exit")), 5000)),
]);
globalThis.setTimeout = originalSetTimeout;
const text = new TextDecoder().decode(Buffer.concat(output.map((chunk) => Buffer.from(chunk))));

if (exitCode !== 0) throw new Error(`fx-term exited with code ${exitCode}`);
if (!text.includes("Y2 INFORMATION DOMINANCE")) throw new Error("Y2 welcome frame was not observed");
if (!text.includes("Run /help for commands")) throw new Error("shared Fx welcome guidance was not observed");
if (requestedModel !== "sdk/term-model") throw new Error(`terminal prompt did not use the host-restored model: ${requestedModel}`);
if (!(streamStartedAt < streamFinishedAt)) throw new Error("terminal fetch did not remain active for continuous streaming");
if (!(draftVisibleAt < streamFinishedAt)) throw new Error("terminal rendered follow-up input only after continuous streaming finished");
if (!(queuedVisibleAt < streamFinishedAt)) throw new Error("terminal queued follow-up input only after continuous streaming finished");
if (!(secondRequestAt >= streamFinishedAt)) throw new Error("terminal started queued follow-up before continuous streaming finished");
const queuedUser = secondRequestBody.messages?.filter((message) => message.role === "user").at(-1);
if (queuedUser?.content !== liveDraft) {
  throw new Error(`queued follow-up request changed the submitted draft: ${JSON.stringify(queuedUser?.content)}`);
}
if (requestCount !== 2) throw new Error(`terminal sent ${requestCount} requests instead of the active and queued turns`);
if (zeroTimeoutCount !== 0) throw new Error(`terminal allocated ${zeroTimeoutCount} zero-timeout poll timer(s)`);
if (!events.some((event) => event.type === "config.restore" && event.configId === "model")) throw new Error("terminal model restore event was not emitted");
if (!events.some((event) => event.type === "config.restore" && event.configId === "mode")) throw new Error("terminal mode restore event was not emitted");
console.error(`term SDK smoke passed: exit=${exitCode}, bytes=${Buffer.byteLength(text)}`);
