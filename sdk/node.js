import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createY2Agent as createWasmAgent,
  createY2Terminal as createWasmTerminal,
  encodeXtermKeyEvent,
  y2SdkApiVersion,
  supportsJspi,
  xtermAdapter,
} from "./y2-sdk.js";

export { encodeXtermKeyEvent, y2SdkApiVersion, supportsJspi, xtermAdapter };
export const liby2ApiVersion = 2;

const fetchOperationStale = 0;
const fetchOperationApplied = 1;
const fetchOperationBackpressure = 2;

const require = createRequire(import.meta.url);
const defaultCoreWasm = new URL("./y2-core.wasm", import.meta.url);
const defaultTermWasm = new URL("./y2-term.wasm", import.meta.url);
const defaultY2ChatUrl = "https://api.y2.dev/api/v1/chat/completions";
const defaultNativeCandidates = [
  "./liby2.node",
  `./liby2.${process.platform}-${process.arch}.node`,
];
let nativeBackendPromise;

function jspiFallbackError(surface, nativeError) {
  const nativeDetail = nativeError ? ` Native loading failed: ${nativeError.message}.` : " No compatible native addon was found.";
  const error = new Error(
    `liby2 could not start the ${surface} backend.${nativeDetail} ` +
    "The WebAssembly fallback requires JavaScript Promise Integration (JSPI). " +
    "Run Node with --experimental-wasm-jspi or install a liby2 package containing a compatible native addon.",
  );
  error.code = "LIBY2_JSPI_REQUIRED";
  error.cause = nativeError;
  return error;
}

async function loadNativeCandidate(candidate) {
  if (candidate == null) return null;
  if (candidate instanceof URL) {
    if (candidate.protocol === "file:" && candidate.pathname.endsWith(".node")) {
      return require(fileURLToPath(candidate));
    }
    const imported = await import(candidate.href);
    return imported.default ?? imported;
  }
  if (typeof candidate === "object") return candidate.default ?? candidate;
  if (typeof candidate !== "string") {
    throw new TypeError("nativeAddon must be a module, path, URL, false, or undefined");
  }
  if (candidate.endsWith(".node")) return require(isAbsolute(candidate) ? candidate : resolve(candidate));
  const imported = await import(candidate.startsWith("file:") ? candidate : pathToFileURL(candidate).href);
  return imported.default ?? imported;
}

function validateNativeBackend(backend) {
  if (!backend) return null;
  const hasLowLevelCore = typeof backend.createCore === "function";
  if ((hasLowLevelCore && backend.liby2ApiVersion !== liby2ApiVersion) ||
    (!hasLowLevelCore && backend.liby2ApiVersion !== undefined && backend.liby2ApiVersion !== liby2ApiVersion)) {
    const actualVersion = backend.liby2ApiVersion ?? "missing";
    throw new Error(`native addon API version ${actualVersion} is incompatible with liby2 API version ${liby2ApiVersion}`);
  }
  if (typeof backend.createY2Agent !== "function" && typeof backend.createCore !== "function" &&
    typeof backend.createY2Terminal !== "function") {
    throw new Error("native addon must export createY2Agent(), createCore(), or createY2Terminal()");
  }
  return backend;
}

async function discoverNativeBackend() {
  for (const relativePath of defaultNativeCandidates) {
    const url = new URL(relativePath, import.meta.url);
    try {
      await access(fileURLToPath(url));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return { backend: null, error };
    }
    try {
      return { backend: validateNativeBackend(await loadNativeCandidate(url)), error: null };
    } catch (error) {
      return { backend: null, error };
    }
  }
  return { backend: null, error: null };
}

async function resolveNativeBackend(nativeAddon) {
  if (nativeAddon === false) return { backend: null, error: null };
  if (nativeAddon !== undefined) {
    try {
      return { backend: validateNativeBackend(await loadNativeCandidate(nativeAddon)), error: null };
    } catch (error) {
      return { backend: null, error };
    }
  }
  nativeBackendPromise ??= discoverNativeBackend();
  return nativeBackendPromise;
}

