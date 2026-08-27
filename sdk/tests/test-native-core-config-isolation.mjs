#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createY2Agent } from "../node.js";

const marker = "LIBY2_EXPLICIT_WORKSPACE_CONTEXT";
const originalCwd = process.cwd();
const processWorkspace = await mkdtemp(join(tmpdir(), "liby2-process-workspace-"));
const runtimeHome = await mkdtemp(join(tmpdir(), "liby2-runtime-home-"));
const runtimeWorkspace = await mkdtemp(join(tmpdir(), "liby2-runtime-workspace-"));
await writeFile(join(processWorkspace, ".y2.json"), `${JSON.stringify({ context: false })}\n`);
await writeFile(join(runtimeWorkspace, ".y2.json"), `${JSON.stringify({ context: true })}\n`);
await writeFile(join(runtimeWorkspace, "AGENTS.md"), `# Context\n\n${marker}\n`);

let requestBody = "";
const server = createServer((request, response) => {
  request.setEncoding("utf8");
  request.on("data", (chunk) => { requestBody += chunk; });
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chat_isolation","choices":[{"index":0,"delta":{"content":"isolated"},"finish_reason":null}]}\n\n');
    response.write('data: {"id":"chat_isolation","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
    response.end("data: [DONE]\n\n");
  });
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const { port } = server.address();
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addon = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/liby2.node"));

try {
  process.chdir(processWorkspace);
  const agent = await createY2Agent({
    nativeAddon: addon,
    backend: "native",
    home: runtimeHome,
    workspaceRoot: runtimeWorkspace,
    env: {
      OPENAI_API_KEY: "native-core-config-key",
      Y2_API_CHAT_URL: `http://127.0.0.1:${port}/chat`,
      Y2_MODEL: "native/test-model",
    },
  });
  const session = await agent.createSession();
  const turn = session.prompt("read the explicit workspace context");
  await turn.result;
  assert.match(requestBody, new RegExp(marker), "native startup must load context policy from workspaceRoot, not process.cwd()" );
  await session.close();
  assert.equal(await agent.close(), 0);
  console.log("native config isolation passed: explicit home and workspace own startup state");
} finally {
  process.chdir(originalCwd);
  server.closeAllConnections();
  server.close();
  await Promise.all([
    rm(processWorkspace, { recursive: true, force: true }),
    rm(runtimeHome, { recursive: true, force: true }),
    rm(runtimeWorkspace, { recursive: true, force: true }),
  ]);
}
