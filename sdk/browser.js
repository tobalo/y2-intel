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

const defaultCoreWasm = new URL("./y2-core.wasm", import.meta.url).href;
const defaultTermWasm = new URL("./y2-term.wasm", import.meta.url).href;

function normalizedOptions(options) {
  const env = options.env ?? {};
  if (env.Y2_API_CHAT_URL !== undefined || env.OPENAI_BASE_URL === undefined) return options;
  const url = new URL(env.OPENAI_BASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("OPENAI_BASE_URL must use HTTPS without credentials or a fragment");
  }
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  if (!trimmedPath.endsWith("/chat/completions")) {
    url.pathname = `${trimmedPath}/chat/completions`;
  }
  return { ...options, env: { ...env, Y2_API_CHAT_URL: url.href } };
}

export function createY2Agent(options = {}) {
  const resolved = normalizedOptions(options);
  return createWasmAgent({ ...resolved, wasm: resolved.wasm ?? defaultCoreWasm });
}

export function createY2Terminal(options = {}) {
  const resolved = normalizedOptions(options);
  return createWasmTerminal({ ...resolved, wasm: resolved.wasm ?? defaultTermWasm });
}
