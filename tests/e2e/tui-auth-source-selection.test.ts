import { afterEach, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Y2_BIN, REPO_ROOT, runY2 } from "../evals/eval-helpers";
import {
  FAKE_GATEWAY_MODEL,
  fakeGatewayFinalText,
  startFakeGateway,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const HAS_TMUX = tmuxAvailable();
if (process.env.Y2_REQUIRE_TMUX === "1" && !HAS_TMUX) {
  throw new Error("tmux is required for tui-auth-source-selection.test.ts");
}

const tmuxTest = test.skipIf(!HAS_TMUX);
const profileStoredKeyTmuxTest = test.skipIf(!HAS_TMUX || process.platform === "darwin");
const TIMEOUT = 30_000;
const ENV_TOKEN = "env-api-key-token";

function grokSubscriptionModel(id: string, contextWindow: number, efforts: string[] = []) {
  return {
    id,
    model: id,
    api_backend: "responses",
    context_window: contextWindow,
    supports_reasoning_effort: efforts.length > 0,
    reasoning_efforts: efforts.map((value) => ({ value })),
  };
}

function grokModalityModel(id: string, vision: boolean) {
  return {
    id,
    input_modalities: vision ? ["text", "image"] : ["text"],
    output_modalities: ["text"],
  };
}

let session: TmuxSession | null = null;
let home: string | null = null;
let stderrPath: string | null = null;
let gateway: ReturnType<typeof startFakeGateway> | null = null;
let chatgptOauth: ReturnType<typeof startFakeChatGptOAuth> | null = null;

afterEach(async () => {
  await session?.kill();
  session = null;
  gateway?.stop();
  gateway = null;
  chatgptOauth?.stop();
  chatgptOauth = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  stderrPath = null;
});

function writeSeededChatGptLogin(testHome: string, accessToken = chatgptAccessToken()): void {
  const y2Dir = join(testHome, ".y2");
  mkdirSync(y2Dir, { recursive: true, mode: 0o700 });
  chmodSync(y2Dir, 0o700);
  const authPath = join(y2Dir, "chatgpt-auth.json");
  writeFileSync(authPath, JSON.stringify({
    version: 1,
    access_token: accessToken,
    refresh_token: "chatgpt-refresh",
    expires_at_ms: Date.now() + 60 * 60 * 1000,
    account_id: "acct_e2e",
  }) + "\n", { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

function writeSeededGrokLogin(testHome: string, accessToken: string, accountId = "acct_grok_e2e"): void {
  const y2Dir = join(testHome, ".y2");
  mkdirSync(y2Dir, { recursive: true, mode: 0o700 });
  chmodSync(y2Dir, 0o700);
  const authPath = join(y2Dir, "grok-auth.json");
  writeFileSync(authPath, JSON.stringify({
    version: 1,
    access_token: accessToken,
    refresh_token: "grok-refresh",
    expires_at_ms: Date.now() + 60 * 60 * 1000,
    account_id: accountId,
  }) + "\n", { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

function readSingleUsageSnapshot(testHome: string): {
  billing: string;
  next_sequence: number;
  settled_through_sequence: number;
  pending: unknown[];
} {
  const sessionsDir = join(testHome, ".y2", "sessions");
  const usagePaths = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sessionsDir, entry.name, "usage-v2.json"))
    .filter((path) => existsSync(path));
  expect(usagePaths).toHaveLength(1);
  return (JSON.parse(readFileSync(usagePaths[0]!, "utf8")) as {
    snapshot: {
      billing: string;
      next_sequence: number;
      settled_through_sequence: number;
      pending: unknown[];
    };
  }).snapshot;
}

async function startY2(
  testHome: string,
  testStderrPath: string,
  fakeGateway: ReturnType<typeof startFakeGateway>,
  tracePath?: string,
  envOverrides: Record<string, string | undefined> = {},
  cwd?: string,
): Promise<TmuxSession> {
  return TmuxSession.create({
    cmd: Y2_BIN,
    cwd,
    env: {
      HOME: testHome,
      Y2_API_KEY: ENV_TOKEN,
      OPENAI_API_KEY: ENV_TOKEN,
      Y2_DISABLE_KEYCHAIN: "1",
      Y2_SKIP_ONBOARDING: "1",
      OPENAI_BASE_URL: `${fakeGateway.baseUrl}/v1`,
      Y2_API_CHAT_URL: fakeGateway.chatUrl,
      Y2_MODEL: FAKE_GATEWAY_MODEL,
      Y2_AUTO_UPGRADE: "0",
      Y2_NO_OPEN_BROWSER: "1",
      Y2_TRACE_LOG: tracePath,
      Y2_TRACE_SCOPES: tracePath ? "auth,prompt" : undefined,
      ...envOverrides,
    },
    stderrPath: testStderrPath,
    width: 100,
    height: 30,
  });
}

function chatgptAccessToken(accountId = "acct_e2e"): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function startFakeChatGptOAuth(
  options: {
    tokenDelayMs?: number;
    responseDelayMs?: number;
    unauthorizedResponses?: number;
  } = {},
) {
  const accessToken = chatgptAccessToken();
  let responseCount = 0;
  let models = [
    { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "max" }, { effort: "high" }], additional_speed_tiers: ["fast"], input_modalities: ["text", "image"], context_window: 272000 },
    { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
  ];
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body: string | null;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = url.pathname === "/chatgpt/responses" || url.pathname === "/chatgpt/token"
        ? await request.text()
        : null;
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      });
      if (url.pathname === "/oauth/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        if (!redirectUri || !state) return new Response("invalid authorize request", { status: 400 });
        const callback = new URL(redirectUri.replace("localhost", "127.0.0.1"));
        callback.searchParams.set("code", "chatgpt-code");
        callback.searchParams.set("state", state);
        return Response.redirect(callback.toString(), 302);
      }
      if (url.pathname === "/chatgpt/token") {
        if (options.tokenDelayMs) await Bun.sleep(options.tokenDelayMs);
        return Response.json({
          access_token: accessToken,
          refresh_token: "chatgpt-refresh",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/chatgpt/models") {
        return Response.json({ models });
      }
      if (url.pathname === "/chatgpt/responses") {
        responseCount += 1;
        if (responseCount <= (options.unauthorizedResponses ?? 0)) {
          return Response.json(
            { error: { message: "expired ChatGPT token" } },
            { status: 401 },
          );
        }
        if (options.responseDelayMs) await Bun.sleep(options.responseDelayMs);
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"CHATGPT_DIRECT_RESPONSE"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    accessToken,
    requests,
    env: {
      Y2_E2E_CHATGPT_ISSUER_URL: baseUrl,
      Y2_E2E_CHATGPT_TOKEN_URL: `${baseUrl}/chatgpt/token`,
      Y2_E2E_OPENAI_CODEX_MODELS_URL: `${baseUrl}/chatgpt/models`,
      Y2_E2E_OPENAI_CODEX_RESPONSES_URL: `${baseUrl}/chatgpt/responses`,
    },
    baseUrl,
    setModels(next: typeof models) {
      models = next;
    },
    stop() {
      server.stop(true);
    },
  };
}

function startFakeGrokOAuth(options: {
  unauthorizedResponses?: number;
  revokeStatus?: number;
  userinfoSub?: string;
} = {}) {
  const initialAccessToken = "grok-initial-access-token";
  const refreshedAccessToken = "grok-refreshed-access-token";
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body: string | null;
    conversationId: string | null;
    tokenAuth: string | null;
    authenticateResponse: string | null;
    clientIdentifier: string | null;
    clientVersion: string | null;
    modelOverride: string | null;
    grokUserId: string | null;
    userId: string | null;
    query: string;
  }> = [];
  let tokenCalls = 0;
  let responseCalls = 0;
  let models = [
    { id: "grok-4.20", object: "model", input_modalities: ["text", "image"], output_modalities: ["text"] },
    { id: "grok-4.6", object: "model", input_modalities: ["text", "image"], output_modalities: ["text"] },
    { id: "grok-image-only", object: "model", input_modalities: ["text"], output_modalities: ["image"] },
  ];
  const allSubscriptionModels = [
    grokSubscriptionModel("grok-4.20", 1_000_000),
    grokSubscriptionModel("grok-4.6", 500_000, ["xhigh", "high", "medium", "low"]),
  ];
  let subscriptionModels = allSubscriptionModels;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.text() : null;
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
        conversationId: request.headers.get("x-grok-conv-id"),
        tokenAuth: request.headers.get("x-xai-token-auth"),
        authenticateResponse: request.headers.get("x-authenticateresponse"),
        clientIdentifier: request.headers.get("x-grok-client-identifier"),
        clientVersion: request.headers.get("x-grok-client-version"),
        modelOverride: request.headers.get("x-grok-model-override"),
        grokUserId: request.headers.get("x-grok-user-id"),
        userId: request.headers.get("x-userid"),
        query: url.search,
      });
      if (url.pathname === "/oauth2/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        if (!redirectUri || !state || url.searchParams.get("nonce")) {
          return new Response("invalid authorize request", { status: 400 });
        }
        if (url.searchParams.get("referrer") !== "y2") {
          return new Response("missing y2 referrer", { status: 400 });
        }
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", "grok-code");
        callback.searchParams.set("state", state);
        return Response.redirect(callback.toString(), 302);
      }
      if (url.pathname === "/oauth2/token") {
        tokenCalls += 1;
        const form = new URLSearchParams(body ?? "");
        const refresh = form.get("grant_type") === "refresh_token";
        return Response.json({
          access_token: refresh ? refreshedAccessToken : initialAccessToken,
          refresh_token: refresh ? "grok-refresh-next" : "grok-refresh",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/oauth2/userinfo") {
        if (!request.headers.get("authorization")?.startsWith("Bearer grok-")) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ sub: options.userinfoSub ?? "acct_grok_e2e" });
      }
      if (url.pathname === "/oauth2/revoke") {
        const form = new URLSearchParams(body ?? "");
        const valid = form.get("client_id") === "b1a00492-073a-47ea-816f-4c329264a828" &&
          (form.get("token") === "grok-refresh-next" || form.get("token") === "grok-refresh");
        if (valid && options.revokeStatus && options.revokeStatus !== 200) {
          return Response.json({ error: "revocation unavailable" }, { status: options.revokeStatus });
        }
        return Response.json(valid ? { revoked: true } : { error: "invalid" }, {
          status: valid ? 200 : 400,
        });
      }
      if (url.pathname === "/v1/language-models") {
        return Response.json({ models });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({ data: subscriptionModels });
      }
      if (url.pathname === "/v1/responses") {
        responseCalls += 1;
        if (responseCalls <= (options.unauthorizedResponses ?? 0)) {
          return Response.json({ error: { message: "expired" } }, { status: 401 });
        }
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"GROK_DIRECT_RESPONSE"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    initialAccessToken,
    refreshedAccessToken,
    requests,
    tokenCalls: () => tokenCalls,
    baseUrl,
    env: {
      Y2_E2E_GROK_ISSUER_URL: baseUrl,
      Y2_E2E_GROK_TOKEN_URL: `${baseUrl}/oauth2/token`,
      Y2_E2E_GROK_USERINFO_URL: `${baseUrl}/oauth2/userinfo`,
      Y2_E2E_GROK_REVOKE_URL: `${baseUrl}/oauth2/revoke`,
      Y2_E2E_XAI_GROK_MODELS_URL: `${baseUrl}/v1/models`,
      Y2_E2E_XAI_GROK_MODALITIES_URL: `${baseUrl}/v1/language-models`,
      Y2_E2E_XAI_GROK_RESPONSES_URL: `${baseUrl}/v1/responses`,
    },
    setModels(next: typeof models) {
      models = next;
      const visibleIds = new Set(next.map((model) => model.id));
      subscriptionModels = allSubscriptionModels.filter((model) => visibleIds.has(model.id));
    },
    stop() { server.stop(true); },
  };
}