async function wasmBytes(input) {
  if (input instanceof URL && input.protocol === "file:") return readFile(input);
  if (typeof input === "string" && !URL.canParse(input)) return readFile(input);
  return input;
}

function validateApiChatUrl(value) {
  if (value === undefined) return;
  if (typeof value !== "string") throw new TypeError("Y2_API_CHAT_URL must be a string");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Y2_API_CHAT_URL must be a valid URL"); }
  if (url.username || url.password || url.hash) {
    throw new TypeError("Y2_API_CHAT_URL must not contain credentials or a fragment");
  }
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "http:" || !loopback || !url.port) {
    throw new TypeError("Y2_API_CHAT_URL must use HTTPS or explicit loopback HTTP");
  }
}

function resolveApiChatUrl(env = {}) {
  if (env.Y2_API_CHAT_URL !== undefined) {
    validateApiChatUrl(env.Y2_API_CHAT_URL);
    return env.Y2_API_CHAT_URL;
  }
  if (env.OPENAI_BASE_URL === undefined) return undefined;
  validateApiChatUrl(env.OPENAI_BASE_URL);
  const url = new URL(env.OPENAI_BASE_URL);
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  if (!trimmedPath.endsWith("/chat/completions")) {
    url.pathname = `${trimmedPath}/chat/completions`;
  }
  return url.href;
}

function isY2AgentChatUrl(value) {
  if (value === undefined) return true;
  const url = new URL(value);
  url.hash = "";
  return url.href.replace(/\/+$/, "") === defaultY2ChatUrl;
}

function normalizeRuntimeEnv(env = {}) {
  const gatewayChatUrl = resolveApiChatUrl(env);
  if (gatewayChatUrl === undefined || env.Y2_API_CHAT_URL !== undefined) return env;
  return { ...env, Y2_API_CHAT_URL: gatewayChatUrl };
}

function createNativeCoreRuntime(addon, options) {
  const gatewayChatUrl = resolveApiChatUrl(options.env);
  const apiKey = isY2AgentChatUrl(gatewayChatUrl)
    ? options.env?.Y2_API_KEY
    : options.env?.OPENAI_API_KEY;
  const model = options.env?.Y2_MODEL;
  validateApiChatUrl(gatewayChatUrl);
  const core = addon.createCore({
    apiKey,
    home: options.home ?? homedir(),
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    ...(model === undefined ? {} : { model }),
    ...(gatewayChatUrl === undefined ? {} : { gatewayChatUrl }),
  });
  let exitedResolve;
  let lineHandler = null;
  let lineBuffer = "";
  let settled = false;
  let fetchState = null;
  const exited = new Promise((resolve) => { exitedResolve = resolve; });
  const abortHostEffects = () => {
    fetchState?.controller.abort();
    try { addon.abortCoreFetch(core); } catch {}
  };
  const finish = (code) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    abortHostEffects();
    try { addon.destroyCore(core); } catch {}
    exitedResolve(code);
  };
  const pumpFetch = async (request) => {
    const controller = new AbortController();
    const state = { handle: request.handle, controller };
    fetchState = state;
    try {
      const response = await (options.fetch ?? globalThis.fetch)(request.url, {
        method: request.method,
        headers: new Headers(JSON.parse(request.headers).map(({ name, value }) => [name, value])),
        body: request.body?.length ? Buffer.from(request.body, "base64") : undefined,
        signal: controller.signal,
      });
      const started = addon.startCoreFetchResponse(core, state.handle, response.status);
      if (started === fetchOperationStale) return;
      if (started !== fetchOperationApplied) throw new Error(`invalid native fetch start result ${started}`);
      if (response.body) {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          let offset = 0;
          while (offset < buffer.length) {
            const end = Math.min(offset + 64 * 1024, buffer.length);
            const pushed = addon.pushCoreFetchResponse(core, state.handle, buffer.subarray(offset, end));
            if (pushed === fetchOperationApplied) {
              offset = end;
              continue;
            }
            if (pushed === fetchOperationStale) return;
            if (pushed !== fetchOperationBackpressure) throw new Error(`invalid native fetch push result ${pushed}`);
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
        }
      }
      const finished = addon.finishCoreFetch(core, state.handle);
      if (finished !== fetchOperationApplied && finished !== fetchOperationStale) {
        throw new Error(`invalid native fetch finish result ${finished}`);
      }
    } catch (error) {
      if (error?.name !== "AbortError" || !controller.signal.aborted) {
        try {
          if (addon.coreFetchActive(core, state.handle)) addon.failCoreFetch(core, state.handle);
        } catch {}
      }
    } finally {
      if (fetchState === state) fetchState = null;
    }
  };
  const timer = setInterval(() => {
    try {
      if (fetchState) {
        if (!fetchState.controller.signal.aborted && !addon.coreFetchActive(core, fetchState.handle)) {
          fetchState.controller.abort();
        }
      } else {
        const fetchRequest = addon.takeCoreFetch(core);
        if (fetchRequest) void pumpFetch(JSON.parse(fetchRequest.toString("utf8")));
      }
      const chunk = addon.drainCore(core);
      if (chunk.length && lineHandler) {
        lineBuffer += chunk.toString("utf8");
        for (;;) {
          const newline = lineBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = lineBuffer.slice(0, newline);
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line) lineHandler(JSON.parse(line));
        }
      }
      if (addon.coreExited(core)) finish(addon.coreExitCode(core));
    } catch {
      finish(1);
    }
  }, 2);

  return {
    exited,
    write(data) { addon.writeCore(core, Buffer.from(data)); },
    closeStdin() { addon.closeCore(core); },
    abortHostEffects,
    abort() { abortHostEffects(); addon.closeCore(core); },
    setLineHandler(handler) { lineHandler = handler; },
  };
}

