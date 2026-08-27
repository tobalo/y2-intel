import {
  createFxAgent as createWasmAgent,
  createFxTerminal as createWasmTerminal,
  encodeXtermKeyEvent,
  fxSdkApiVersion,
  supportsJspi,
  xtermAdapter,
} from "./fx-sdk.js";

export { encodeXtermKeyEvent, fxSdkApiVersion, supportsJspi, xtermAdapter };
export const libfxApiVersion = 2;

const defaultCoreWasm = new URL("./fx-core.wasm", import.meta.url).href;
const defaultTermWasm = new URL("./fx-term.wasm", import.meta.url).href;

function normalizedOptions(options) {
  const env = options.env ?? {};
  if (env.FX_API_CHAT_URL !== undefined || env.OPENAI_BASE_URL === undefined) return options;
  const url = new URL(env.OPENAI_BASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("OPENAI_BASE_URL must use HTTPS without credentials or a fragment");
  }
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  if (!trimmedPath.endsWith("/chat/completions")) {
    url.pathname = `${trimmedPath}/chat/completions`;
  }
  return { ...options, env: { ...env, FX_API_CHAT_URL: url.href } };
}

export function createFxAgent(options = {}) {
  const resolved = normalizedOptions(options);
  return createWasmAgent({ ...resolved, wasm: resolved.wasm ?? defaultCoreWasm });
}

export function createFxTerminal(options = {}) {
  const resolved = normalizedOptions(options);
  return createWasmTerminal({ ...resolved, wasm: resolved.wasm ?? defaultTermWasm });
}