async function runGrokLoginWithBrowser(
  env: Record<string, string | undefined>,
  authorizationCode?: string,
) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const proc = nodeSpawn(Y2_BIN, ["login", "grok"], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: [authorizationCode ? "pipe" : "ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const deadline = Date.now() + TIMEOUT;
  let authorizationUrl: string | undefined;
  while (Date.now() < deadline) {
    authorizationUrl = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize\?\S+/)?.[0];
    if (authorizationUrl) break;
    await Bun.sleep(20);
  }
  if (!authorizationUrl) {
    proc.kill("SIGTERM");
    throw new Error(`Grok login did not print an authorization URL: ${stdout}\n${stderr}`);
  }
  if (authorizationCode) {
    proc.stdin!.end(`${authorizationCode}\n`);
  } else {
    const response = await fetch(authorizationUrl, { redirect: "follow" });
    expect(response.status).toBe(200);
  }
  const code = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (value) => resolve(value ?? 1));
  });
  return { code, stdout, stderr };
}

async function completeDisplayedGrokLogin(
  activeSession: TmuxSession,
  fixture: ReturnType<typeof startFakeGrokOAuth>,
) {
  await activeSession.resizeWindow(500, 20);
  const pane = await activeSession.waitForPane(
    (value) => value.includes(`${fixture.baseUrl}/oauth2/authorize?`),
    TIMEOUT,
  );
  const authorizationUrl = pane
    .split(/\s+/)
    .find((value) => value.startsWith(`${fixture.baseUrl}/oauth2/authorize?`));
  if (!authorizationUrl) throw new Error("Grok authorization URL was not rendered");
  const response = await fetch(authorizationUrl, { redirect: "follow" });
  expect(response.status).toBe(200);
  await activeSession.resizeWindow(100, 30);
}

async function completeDisplayedCodexLogin(
  activeSession: TmuxSession,
  fixture: ReturnType<typeof startFakeChatGptOAuth>,
) {
  await activeSession.waitForText("Authorize with Codex", TIMEOUT);
  const escapes = await activeSession.capturePaneEscapes();
  const urlStart = escapes.indexOf(`${fixture.baseUrl}/oauth/authorize?`);
  const linkStart = escapes.lastIndexOf("\x1b]8;", urlStart);
  const urlEnd = escapes.indexOf("\x1b\\", urlStart);
  if (urlStart < 0 || linkStart < 0 || urlEnd < 0) {
    throw new Error("Codex authorization hyperlink was not rendered");
  }
  const authorizationUrl = escapes.slice(urlStart, urlEnd);
  const response = await fetch(authorizationUrl, { redirect: "follow" });
  expect(response.status).toBe(200);
}

async function runCodexLoginWithBrowser(
  env: Record<string, string | undefined>,
) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const proc = nodeSpawn(Y2_BIN, ["login", "codex"], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const deadline = Date.now() + TIMEOUT;
  let authorizationUrl: string | undefined;
  while (Date.now() < deadline) {
    authorizationUrl = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?\S+/)?.[0];
    if (authorizationUrl) break;
    await Bun.sleep(20);
  }
  if (!authorizationUrl) {
    proc.kill("SIGTERM");
    throw new Error(`Codex login did not print an authorization URL: ${stdout}\n${stderr}`);
  }
  const response = await fetch(authorizationUrl, { redirect: "follow" });
  expect(response.status).toBe(200);
  const code = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (value) => resolve(value ?? 1));
  });
  return { code, stdout, stderr };
}

function startFakeCodexToolLoop(options: {
  toolName?: string;
  toolArguments?: object;
  finalText?: string;
} = {}) {
  const bodies: string[] = [];
  const accessToken = chatgptAccessToken("acct_tool_loop");
  const toolName = options.toolName ?? "read_file";
  const toolArguments = options.toolArguments ?? { path: "README.md" };
  const finalText = options.finalText ?? "CODEX_TOOL_LOOP_OK";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/models") {
        return Response.json({ models: [
          { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 272000 },
          { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
        ] });
      }
      bodies.push(await request.text());
      if (bodies.length === 1) {
        return new Response(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}\n\n' +
            'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_tool","type":"reasoning","summary":[],"encrypted_content":"opaque-tool-loop"}}\n\n' +
            `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_tool", name: toolName } })}\n\n` +
            `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, arguments: JSON.stringify(toolArguments) })}\n\n` +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: finalText })}\n\n` +
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    stop() { server.stop(true); },
  };
}

function startFakeCodexCapacityLoop() {
  const bodies: string[] = [];
  const accessToken = chatgptAccessToken("acct_capacity_loop");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/models") {
        return Response.json({ models: [
          { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 272000 },
        ] });
      }
      bodies.push(await request.text());
      const call = bodies.length;
      if (call <= 64) {
        return new Response(
          `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: `call_capacity_${call}`, name: "read_file" } })}\n\n` +
            `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 0, arguments: JSON.stringify({ path: "README.md", start_line: call, line_count: 1 }) })}\n\n` +
            `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_capacity_${call}`, status: "completed", usage: { input_tokens: 5, output_tokens: 2 } } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const text = call === 65 ? "CODEX_CAPACITY_65_OK" : "CODEX_CAPACITY_NEXT_OK";
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
          `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_capacity_${call}`, status: "completed", usage: { input_tokens: 7, output_tokens: 3 } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    stop() { server.stop(true); },
  };
}

function startFakeGrokToolLoop(options: {
  toolName?: string;
  toolArguments?: object;
  finalText?: string;
} = {}) {
  const bodies: string[] = [];
  const accessToken = "grok-tool-loop-token";
  const toolName = options.toolName ?? "read_file";
  const toolArguments = options.toolArguments ?? { path: "README.md" };
  const finalText = options.finalText ?? "GROK_TOOL_LOOP_OK";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/models") {
        return Response.json({ data: [grokSubscriptionModel("grok-4.20", 1_000_000)] });
      }
      if (path === "/modalities") {
        return Response.json({ models: [grokModalityModel("grok-4.20", true)] });
      }
      bodies.push(await request.text());
      if (bodies.length === 1) {
        return new Response(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}\n\n' +
            'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_tool","type":"reasoning","summary":[],"encrypted_content":"opaque-grok-tool-loop"}}\n\n' +
            `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_tool", name: toolName } })}\n\n` +
            `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, arguments: JSON.stringify(toolArguments) })}\n\n` +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: finalText })}\n\n` +
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    modalitiesUrl: `http://127.0.0.1:${server.port}/modalities`,
    stop() { server.stop(true); },
  };
}

