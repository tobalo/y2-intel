import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Y2_BIN, REPO_ROOT, runY2 } from "../evals/eval-helpers";
import {
  fakeGatewaySse,
  hasEmptyComposer,
  normalizedOpenAiPromptParts,
  startFakeGateway as startOpenAiEndpoint,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 15_000;
const DIRECT_MODEL = "provider/direct-image-model";
const IMAGE_PATH = join(REPO_ROOT, "tests/e2e/fixtures/placeholder-logo.png");

function sseText(value: string) {
  return fakeGatewaySse([
    { type: "text-delta", id: "answer_1", delta: value },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 11 },
        outputTokens: { total: 13 },
      },
    },
  ]);
}

function createIsolatedRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "y2-openai-images-e2e-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".y2"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, ".y2", "settings.json"),
    JSON.stringify({ permission: {} }),
  );
  return { root, home, workspace: realpathSync(workspace) };
}

function directEndpointEnv(
  root: ReturnType<typeof createIsolatedRoot>,
  endpoint: ReturnType<typeof startOpenAiEndpoint>,
) {
  return {
    HOME: root.home,
    Y2_API_KEY: undefined,
    Y2_API_CHAT_URL: undefined,
    OPENAI_API_KEY: "direct-endpoint-key",
    OPENAI_BASE_URL: `${endpoint.baseUrl}/v1`,
    Y2_MODEL: DIRECT_MODEL,
  };
}