function createNativeAgent(addon, options) {
  return createWasmAgent({
    ...options,
    runtimeFactory(runtimeOptions) {
      return createNativeCoreRuntime(addon, runtimeOptions);
    },
  });
}

async function createWithFallback(surface, nativeMethod, wasmFactory, defaultWasm, options) {
  const { nativeAddon, backend = "auto", ...unresolvedRuntimeOptions } = options ?? {};
  const runtimeOptions = {
    ...unresolvedRuntimeOptions,
    env: normalizeRuntimeEnv(unresolvedRuntimeOptions.env),
  };
  if (!new Set(["auto", "native", "wasm"]).has(backend)) {
    throw new TypeError('backend must be "auto", "native", or "wasm"');
  }

  let nativeError;
  if (backend !== "wasm") {
    const native = await resolveNativeBackend(nativeAddon);
    nativeError = native.error;
    if (typeof native.backend?.[nativeMethod] === "function" ||
      (surface === "agent" && typeof native.backend?.createCore === "function")) {
      try {
        if (typeof native.backend?.[nativeMethod] === "function") {
          return await native.backend[nativeMethod](runtimeOptions);
        }
        return await createNativeAgent(native.backend, runtimeOptions);
      } catch (error) {
        nativeError = error;
        if (backend === "native") throw error;
      }
    }
    if (backend === "native") {
      const error = nativeError ?? new Error(`native addon does not provide ${nativeMethod}()`);
      error.code ??= "LIBY2_NATIVE_UNAVAILABLE";
      throw error;
    }
  }

  if (!supportsJspi()) throw jspiFallbackError(surface, nativeError);
  return wasmFactory({
    ...runtimeOptions,
    wasm: await wasmBytes(runtimeOptions.wasm ?? defaultWasm),
  });
}

export function createY2Agent(options = {}) {
  return createWithFallback("agent", "createY2Agent", createWasmAgent, defaultCoreWasm, options);
}

export function createY2Terminal(options = {}) {
  return createWithFallback("terminal", "createY2Terminal", createWasmTerminal, defaultTermWasm, options);
}