function startFakeCodexAutoReview() {
  const bodies: string[] = [];
  const accessToken = chatgptAccessToken("acct_auto_review");
  let mainRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/models") {
        return Response.json({ models: [
          { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 272000 },
          { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
        ] });
      }
      const body = await request.text();
      bodies.push(body);
      const model = (JSON.parse(body) as { model?: string }).model;
      if (model === "gpt-5.4-mini") {
        return new Response(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_permission","name":"permission_decision"}}\n\n' +
            'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"risk\\":\\"low\\",\\"decision\\":\\"clear\\",\\"rationale\\":\\"The user requested this harmless command.\\"}"}\n\n' +
            'data: {"type":"response.completed","response":{"id":"gen_review","status":"completed","usage":{"input_tokens":8,"output_tokens":3}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      mainRequests += 1;
      if (mainRequests === 1) {
        return new Response(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_terminal","name":"terminal"}}\n\n' +
            'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"action\\":\\"exec\\",\\"command\\":\\"pwd\\",\\"timeout_ms\\":600000}"}\n\n' +
            'data: {"type":"response.completed","response":{"id":"gen_main_1","status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"CODEX_AUTO_REVIEW_OK"}\n\n' +
          'data: {"type":"response.completed","response":{"id":"gen_main_2","status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    stop() { server.stop(true); },
  };
}

function startFakeGrokAutoReview() {
  const bodies: string[] = [];
  const headers: Array<{
    tokenAuth: string | null;
    authenticateResponse: string | null;
    clientIdentifier: string | null;
    clientVersion: string | null;
    modelOverride: string | null;
    grokUserId: string | null;
  }> = [];
  const accessToken = "grok-auto-review-token";
  let mainRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/models") {
        return Response.json({ data: [grokSubscriptionModel("grok-4.20", 500_000)] });
      }
      if (path === "/modalities") {
        return Response.json({ models: [grokModalityModel("grok-4.20", false)] });
      }
      headers.push({
        tokenAuth: request.headers.get("x-xai-token-auth"),
        authenticateResponse: request.headers.get("x-authenticateresponse"),
        clientIdentifier: request.headers.get("x-grok-client-identifier"),
        clientVersion: request.headers.get("x-grok-client-version"),
        modelOverride: request.headers.get("x-grok-model-override"),
        grokUserId: request.headers.get("x-grok-user-id"),
      });
      const body = await request.text();
      bodies.push(body);
      if (body.includes('"name":"permission_decision"')) {
        return new Response(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_permission","name":"permission_decision"}}\n\n' +
            'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"risk\\":\\"low\\",\\"decision\\":\\"clear\\",\\"rationale\\":\\"The user requested this harmless command.\\"}"}\n\n' +
            'data: {"type":"response.completed","response":{"id":"gen_review","status":"completed","usage":{"input_tokens":8,"output_tokens":3}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      mainRequests += 1;
      if (mainRequests === 1) {
        return new Response(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_terminal","name":"terminal"}}\n\n' +
            'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"action\\":\\"exec\\",\\"command\\":\\"pwd\\",\\"timeout_ms\\":600000}"}\n\n' +
            'data: {"type":"response.completed","response":{"id":"gen_main_1","status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"GROK_AUTO_REVIEW_OK"}\n\n' +
          'data: {"type":"response.completed","response":{"id":"gen_main_2","status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    headers,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    modalitiesUrl: `http://127.0.0.1:${server.port}/modalities`,
    stop() { server.stop(true); },
  };
}

function startFakeGrokResourceRecovery() {
  const accessToken = "grok-resource-limit-token";
  const bodies: string[] = [];
  let responseCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/models") {
        return Response.json({ data: [grokSubscriptionModel("grok-4.20", 500_000)] });
      }
      if (path === "/modalities") {
        return Response.json({ models: [grokModalityModel("grok-4.20", false)] });
      }
      bodies.push(await request.text());
      responseCalls += 1;
      if (responseCalls === 1) {
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"' +
            "x".repeat(1024 * 1024) +
            '"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const text = responseCalls === 2 ? "GROK_LIMIT_RECOVERED" : "GROK_AFTER_LIMIT_OK";
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    modalitiesUrl: `http://127.0.0.1:${server.port}/modalities`,
    stop() { server.stop(true); },
  };
}


tmuxTest(
  "Codex sign-in renders browser OAuth without a device code and cancels cleanly",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-tui-chatgpt-cancel-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    gateway = startFakeGateway([]);
    chatgptOauth = startFakeChatGptOAuth();

    session = await startY2(
      home,
      stderrPath,
      gateway,
      undefined,
      chatgptOauth.env,
    );
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/login");
    await session.waitForText("Connections", TIMEOUT);
    await session.sendKeys("Enter");
    await session.waitForText("Codex subscription", TIMEOUT);
    await session.sendKeys("Down");
    await session.sendKeys("Enter");
    const signInScreen = await session.waitForPane(
      (pane) =>
        pane.includes("Sign in with Codex") &&
        pane.includes("Authorize with Codex") &&
        pane.includes("Waiting for authorization") &&
        pane.includes("Enter reopens browser · Esc cancels"),
      TIMEOUT,
    );
    expect(signInScreen).not.toContain("Code   ");
    expect(signInScreen).not.toContain(`${chatgptOauth.baseUrl}/oauth/authorize?`);
    const signInEscapes = await session.capturePaneEscapes();
    expect(signInEscapes).toContain(`\x1b]8;;${chatgptOauth.baseUrl}/oauth/authorize?`);
    expect(signInEscapes).toContain("\x1b]8;;\x1b\\");
    await session.sendKeys("C-c");
    await session.waitForComposer(TIMEOUT);

    expect(session.isAlive()).toBe(true);
    expect(existsSync(join(home, ".y2", "chatgpt-auth.json"))).toBe(false);
    expect(await session.captureFullScrollback()).not.toContain("Signed in with Codex.");
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);

tmuxTest(
  "setup provider switch reauthenticates current Codex and replaces an unavailable model",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-tui-chatgpt-success-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    gateway = startFakeGateway([], {
      models() {
        return [{ id: "openai/gpt-5.6-sol", type: "language", tags: ["tool-use"] }];
      },
    });
    chatgptOauth = startFakeChatGptOAuth();

    session = await startY2(
      home,
      stderrPath,
      gateway,
      undefined,
      {
        ...chatgptOauth.env,
        Y2_MODEL: undefined,
      },
    );
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/model openai/gpt-5.6-sol");
    await session.waitForText("Switched to openai/gpt-5.6-sol", TIMEOUT);
    await openProviderPicker(session);
    await session.sendKeys("Down");
    await session.sendKeys("Enter");
    await session.waitForText("Sign in with Codex", TIMEOUT);
    await completeDisplayedCodexLogin(session, chatgptOauth);
    await session.waitForText("Switched to Codex subscription with gpt-5.6-sol.", TIMEOUT);

    const authPath = join(home, ".y2", "chatgpt-auth.json");
    expect(existsSync(authPath)).toBe(true);
    expect(statSync(authPath).mode & 0o077).toBe(0);

    await session.sendText("/status");
    await session.waitForText(
      "model_source=Codex subscription",
      TIMEOUT,
    );
    await session.sendText("/model");
    const picker = await session.waitForPane(
      (pane) =>
        pane.includes("gpt-5.6-sol") &&
        pane.includes("gpt-5.4-mini"),
      TIMEOUT,
    );
    const pickerRows = picker.split("\n").filter((line) => /^\s+gpt-/.test(line));
    expect(pickerRows.join("\n")).not.toContain("openai/gpt-5.6-sol");
    await session.sendKeys("Escape");
    await session.sendKeys("C-c");
    await session.waitForComposer(TIMEOUT);
    await session.sendLiteralText("/model gpt-5.6-sol");
    await session.sendKeys("Space");
    await session.sendLiteralText("max");
    await session.sendKeys("Space");
    await session.sendLiteralText("fast");
    await session.sendKeys("Enter");
    await session.waitForText("Switched to gpt-5.6-sol", TIMEOUT);
    await session.sendText("/fast");
    await session.waitForText("Fast: off", TIMEOUT);
    await session.sendText("/fast");
    await session.waitForText("Fast: on", TIMEOUT);
    await session.sendText("Use the Codex subscription directly.");
    await session.waitForText("CHATGPT_DIRECT_RESPONSE", TIMEOUT);
    const directRequest = chatgptOauth.requests.find(
      (request) => request.path === "/chatgpt/responses",
    );
    expect(directRequest?.authorization).toBe(`Bearer ${chatgptOauth.accessToken}`);
    const directBody = JSON.parse(directRequest?.body ?? "{}") as {
      model?: string;
      service_tier?: string;
      max_output_tokens?: number;
      reasoning?: { effort?: string };
    };
    expect(directBody.model).toBe("gpt-5.6-sol");
    expect(directBody.service_tier).toBe("priority");
    expect(directBody.max_output_tokens).toBeUndefined();
    expect(directBody.reasoning?.effort).toBe("max");
    for (const request of [...gateway.requests, ...gateway.modelRequests]) {
      expect(request.headers.get("authorization")).not.toBe(
        `Bearer ${chatgptOauth.accessToken}`,
      );
    }
    await session.sendText("/models");
    await session.waitForPane(
      (pane) =>
        pane.includes("Models") &&
        pane.includes("gpt-5.6-sol") &&
        pane.includes("gpt-5.4-mini") &&
        !pane.includes("openai/gpt-5.6-sol"),
      TIMEOUT,
    );
    await session.sendKeys("Escape");
    await session.waitForPane((pane) => !pane.includes("Esc Close"), TIMEOUT);
    await session.waitForComposer(TIMEOUT);
    const authorizeRequestsBeforeRoundTrip = chatgptOauth.requests.filter(
      (request) => request.path === "/oauth/authorize",
    ).length;
    const settingsPath = join(home, ".y2", "settings.json");
    const gatewayModelBefore = JSON.parse(readFileSync(settingsPath, "utf8")).models.gateway;
    expect(typeof gatewayModelBefore).toBe("string");
    const savedCodex = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(savedCodex.models.gateway).toBe(gatewayModelBefore);
    expect(savedCodex.models.codex).toBe("gpt-5.6-sol");
    await session.sendText("/quit");
    await session.waitForSessionEnd(TIMEOUT);
    session = null;

    session = await startY2(
      home,
      stderrPath,
      gateway,
      undefined,
      {
        ...chatgptOauth.env,
        Y2_MODEL: undefined,
      },
    );
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/status");
    await session.waitForText("model=gpt-5.6-sol", TIMEOUT);
    await openProviderPicker(session);
    await session.sendKeys("Up");
    await session.sendKeys("Enter");
    await session.waitForText("Switched to Y2 / OpenAI-compatible API with y2-agent.", TIMEOUT);
    const savedGateway = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(savedGateway.provider).toBe("gateway");
    expect(savedGateway.models.gateway).toBe("y2-agent");
    expect(savedGateway.models.codex).toBe("gpt-5.6-sol");
    await openProviderPicker(session);
    await session.sendKeys("Down");
    await session.sendKeys("Enter");
    await session.waitForText("Switched to Codex subscription", TIMEOUT);
    const restoredCodex = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(restoredCodex.provider).toBe("codex");
    expect(restoredCodex.models.gateway).toBe("y2-agent");
    expect(restoredCodex.models.codex).toBe("gpt-5.6-sol");
    expect(chatgptOauth.requests.filter((request) => request.path === "/oauth/authorize"))
      .toHaveLength(authorizeRequestsBeforeRoundTrip);
    await session.sendText("/logout codex");
    await session.waitForText("Signed out of Codex.", TIMEOUT);
    expect(existsSync(authPath)).toBe(false);
    await session.sendText("/status");
    await session.waitForText("model_source=Codex subscription", TIMEOUT);
    chatgptOauth.setModels([
      { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
    ]);
    await openProviderPicker(session);
    await session.sendKeys("Enter");
    await session.waitForText("Sign in with Codex", TIMEOUT);
    await completeDisplayedCodexLogin(session, chatgptOauth);
    await session.waitForText("Switched to Codex subscription with gpt-5.4-mini.", TIMEOUT);
    const reauthenticated = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(reauthenticated.provider).toBe("codex");
    expect(reauthenticated.models.codex).toBe("gpt-5.4-mini");
    expect(chatgptOauth.requests.filter((request) => request.path === "/oauth/authorize"))
      .toHaveLength(authorizeRequestsBeforeRoundTrip + 1);
    await session.sendKeys("C-c");

    expect(session.isAlive()).toBe(true);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);

tmuxTest(
  "interactive Codex login activates a Codex catalog model",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-tui-chatgpt-login-activation-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    gateway = startFakeGateway([]);
    chatgptOauth = startFakeChatGptOAuth();

    session = await startY2(
      home,
      stderrPath,
      gateway,
      undefined,
      { ...chatgptOauth.env, Y2_MODEL: undefined },
    );
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/login");
    await session.waitForText("Connections", TIMEOUT);
    await session.sendKeys("Enter");
    await session.waitForText("Codex subscription", TIMEOUT);
    await session.sendKeys("Down");
    await session.sendKeys("Enter");
    await completeDisplayedCodexLogin(session, chatgptOauth);
    await session.waitForText("Switched to Codex subscription with gpt-5.6-sol.", TIMEOUT);

    const selected = JSON.parse(readFileSync(join(home, ".y2", "settings.json"), "utf8"));
    expect(selected.provider).toBe("codex");
    expect(selected.models.codex).toBe("gpt-5.6-sol");
    await session.sendText("/status");
    await session.waitForText("model_source=Codex subscription", TIMEOUT);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);

tmuxTest(
  "ChatGPT response transport cancels blocked HTTP without stopping the shell",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-tui-chatgpt-response-cancel-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    gateway = startFakeGateway([]);
    chatgptOauth = startFakeChatGptOAuth({ responseDelayMs: 10_000 });
    writeSeededChatGptLogin(home, chatgptOauth.accessToken);
    writeFileSync(
      join(home, ".y2", "settings.json"),
      JSON.stringify({ provider: "codex", codex_model: "gpt-5.6-sol" }) + "\n",
      { mode: 0o600 },
    );

    session = await startY2(
      home,
      stderrPath,
      gateway,
      undefined,
      {
        ...chatgptOauth.env,
        Y2_MODEL: undefined,
      },
    );
    await session.waitForComposer(TIMEOUT);
    await session.sendText("Cancel the blocked Codex response.");
    await Bun.sleep(300);
    const cancelStarted = Date.now();
    await session.sendKeys("C-c");
    await session.waitForText("System: cancelled", TIMEOUT);
    await session.waitForComposer(TIMEOUT);
    expect(Date.now() - cancelStarted).toBeLessThan(3_000);
    expect(session.isAlive()).toBe(true);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);



async function startY2WithoutAuth(
  testHome: string,
  testStderrPath: string,
  fakeGateway: ReturnType<typeof startFakeGateway>,
  cwd?: string,
): Promise<TmuxSession> {
  return TmuxSession.create({
    cmd: Y2_BIN,
    cwd,
    env: {
      HOME: testHome,
      Y2_API_KEY: undefined,
      Y2_DISABLE_KEYCHAIN: "1",
      Y2_SKIP_ONBOARDING: "1",
      OPENAI_BASE_URL: `${fakeGateway.baseUrl}/v1`,
      Y2_API_CHAT_URL: fakeGateway.chatUrl,
      Y2_MODEL: FAKE_GATEWAY_MODEL,
      Y2_AUTO_UPGRADE: "0",
    },
    stderrPath: testStderrPath,
    width: 100,
    height: 30,
  });
}

async function waitForTrace(tracePath: string, needle: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < TIMEOUT) {
    if (existsSync(tracePath) && readFileSync(tracePath, "utf8").includes(needle)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for trace: ${needle}`);
}

async function enterSwitchCredential(pickerSession: TmuxSession): Promise<void> {
  await pickerSession.sendKeys("Up");
  await pickerSession.sendKeys("Enter");
  await pickerSession.waitForPane(
    (pane) => pane.includes("Credential source") && pane.includes("Automatic"),
    TIMEOUT,
  );
}

async function openProviderPicker(pickerSession: TmuxSession): Promise<void> {
  await pickerSession.sendText("/setup");
  await pickerSession.waitForText("Setup", TIMEOUT);
  await pickerSession.sendKeys("Down");
  await pickerSession.sendKeys("Enter");
  await pickerSession.waitForPane(
    (pane) => pane.includes("Model provider") && pane.includes("Grok subscription"),
    TIMEOUT,
  );
}

async function openSwitchCredential(pickerSession: TmuxSession): Promise<void> {
  await pickerSession.sendText("/setup");
  await pickerSession.waitForText("Setup", TIMEOUT);
  await enterSwitchCredential(pickerSession);
}

function savedCredentialSource(testHome: string): string | undefined {
  const settingsPath = join(testHome, ".y2", "settings.json");
  if (!existsSync(settingsPath)) return undefined;
  return (JSON.parse(readFileSync(settingsPath, "utf8")) as { credential_source?: string })
    .credential_source;
}








test(
  "Codex CLI browser login fetches raw models and replays one 401 without Gateway leakage",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-codex-cli-login-"));
    gateway = startFakeGateway([]);
    chatgptOauth = startFakeChatGptOAuth({ unauthorizedResponses: 1 });
    const env = {
      HOME: home,
      OPENAI_API_KEY: ENV_TOKEN,
      Y2_DISABLE_KEYCHAIN: "1",
      Y2_SKIP_ONBOARDING: "1",
      Y2_AUTO_UPGRADE: "0",
      Y2_NO_OPEN_BROWSER: "1",
      OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
      ...chatgptOauth.env,
    };

    const login = await runCodexLoginWithBrowser(env);
    expect(login.code, `stdout: ${login.stdout}\nstderr: ${login.stderr}`).toBe(0);
    expect(login.stdout).toContain("Signed in with Codex.");
    expect(login.stdout).not.toContain("Code:");
    expect(login.stderr).toBe("");

    const authPath = join(home, ".y2", "chatgpt-auth.json");
    expect(existsSync(authPath)).toBe(true);
    expect(statSync(authPath).mode & 0o077).toBe(0);
    const settingsPath = join(home, ".y2", "settings.json");
    const selected = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(selected.provider).toBe("codex");
    expect(selected.models.codex).toBe("gpt-5.6-sol");

    const models = await runY2(["models", "--json"], { env, timeoutMs: TIMEOUT });
    const modelIds = (JSON.parse(models.stdout) as { models: Array<{ id: string }> }).models
      .map((model) => model.id);
    expect(modelIds).toContain("gpt-5.6-sol");
    expect(modelIds).toContain("gpt-5.4-mini");
    expect(modelIds.some((id) => id.includes("openai-codex/"))).toBe(false);

    const ask = await runY2(["ask", "--json", "--auto", "--no-save", "Answer directly."], {
      env,
      timeoutMs: TIMEOUT,
    });
    expect(ask.code, `stdout: ${ask.stdout}\nstderr: ${ask.stderr}`).toBe(0);
    expect(ask.stdout).toContain("CHATGPT_DIRECT_RESPONSE");
    const responses = chatgptOauth.requests.filter((request) => request.path === "/chatgpt/responses");
    expect(responses).toHaveLength(2);
    expect(responses[0]!.body).toBe(responses[1]!.body);
    expect(responses[0]!.authorization).toBe(`Bearer ${chatgptOauth.accessToken}`);
    for (const request of [...gateway.requests, ...gateway.modelRequests]) {
      expect(request.headers.get("authorization")).not.toBe(`Bearer ${chatgptOauth.accessToken}`);
    }

    const gatewayRequestsBeforeImage = gateway.requests.length;
    const gatewayModelRequestsBeforeImage = gateway.modelRequests.length;
    const imageAsk = await runY2([
      "ask",
      "--json",
      "--auto",
      "--no-save",
      "--image",
      join(REPO_ROOT, "tests/e2e/fixtures/favicon.png"),
      "Read the attached image directly.",
    ], {
      env,
      timeoutMs: TIMEOUT,
    });
    expect(imageAsk.code, `stdout: ${imageAsk.stdout}\nstderr: ${imageAsk.stderr}`).toBe(0);
    expect(imageAsk.stdout).toContain("CHATGPT_DIRECT_RESPONSE");
    const imageResponses = chatgptOauth.requests.filter(
      (request) => request.path === "/chatgpt/responses",
    );
    expect(imageResponses).toHaveLength(3);
    const imageBody = imageResponses[2]!.body ?? "";
    expect(imageBody.match(/"type":"input_image"/g)).toHaveLength(1);
    expect(imageBody).toContain("data:image/png;base64,");
    expect(imageBody).not.toContain('"name":"vision"');
    expect(gateway.requests).toHaveLength(gatewayRequestsBeforeImage);
    expect(gateway.modelRequests).toHaveLength(gatewayModelRequestsBeforeImage);

    const tokenRequestsBeforeRoundTrip = chatgptOauth.requests.filter(
      (request) => request.path === "/chatgpt/token",
    ).length;
    expect((await runY2(["provider", "gateway"], { env, timeoutMs: TIMEOUT })).code).toBe(0);
    expect((await runY2(["provider", "codex"], { env, timeoutMs: TIMEOUT })).code).toBe(0);
    expect(chatgptOauth.requests.filter((request) => request.path === "/chatgpt/token"))
      .toHaveLength(tokenRequestsBeforeRoundTrip);

    const logout = await runY2(["logout", "codex"], { env, timeoutMs: TIMEOUT });
    expect(logout.code).toBe(0);
    expect(logout.stdout).toContain("Signed out of Codex.");
    expect(existsSync(authPath)).toBe(false);
  },
  60_000,
);

test(
  "Grok CLI browser login fetches subscription models and replays one account-stable 401",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-cli-login-"));
    gateway = startFakeGateway([]);
    const grok = startFakeGrokOAuth({ unauthorizedResponses: 1 });
    try {
      const env = {
        HOME: home,
        OPENAI_API_KEY: ENV_TOKEN,
        Y2_DISABLE_KEYCHAIN: "1",
        Y2_SKIP_ONBOARDING: "1",
        Y2_AUTO_UPGRADE: "0",
        Y2_NO_OPEN_BROWSER: "1",
        OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
        ...grok.env,
      };

      const login = await runGrokLoginWithBrowser(env);
      expect(login.code, `stdout: ${login.stdout}\nstderr: ${login.stderr}`).toBe(0);
      expect(login.stdout).toContain("Signed in with Grok.");
      expect(login.stderr).toBe("");

      const authPath = join(home, ".y2", "grok-auth.json");
      expect(existsSync(authPath)).toBe(true);
      expect(statSync(authPath).mode & 0o077).toBe(0);
      const settings = JSON.parse(readFileSync(join(home, ".y2", "settings.json"), "utf8"));
      expect(settings.provider).toBe("grok");
      expect(settings.models.grok).toBe("grok-4.20");

      const models = await runY2(["models", "--json"], { env, timeoutMs: TIMEOUT });
      const modelIds = (JSON.parse(models.stdout) as { models: Array<{ id: string }> }).models
        .map((model) => model.id);
      expect(modelIds).toEqual(["grok-4.20", "grok-4.6"]);
      const subscriptionCatalogRequests = grok.requests.filter((request) => request.path === "/v1/models");
      expect(subscriptionCatalogRequests.length).toBeGreaterThan(0);
      for (const request of subscriptionCatalogRequests) {
        expect(request.tokenAuth).toBe("xai-grok-cli");
        expect(request.userId).toBe("acct_grok_e2e");
      }
      const modalityRequests = grok.requests.filter((request) => request.path === "/v1/language-models");
      expect(modalityRequests.length).toBeGreaterThan(0);
      for (const request of modalityRequests) {
        expect(request.tokenAuth).toBeNull();
        expect(request.userId).toBeNull();
      }

      const ask = await runY2(["ask", "--json", "--auto", "Answer directly."], {
        env,
        timeoutMs: TIMEOUT,
      });
      expect(ask.code, `stdout: ${ask.stdout}\nstderr: ${ask.stderr}`).toBe(0);
      expect(ask.stdout).toContain("GROK_DIRECT_RESPONSE");
      const responses = grok.requests.filter((request) => request.path === "/v1/responses");
      expect(responses).toHaveLength(2);
      expect(responses[0]!.body).toBe(responses[1]!.body);
      expect(responses[0]!.conversationId).toBeTruthy();
      expect(responses[0]!.conversationId).toBe(responses[1]!.conversationId);
      expect(responses[0]!.authorization).toBe(`Bearer ${grok.initialAccessToken}`);
      expect(responses[1]!.authorization).toBe(`Bearer ${grok.refreshedAccessToken}`);
      for (const request of responses) {
        expect(request.tokenAuth).toBe("xai-grok-cli");
        expect(request.authenticateResponse).toBe("authenticate-response");
        expect(request.clientIdentifier).toBe("y2");
        expect(request.clientVersion).toBe("1.0.6");
        expect(request.modelOverride).toBe("grok-4.20");
        expect(request.grokUserId).toBe("acct_grok_e2e");
        expect(request.userId).toBeNull();
      }
      expect(grok.tokenCalls()).toBe(2);
      const userinfo = grok.requests.filter((request) => request.path === "/oauth2/userinfo");
      expect(userinfo).toHaveLength(2);
      for (const request of [...gateway.requests, ...gateway.modelRequests]) {
        expect(request.headers.get("authorization")).not.toContain("grok-");
      }

      expect((await runY2(["provider", "gateway"], { env, timeoutMs: TIMEOUT })).code).toBe(0);
      expect((await runY2(["provider", "grok"], { env, timeoutMs: TIMEOUT })).code).toBe(0);
      expect(grok.tokenCalls()).toBe(2);

      const logout = await runY2(["logout", "grok"], { env, timeoutMs: TIMEOUT });
      expect(logout.code, `stdout: ${logout.stdout}\nstderr: ${logout.stderr}`).toBe(0);
      expect(logout.stdout).toContain("Signed out of Grok.");
      expect(grok.requests.some((request) => request.path === "/oauth2/revoke")).toBe(true);
      expect(existsSync(authPath)).toBe(false);
    } finally {
      grok.stop();
    }
  },
  60_000,
);

test(
  "Grok CLI accepts an authorization code copied from the browser",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-cli-code-"));
    gateway = startFakeGateway([]);
    const grok = startFakeGrokOAuth();
    try {
      const result = await runGrokLoginWithBrowser({
        HOME: home,
        OPENAI_API_KEY: ENV_TOKEN,
        Y2_DISABLE_KEYCHAIN: "1",
        Y2_SKIP_ONBOARDING: "1",
        Y2_AUTO_UPGRADE: "0",
        Y2_NO_OPEN_BROWSER: "1",
        OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
        ...grok.env,
      }, "grok-code");

      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Signed in with Grok.");
      expect(result.stdout).not.toContain("grok-code");
      expect(result.stderr).toBe("");
      expect(grok.tokenCalls()).toBe(1);
      expect(existsSync(join(home, ".y2", "grok-auth.json"))).toBe(true);
    } finally {
      grok.stop();
    }
  },
  15_000,
);

test("Grok logout removes local credentials when remote revocation fails", async () => {
  home = mkdtempSync(join(tmpdir(), "y2-grok-logout-revoke-failure-"));
  const grok = startFakeGrokOAuth({ revokeStatus: 503 });
  try {
    writeSeededGrokLogin(home, grok.initialAccessToken);
    writeFileSync(
      join(home, ".y2", "settings.json"),
      JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
      { mode: 0o600 },
    );
    const authPath = join(home, ".y2", "grok-auth.json");
    const result = await runY2(["logout", "grok"], {
      env: {
        HOME: home,
        Y2_DISABLE_KEYCHAIN: "1",
        Y2_AUTO_UPGRADE: "0",
        Y2_E2E_GROK_REVOKE_URL: grok.env.Y2_E2E_GROK_REVOKE_URL,
      },
      timeoutMs: TIMEOUT,
    });
    expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Signed out of Grok.");
    expect(result.stderr).toContain("remote revocation could not be confirmed");
    expect(existsSync(authPath)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".y2", "settings.json"), "utf8")).provider)
      .toBe("grok");
    const ask = await runY2(["ask", "--json", "--no-save", "Still Grok?"], {
      env: { HOME: home, Y2_DISABLE_KEYCHAIN: "1", Y2_AUTO_UPGRADE: "0" },
      timeoutMs: TIMEOUT,
    });
    expect(ask.code).toBe(1);
    expect(ask.stderr).toContain("y2 login grok");
  } finally {
    grok.stop();
  }
});

test("Grok 401 replay refuses a different account before the second provider send", async () => {
  home = mkdtempSync(join(tmpdir(), "y2-grok-account-mismatch-"));
  gateway = startFakeGateway([]);
  const grok = startFakeGrokOAuth({ unauthorizedResponses: 1, userinfoSub: "acct_other" });
  try {
    writeSeededGrokLogin(home, grok.initialAccessToken);
    writeFileSync(
      join(home, ".y2", "settings.json"),
      JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
      { mode: 0o600 },
    );
    const env = {
      HOME: home,
      OPENAI_API_KEY: ENV_TOKEN,
      Y2_DISABLE_KEYCHAIN: "1",
      Y2_AUTO_UPGRADE: "0",
      OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
      ...grok.env,
    };
    const ask = await runY2(["ask", "--json", "--auto", "--no-save", "Answer."], {
      env,
      timeoutMs: TIMEOUT,
    });
    expect(ask.code).toBe(1);
    expect(grok.requests.filter((request) => request.path === "/v1/responses")).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(home, ".y2", "grok-auth.json"), "utf8")) as {
      access_token: string;
      account_id: string;
    };
    expect(saved.access_token).toBe(grok.initialAccessToken);
    expect(saved.account_id).toBe("acct_grok_e2e");
    for (const request of [...gateway.requests, ...gateway.modelRequests]) {
      expect(request.headers.get("authorization")).not.toContain("grok-");
    }
  } finally {
    grok.stop();
  }
});

test("Grok CLI sends verified images directly without advertising the vision fallback", async () => {
  home = mkdtempSync(join(tmpdir(), "y2-grok-native-image-"));
  gateway = startFakeGateway([]);
  const grok = startFakeGrokOAuth();
  try {
    writeSeededGrokLogin(home, grok.initialAccessToken);
    writeFileSync(
      join(home, ".y2", "settings.json"),
      JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
      { mode: 0o600 },
    );
    const imagePath = join(home, "attachment.png");
    writeFileSync(imagePath, Buffer.from("89504e470d0a1a0a72657374", "hex"));
    const ask = await runY2([
      "ask",
      "--json",
      "--auto",
      "--no-save",
      "--image",
      imagePath,
      "Describe the image.",
    ], {
      env: {
        HOME: home,
        OPENAI_API_KEY: ENV_TOKEN,
        Y2_DISABLE_KEYCHAIN: "1",
        Y2_AUTO_UPGRADE: "0",
        OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
        ...grok.env,
      },
      timeoutMs: TIMEOUT,
    });
    expect(ask.code, `stdout: ${ask.stdout}\nstderr: ${ask.stderr}`).toBe(0);
    const responses = grok.requests.filter((request) => request.path === "/v1/responses");
    expect(responses).toHaveLength(1);
    expect(responses[0]!.body).toContain('"type":"input_image"');
    expect(responses[0]!.body).not.toContain('"name":"vision"');
    expect(gateway.requests).toHaveLength(0);
  } finally {
    grok.stop();
  }
});

tmuxTest(
  "interactive Grok login activates Grok and setup round-trips without reauthentication",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-tui-switch-"));
    stderrPath = join(home, "stderr.log");
    gateway = startFakeGateway([fakeGatewayFinalText("GATEWAY_AFTER_GROK")]);
    const grok = startFakeGrokOAuth();
    try {
      session = await startY2(home, stderrPath, gateway, undefined, {
        Y2_MODEL: undefined,
        ...grok.env,
      });
      await session.waitForText("auto ·", TIMEOUT);

      await session.sendText("/login");
      await session.waitForText("Connections", TIMEOUT);
      await session.sendKeys("Enter");
      await session.waitForText("Grok subscription", TIMEOUT);
      await session.sendKeys("Down");
      await session.sendKeys("Down");
      await session.sendKeys("Enter");
      await completeDisplayedGrokLogin(session, grok);
      await session.waitForText("Switched to Grok subscription with grok-4.20.", TIMEOUT);
      await session.sendText("Answer from Grok.");
      await session.waitForText("GROK_DIRECT_RESPONSE", TIMEOUT);

      const tokenCallsAfterLogin = grok.tokenCalls();
      await openProviderPicker(session);
      await session.sendKeys("Up");
      await session.sendKeys("Up");
      await session.sendKeys("Enter");
      await session.waitForText("Switched to Y2 / OpenAI-compatible API with y2-agent.", TIMEOUT);
      await openProviderPicker(session);
      await session.sendKeys("Down");
      await session.sendKeys("Down");
      await session.sendKeys("Enter");
      await session.waitForText("Switched to Grok subscription with grok-4.20.", TIMEOUT);
      const settingsPath = join(home, ".y2", "settings.json");
      const persistenceDeadline = Date.now() + TIMEOUT;
      let saved: { provider: string; models: { grok: string } } | undefined;
      while (Date.now() < persistenceDeadline) {
        saved = JSON.parse(readFileSync(settingsPath, "utf8")) as {
          provider: string;
          models: { grok: string };
        };
        if (saved.provider === "grok") break;
        await Bun.sleep(25);
      }
      expect(saved).toBeDefined();
      expect(grok.tokenCalls()).toBe(tokenCallsAfterLogin);
      expect(saved!.provider).toBe("grok");
      expect(saved!.models.grok).toBe("grok-4.20");
      const responses = grok.requests.filter((request) => request.path === "/v1/responses");
      expect(responses).toHaveLength(1);
      expect(responses[0]!.conversationId).toBeTruthy();
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

tmuxTest(
  "interactive Grok login accepts a bracketed-paste authorization code",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-tui-code-"));
    stderrPath = join(home, "stderr.log");
    gateway = startFakeGateway([]);
    const grok = startFakeGrokOAuth();
    try {
      session = await startY2(home, stderrPath, gateway, undefined, {
        Y2_MODEL: undefined,
        ...grok.env,
      });
      await session.waitForComposer(TIMEOUT);
      await session.sendText("/login");
      await session.waitForText("Connections", TIMEOUT);
      await session.sendKeys("Enter");
      await session.waitForText("Grok subscription", TIMEOUT);
      await session.sendKeys("Down");
      await session.sendKeys("Down");
      await session.sendKeys("Enter");
      await session.waitForText("Paste the code shown by xAI", TIMEOUT);
      await session.resizeWindow(80, 5);
      const compactEntry = await session.waitForPane(
        (pane) =>
          pane.includes("Paste or type the code") &&
          pane.includes("Enter submits") &&
          pane.includes("Esc cancels"),
        TIMEOUT,
      );
      expect(compactEntry).not.toContain("Paste the code shown by xAI");
      await session.pasteText("grok-code");
      await session.waitForPane(
        (pane) => pane.includes("•••••••••") && pane.includes("Enter submits"),
        TIMEOUT,
      );
      await session.sendKeys("Enter");
      await session.waitForText("Switched to Grok subscription with grok-4.20.", TIMEOUT);

      const scrollback = await session.captureFullScrollback();
      expect(scrollback).not.toContain("grok-code");
      expect(grok.tokenCalls()).toBe(1);
      expect(existsSync(join(home, ".y2", "grok-auth.json"))).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

tmuxTest(
  "Grok model selection uses provider-advertised context and effort metadata",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-effort-selection-"));
    stderrPath = join(home, "stderr.log");
    gateway = startFakeGateway([]);
    const grok = startFakeGrokOAuth();
    try {
      writeSeededGrokLogin(home, grok.initialAccessToken);
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "grok", grok_model: "grok-4.20", statusLine: { context: true } }) + "\n",
        { mode: 0o600 },
      );
      session = await startY2(home, stderrPath, gateway, undefined, {
        Y2_MODEL: undefined,
        ...grok.env,
      });
      await session.waitForComposer(TIMEOUT);
      const catalogDeadline = Date.now() + TIMEOUT;
      while (!grok.requests.some((request) => request.path === "/v1/language-models")) {
        if (Date.now() >= catalogDeadline) throw new Error("Grok catalog did not load");
        await Bun.sleep(25);
      }
      await session.sendText("/model grok-4.6 xhigh");
      await session.waitForText("Switched to grok-4.6", TIMEOUT);
      await session.sendText("Use the selected effort.");
      await session.waitForText("GROK_DIRECT_RESPONSE", TIMEOUT);

      const response = grok.requests.find((request) => request.path === "/v1/responses");
      expect(response).toBeDefined();
      const body = JSON.parse(response!.body ?? "{}") as {
        model?: string;
        reasoning?: { effort?: string };
      };
      expect(body.model).toBe("grok-4.6");
      expect(body.reasoning?.effort).toBe("xhigh");
      expect(await session.capturePane()).toContain("/500k");
      expect(readFileSync(join(home, ".y2", "settings.json"), "utf8")).toContain('"effort":"xhigh"');
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

tmuxTest(
  "Grok resource exhaustion stays on-provider and leaves later input usable",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-resource-recovery-"));
    stderrPath = join(home, "stderr.log");
    gateway = startFakeGateway([]);
    const grok = startFakeGrokResourceRecovery();
    try {
      writeSeededGrokLogin(home, grok.accessToken, "acct_resource_limit");
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
        { mode: 0o600 },
      );
      session = await startY2(home, stderrPath, gateway, undefined, {
        Y2_MODEL: undefined,
        Y2_E2E_XAI_GROK_RESPONSES_URL: grok.responsesUrl,
        Y2_E2E_XAI_GROK_MODELS_URL: grok.modelsUrl,
        Y2_E2E_XAI_GROK_MODALITIES_URL: grok.modalitiesUrl,
      });
      await session.waitForComposer(TIMEOUT);
      const failureVisible = session.waitForText("request failed: XaiGrokSseEventTooLarge", TIMEOUT);
      await session.sendText("Recover from a bounded Grok response.");
      await failureVisible;
      await session.sendText("Accept another prompt after recovery.");
      await session.waitForText("GROK_LIMIT_RECOVERED", TIMEOUT);
      await session.sendText("Accept one more prompt after recovery.");
      await session.waitForText("GROK_AFTER_LIMIT_OK", TIMEOUT);

      const scrollback = await session.captureFullScrollback();
      expect(scrollback).toContain("XaiGrokSseEventTooLarge");
      expect(grok.bodies).toHaveLength(3);
      expect(gateway.requests).toHaveLength(0);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

test(
  "ChatGPT tool loops round-trip encrypted reasoning without Gateway leakage",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-chatgpt-tool-loop-"));
    gateway = startFakeGateway([]);
    const codex = startFakeCodexToolLoop();
    try {
      writeSeededChatGptLogin(home, codex.accessToken);
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "codex", codex_model: "gpt-5.6-sol" }) + "\n",
        { mode: 0o600 },
      );
      const result = await runY2(
        ["ask", "--json", "--auto", "--no-save", "Read the README, then finish."],
        {
          env: {
            HOME: home,
            OPENAI_API_KEY: "gateway-tool-loop-sentinel",
            Y2_DISABLE_KEYCHAIN: "1",
            Y2_AUTO_UPGRADE: "0",
            OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
            Y2_E2E_OPENAI_CODEX_RESPONSES_URL: codex.responsesUrl,
            Y2_E2E_OPENAI_CODEX_MODELS_URL: codex.modelsUrl,
          },
          timeoutMs: TIMEOUT,
        },
      );
      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("CODEX_TOOL_LOOP_OK");
      expect(codex.bodies).toHaveLength(2);
      expect(codex.bodies[1]).toContain('"encrypted_content":"opaque-tool-loop"');
      expect(codex.bodies[1]).toContain('"type":"function_call_output"');
      for (const request of [...gateway.requests, ...gateway.modelRequests]) {
        expect(request.headers.get("authorization")).not.toBe(`Bearer ${codex.accessToken}`);
      }
    } finally {
      codex.stop();
    }
  },
  60_000,
);

tmuxTest(
  "Codex remains usable beyond Gateway observation capacity in one process",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-codex-capacity-loop-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    gateway = startFakeGateway([]);
    const codex = startFakeCodexCapacityLoop();
    try {
      writeSeededChatGptLogin(home, codex.accessToken);
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "codex", codex_model: "gpt-5.6-sol" }) + "\n",
        { mode: 0o600 },
      );
      session = await startY2(home, stderrPath, gateway, undefined, {
        Y2_MODEL: undefined,
        Y2_E2E_OPENAI_CODEX_RESPONSES_URL: codex.responsesUrl,
        Y2_E2E_OPENAI_CODEX_MODELS_URL: codex.modelsUrl,
      });
      await session.waitForComposer(TIMEOUT);
      await session.sendText("Read enough lines to complete the capacity loop.");
      await session.waitForText("CODEX_CAPACITY_65_OK", 120_000);
      expect(codex.bodies).toHaveLength(65);

      await session.sendText("Confirm the same process remains usable.");
      await session.waitForText("CODEX_CAPACITY_NEXT_OK", TIMEOUT);
      expect(codex.bodies).toHaveLength(66);
      expect(await session.captureFullScrollback()).not.toContain("UsageCapacityExceeded");
      expect(gateway.requests).toHaveLength(0);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      codex.stop();
    }
  },
  150_000,
);

test(
  "Grok tool loops round-trip encrypted reasoning without Gateway leakage",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-tool-loop-"));
    gateway = startFakeGateway([]);
    const grok = startFakeGrokToolLoop();
    try {
      writeSeededGrokLogin(home, grok.accessToken, "acct_tool_loop");
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
        { mode: 0o600 },
      );
      const result = await runY2(
        ["ask", "--json", "--auto", "--no-save", "Read the README, then finish."],
        {
          env: {
            HOME: home,
            OPENAI_API_KEY: "gateway-grok-tool-loop-sentinel",
            Y2_DISABLE_KEYCHAIN: "1",
            Y2_AUTO_UPGRADE: "0",
            OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
            Y2_E2E_XAI_GROK_RESPONSES_URL: grok.responsesUrl,
            Y2_E2E_XAI_GROK_MODELS_URL: grok.modelsUrl,
            Y2_E2E_XAI_GROK_MODALITIES_URL: grok.modalitiesUrl,
          },
          timeoutMs: TIMEOUT,
        },
      );
      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("GROK_TOOL_LOOP_OK");
      expect(grok.bodies).toHaveLength(2);
      expect(grok.bodies[1]).toContain('"encrypted_content":"opaque-grok-tool-loop"');
      expect(grok.bodies[1]).toContain('"type":"function_call_output"');
      for (const request of [...gateway.requests, ...gateway.modelRequests]) {
        expect(request.headers.get("authorization")).not.toContain("grok-tool-loop-token");
      }
    } finally {
      grok.stop();
    }
  },
  60_000,
);

test(
  "Codex CLI login preserves durable auth but does not claim success when activation fails",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-codex-cli-activation-failure-"));
    gateway = startFakeGateway([]);
    chatgptOauth = startFakeChatGptOAuth();
    chatgptOauth.setModels([]);
    const env = {
      HOME: home,
      OPENAI_API_KEY: ENV_TOKEN,
      Y2_DISABLE_KEYCHAIN: "1",
      Y2_SKIP_ONBOARDING: "1",
      Y2_AUTO_UPGRADE: "0",
      Y2_NO_OPEN_BROWSER: "1",
      OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
      ...chatgptOauth.env,
    };

    const login = await runCodexLoginWithBrowser(env);
    expect(login.code).toBe(1);
    expect(login.stdout).not.toContain("Signed in with Codex.");
    expect(login.stderr).toContain("y2 login: could not load the target model catalog (malformed_response)");
    expect(existsSync(join(home, ".y2", "chatgpt-auth.json"))).toBe(true);
    const settingsPath = join(home, ".y2", "settings.json");
    expect(existsSync(settingsPath)).toBe(false);
  },
  60_000,
);

test(
  "Grok CLI login preserves durable auth but does not claim success when activation fails",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-cli-activation-failure-"));
    gateway = startFakeGateway([]);
    const grok = startFakeGrokOAuth();
    grok.setModels([]);
    try {
      const env = {
        HOME: home,
        OPENAI_API_KEY: ENV_TOKEN,
        Y2_DISABLE_KEYCHAIN: "1",
        Y2_SKIP_ONBOARDING: "1",
        Y2_AUTO_UPGRADE: "0",
        Y2_NO_OPEN_BROWSER: "1",
        OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
        ...grok.env,
      };

      const login = await runGrokLoginWithBrowser(env);
      expect(login.code).toBe(1);
      expect(login.stdout).not.toContain("Signed in with Grok.");
      expect(login.stderr).toContain("y2 login: target model catalog is empty");
      expect(existsSync(join(home, ".y2", "grok-auth.json"))).toBe(true);
      expect(existsSync(join(home, ".y2", "settings.json"))).toBe(false);
    } finally {
      grok.stop();
    }
  },
  60_000,
);

test(
  "Codex rejects the vision fallback without another provider request",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-codex-vision-disabled-"));
    gateway = startFakeGateway([]);
    const codex = startFakeCodexToolLoop({
      toolName: "vision",
      toolArguments: { image_ids: [1], focus: "Inspect the image." },
      finalText: "CODEX_VISION_DISABLED_OK",
    });
    try {
      writeSeededChatGptLogin(home, codex.accessToken);
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "codex", codex_model: "gpt-5.6-sol" }) + "\n",
        { mode: 0o600 },
      );
      const result = await runY2(
        ["ask", "--json", "--auto", "--no-save", "Answer without using a vision fallback."],
        {
          env: {
            HOME: home,
            OPENAI_API_KEY: "gateway-vision-sentinel",
            Y2_DISABLE_KEYCHAIN: "1",
            Y2_AUTO_UPGRADE: "0",
            OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
            Y2_E2E_OPENAI_CODEX_RESPONSES_URL: codex.responsesUrl,
            Y2_E2E_OPENAI_CODEX_MODELS_URL: codex.modelsUrl,
          },
          timeoutMs: TIMEOUT,
        },
      );
      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("CODEX_VISION_DISABLED_OK");
      expect(codex.bodies).toHaveLength(2);
      expect(codex.bodies[0]).not.toContain('"name":"vision"');
      const continuation = JSON.parse(codex.bodies[1]) as {
        input: Array<{ type?: string; output?: string }>;
      };
      const toolResult = continuation.input.find(
        (item) => item.type === "function_call_output",
      );
      expect(toolResult?.output).toContain("Vision is unavailable for this request.");
      expect(toolResult?.output).toContain("native image input");
      for (const request of [...gateway.requests, ...gateway.modelRequests]) {
        expect(request.headers.get("authorization")).not.toBe(`Bearer ${codex.accessToken}`);
      }
    } finally {
      codex.stop();
    }
  },
  60_000,
);

test(
  "Grok rejects the vision fallback because native image input owns OCR",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-vision-disabled-"));
    gateway = startFakeGateway([]);
    const grok = startFakeGrokToolLoop({
      toolName: "vision",
      toolArguments: { image_ids: [1], focus: "Inspect the image." },
      finalText: "GROK_VISION_DISABLED_OK",
    });
    try {
      writeSeededGrokLogin(home, grok.accessToken, "acct_vision");
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
        { mode: 0o600 },
      );
      const result = await runY2(
        ["ask", "--json", "--auto", "--no-save", "Answer without a vision fallback."],
        {
          env: {
            HOME: home,
            OPENAI_API_KEY: "gateway-grok-vision-sentinel",
            Y2_DISABLE_KEYCHAIN: "1",
            Y2_AUTO_UPGRADE: "0",
            OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
            Y2_E2E_XAI_GROK_RESPONSES_URL: grok.responsesUrl,
            Y2_E2E_XAI_GROK_MODELS_URL: grok.modelsUrl,
            Y2_E2E_XAI_GROK_MODALITIES_URL: grok.modalitiesUrl,
          },
          timeoutMs: TIMEOUT,
        },
      );
      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("GROK_VISION_DISABLED_OK");
      expect(grok.bodies).toHaveLength(2);
      expect(grok.bodies[0]).not.toContain('"name":"vision"');
      const continuation = JSON.parse(grok.bodies[1]) as {
        input: Array<{ type?: string; output?: string }>;
      };
      const toolResult = continuation.input.find((item) => item.type === "function_call_output");
      expect(toolResult?.output).toContain("Vision is unavailable for this request.");
      expect(gateway.requests).toHaveLength(0);
    } finally {
      grok.stop();
    }
  },
  60_000,
);

test(
  "Codex automatic review uses gpt-5.4-mini while Gateway review stays untouched",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-codex-auto-review-"));
    gateway = startFakeGateway([]);
    const codex = startFakeCodexAutoReview();
    try {
      writeSeededChatGptLogin(home, codex.accessToken);
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "codex", codex_model: "gpt-5.6-sol" }) + "\n",
        { mode: 0o600 },
      );
      const result = await runY2(
        ["ask", "--json", "--auto", "Run pwd, then finish."],
        {
          env: {
            HOME: home,
            OPENAI_API_KEY: "gateway-auto-review-sentinel",
            Y2_DISABLE_KEYCHAIN: "1",
            Y2_AUTO_UPGRADE: "0",
            OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
            Y2_E2E_OPENAI_CODEX_RESPONSES_URL: codex.responsesUrl,
            Y2_E2E_OPENAI_CODEX_MODELS_URL: codex.modelsUrl,
          },
          timeoutMs: TIMEOUT,
        },
      );
      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("CODEX_AUTO_REVIEW_OK");
      expect(codex.bodies.map((body) => (JSON.parse(body) as { model: string }).model))
        .toEqual(["gpt-5.6-sol", "gpt-5.4-mini", "gpt-5.6-sol"]);
      expect(codex.bodies[1]).toContain('"name":"permission_decision"');
      expect(codex.bodies[2]).toContain('"type":"function_call_output"');
      expect(codex.bodies[2]).toContain("exit_code=0");
      for (const request of gateway.requests) {
        expect(request.body).not.toContain("permission_decision");
      }
      expect(readSingleUsageSnapshot(home)).toMatchObject({
        billing: "complete",
        api_duration_complete: true,
        next_sequence: 1,
        settled_through_sequence: 0,
        pending: [],
      });
    } finally {
      codex.stop();
    }
  },
  60_000,
);

test(
  "Grok automatic review reuses the admitted Grok model and never reaches Gateway",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-grok-auto-review-"));
    gateway = startFakeGateway([]);
    const grok = startFakeGrokAutoReview();
    try {
      writeSeededGrokLogin(home, grok.accessToken, "acct_auto_review");
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
        { mode: 0o600 },
      );
      const result = await runY2(
        ["ask", "--json", "--auto", "Run pwd, then finish."],
        {
          env: {
            HOME: home,
            OPENAI_API_KEY: "gateway-grok-auto-review-sentinel",
            Y2_DISABLE_KEYCHAIN: "1",
            Y2_AUTO_UPGRADE: "0",
            OPENAI_BASE_URL: `${gateway.baseUrl}/v1`,
            Y2_E2E_XAI_GROK_RESPONSES_URL: grok.responsesUrl,
            Y2_E2E_XAI_GROK_MODELS_URL: grok.modelsUrl,
            Y2_E2E_XAI_GROK_MODALITIES_URL: grok.modalitiesUrl,
          },
          timeoutMs: TIMEOUT,
        },
      );
      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("GROK_AUTO_REVIEW_OK");
      expect(grok.bodies.map((body) => (JSON.parse(body) as { model: string }).model))
        .toEqual(["grok-4.20", "grok-4.20", "grok-4.20"]);
      expect(grok.bodies[1]).toContain('"name":"permission_decision"');
      expect(grok.bodies[2]).toContain('"type":"function_call_output"');
      expect(grok.bodies[2]).toContain("exit_code=0");
      expect(grok.headers).toHaveLength(3);
      for (const headers of grok.headers) {
        expect(headers.tokenAuth).toBe("xai-grok-cli");
        expect(headers.authenticateResponse).toBe("authenticate-response");
        expect(headers.clientIdentifier).toBe("y2");
        expect(headers.clientVersion).toBe("1.0.6");
        expect(headers.modelOverride).toBe("grok-4.20");
        expect(headers.grokUserId).toBe("acct_auto_review");
      }
      for (const request of gateway.requests) {
        expect(request.body).not.toContain("permission_decision");
      }
      expect(readSingleUsageSnapshot(home)).toMatchObject({
        billing: "complete",
        api_duration_complete: true,
        next_sequence: 1,
        settled_through_sequence: 0,
        pending: [],
      });
    } finally {
      grok.stop();
    }
  },
  60_000,
);



tmuxTest(
  "missing auth after deferred onboarding preserves the complete prompt",
  async () => {
    home = mkdtempSync(join(tmpdir(), "y2-tui-auth-preflight-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    const imagePath = join(home, "attachment.png");
    writeFileSync(imagePath, Buffer.from("89504e470d0a1a0a72657374", "hex"));
    gateway = startFakeGateway([], {
      models: [{
        id: FAKE_GATEWAY_MODEL,
        tags: ["vision", "file-input", "tool-use"],
      }],
    });

    session = await startY2WithoutAuth(home, stderrPath, gateway);
    const initial = await session.waitForComposer(TIMEOUT);
    expect(initial).not.toContain("Sign in with Y2");
    expect(initial).not.toContain("Switch credential");

    await session.sendText(`/image ${imagePath}`);
    await session.waitForText("attached image: attachment.png", TIMEOUT);
    await session.sendText(" preserve this exact prompt");
    const blocked = await session.waitForPane(
      (pane) =>
        pane.includes("Y2 Information Dominance needs an API key") &&
        pane.includes("preserve this exact prompt") &&
        pane.includes("Image 1"),
      TIMEOUT,
    );
    expect(blocked).not.toContain("Welcome to y2");
    expect(blocked).not.toContain("Switch credential");
    expect(gateway.requests).toHaveLength(0);
    expect(session.isAlive()).toBe(true);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);