function parseSuccess(result: Awaited<ReturnType<typeof runY2>>) {
  if (result.code !== 0) {
    throw new Error(
      `y2 exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim()) as {
    output: string;
    exit_code: number;
    model: string;
  };
}

function requestImageUrls(body: string): string[] {
  return normalizedOpenAiPromptParts(body).flatMap((part) => {
    if (part.type !== "image_url" || !part.image_url || typeof part.image_url !== "object") {
      return [];
    }
    const url = (part.image_url as { url?: unknown }).url;
    return typeof url === "string" ? [url] : [];
  });
}

describe("direct OpenAI-compatible image transport", () => {
  test(
    "missing images fail locally before endpoint startup",
    async () => {
      const root = createIsolatedRoot();
      const endpoint = startOpenAiEndpoint([]);
      const missingPath = join(root.workspace, "missing-image.png");
      try {
        const textResult = await runY2(
          ["ask", "--no-save", "--image", missingPath, "Describe the image."],
          {
            cwd: root.workspace,
            env: directEndpointEnv(root, endpoint),
            timeoutMs: TIMEOUT,
          },
        );
        expect(textResult.code).toBe(1);
        expect(textResult.stdout).toBe("");
        expect(textResult.stderr).toContain(missingPath);
        expect(textResult.stderr).toContain("image file not found");

        const jsonResult = await runY2(
          ["ask", "--json", "--no-save", "--image", missingPath, "Describe the image."],
          {
            cwd: root.workspace,
            env: directEndpointEnv(root, endpoint),
            timeoutMs: TIMEOUT,
          },
        );
        expect(jsonResult.code).toBe(1);
        const json = JSON.parse(jsonResult.stdout.trim()) as {
          output: string;
          error: string;
        };
        expect(json.output).toBe("");
        expect(json.error).toContain("FileNotFound");
        expect(json.error).toContain(missingPath);
        expect(jsonResult.stderr).toBe("");
        expect(endpoint.modelRequests).toHaveLength(0);
        expect(endpoint.requests).toHaveLength(0);
      } finally {
        endpoint.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "oversized images fail locally before endpoint startup",
    async () => {
      const root = createIsolatedRoot();
      const endpoint = startOpenAiEndpoint([]);
      const oversizedPath = join(root.workspace, "oversized.png");
      writeFileSync(oversizedPath, Buffer.from("\x89PNG\r\n\x1a\n"));
      truncateSync(oversizedPath, 20 * 1024 * 1024 + 1);
      try {
        const result = await runY2(
          ["ask", "--no-save", "--image", oversizedPath, "Describe the image."],
          {
            cwd: root.workspace,
            env: directEndpointEnv(root, endpoint),
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("image exceeds the 20 MiB limit");
        expect(endpoint.modelRequests).toHaveLength(0);
        expect(endpoint.requests).toHaveLength(0);
      } finally {
        endpoint.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 ask sends native image content to a standard Chat Completions endpoint",
    async () => {
      const root = createIsolatedRoot();
      const imagePath = join(root.workspace, "fixture.png");
      copyFileSync(IMAGE_PATH, imagePath);
      const endpoint = startOpenAiEndpoint(
        [sseText("Direct endpoint image answer")],
        {
          models: [{
            id: DIRECT_MODEL,
            object: "model",
            created: 1,
            owned_by: "test",
          }],
        },
      );
      try {
        const result = await runY2(
          [
            "ask",
            "--json",
            "--no-save",
            "--no-color",
            "--image",
            imagePath,
            "Describe the attached image.",
          ],
          {
            cwd: root.workspace,
            env: directEndpointEnv(root, endpoint),
            timeoutMs: TIMEOUT,
          },
        );

        const json = parseSuccess(result);
        expect(json.exit_code).toBe(0);
        expect(json.model).toBe(DIRECT_MODEL);
        expect(json.output).toContain("Direct endpoint image answer");
        expect(result.stderr).toBe("");
        expect(endpoint.modelRequests).toHaveLength(1);
        expect(endpoint.modelRequests[0]!.headers.get("authorization")).toBe(
          "Bearer direct-endpoint-key",
        );
        expect(endpoint.requests).toHaveLength(1);
        expect(endpoint.requests[0]!.headers.get("authorization")).toBe(
          "Bearer direct-endpoint-key",
        );
        const body = endpoint.requests[0]!.body;
        const parsed = JSON.parse(body) as { model?: string; stream?: boolean };
        expect(parsed.model).toBe(DIRECT_MODEL);
        expect(parsed.stream).toBe(true);
        const imageUrls = requestImageUrls(body);
        expect(imageUrls).toHaveLength(1);
        expect(imageUrls[0]).toStartWith("data:image/png;base64,");
        expect(body).not.toContain(imagePath);
      } finally {
        endpoint.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "the TUI attaches an image and completes a direct endpoint turn",
    async () => {
      const root = createIsolatedRoot();
      const imagePath = join(root.workspace, "fixture.png");
      copyFileSync(IMAGE_PATH, imagePath);
      const endpoint = startOpenAiEndpoint(
        [sseText("TUI direct image answer")],
        {
          models: [{
            id: DIRECT_MODEL,
            object: "model",
            created: 1,
            owned_by: "test",
          }],
        },
      );
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");
      let session: TmuxSession | null = null;
      try {
        session = await TmuxSession.create({
          cmd: Y2_BIN,
          cwd: root.workspace,
          env: {
            ...directEndpointEnv(root, endpoint),
            Y2_AUTO_UPGRADE: "0",
            NO_COLOR: "1",
          },
          stderrPath,
          width: 120,
          height: 40,
        });
        await session.waitForPane(hasEmptyComposer, TIMEOUT);
        await session.sendText(`/image ${imagePath}`);
        await session.waitForText("attached image: fixture.png", TIMEOUT);
        await session.sendText("Describe the attached image.");
        await session.waitForText("TUI direct image answer", TIMEOUT);
        await session.waitForPane(hasEmptyComposer, TIMEOUT);

        expect(endpoint.requests).toHaveLength(1);
        expect(requestImageUrls(endpoint.requests[0]!.body)).toHaveLength(1);
        expect(endpoint.requests[0]!.body).not.toContain(imagePath);
        expect(readFileSync(stderrPath, "utf8")).toBe("");

        await session.sendText("/quit");
        expect(await session.waitForSessionEnd(TIMEOUT)).toBe(true);
        session = null;
      } finally {
        if (session) await session.kill();
        endpoint.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
