import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runY2 } from "../evals/eval-helpers";
import {
  FAKE_GATEWAY_MODEL,
  fakeGatewayFinalText,
  fakeGatewayToolCall,
  startFakeGateway,
  type FakeGatewayResponse,
} from "./tmux-helpers";

const TIMEOUT = 120_000;
const CONFIGURED_SANDBOX = process.platform === "darwin" ? "os" : "none";

type Y2Json = {
  output: string;
  exit_code: number;
  tool_calls: Array<{ name: string; status: string }>;
};

function createIsolatedRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  mkdirSync(join(home, ".y2"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(external, { recursive: true });
  return {
    root,
    home,
    workspace: realpathSync(workspace),
    external: realpathSync(external),
  };
}

function parseY2Json(result: { stdout: string; stderr: string; code: number | null }): Y2Json {
  if (result.code !== 0) {
    throw new Error(`y2 exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as Y2Json;
}

async function runWithFakeGateway(
  root: ReturnType<typeof createIsolatedRoot>,
  args: string[],
  responses: FakeGatewayResponse[],
  env: Record<string, string> = {},
) {
  const gateway = startFakeGateway(responses);
  try {
    const result = await runY2(args, {
      cwd: root.workspace,
      env: {
        HOME: root.home,
        OPENAI_API_KEY: "fake-file-permission-key",
        ...env,
        OPENAI_BASE_URL: gateway.baseUrl,
        Y2_API_CHAT_URL: gateway.chatUrl,
        Y2_E2E_GATEWAY_MODELS_URL: `${gateway.baseUrl}/v1/models`,
        Y2_E2E_GATEWAY_CREDITS_URL: undefined,
        Y2_MODEL: FAKE_GATEWAY_MODEL,
        Y2_AUTO_UPGRADE: "0",
      },
      timeoutMs: TIMEOUT,
    });
    return { gateway, result };
  } finally {
    gateway.stop();
  }
}

describe("external file permissions", () => {
  test(
    "y2 ask --yolo bypasses a configured write denial without a classifier request",
    async () => {
      const root = createIsolatedRoot("y2-yolo-permissions-");
      try {
        const target = join(root.external, "yolo-write.txt");
        const tracePath = join(root.root, "permission-trace.log");
        const settingsPath = join(root.home, ".y2", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            permission_mode: "ask",
            sandbox: CONFIGURED_SANDBOX,
            yolo_acknowledged: false,
            permission: { edit: "deny" },
          }) + "\n",
        );

        const { gateway, result } = await runWithFakeGateway(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--yolo",
            `Use only the write_file tool to create ${target} with exactly this content: Y2_E2E_YOLO.`,
          ],
          [
            fakeGatewayToolCall("yolo_write_1", "write_file", {
              path: target,
              content: "Y2_E2E_YOLO",
            }),
            fakeGatewayFinalText("yolo write complete"),
          ],
          {
            Y2_TRACE_LOG: tracePath,
            Y2_TRACE_SCOPES: "permission",
          },
        );

        expect(result.stderr).toContain(
          "YOLO enabled: y2 permission checks disabled",
        );
        const output = parseY2Json(result);
        expect(
          output.tool_calls.some(
            (call) => call.name === "write_file" && call.status === "success",
          ),
        ).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("Y2_E2E_YOLO");
        const trace = readFileSync(tracePath, "utf8");
        expect(trace).not.toContain("event=auto_review_start");
        expect(gateway.classifierRequests).toHaveLength(0);
        expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
          permission_mode: "ask",
          sandbox: CONFIGURED_SANDBOX,
          yolo_acknowledged: true,
        });
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 ask reads external paths and exercises classifier and rule-gated writes",
    async () => {
      const root = createIsolatedRoot("y2-file-permissions-");
      try {
        const readTarget = join(root.external, "read-fixture.txt");
        const classifiedTarget = join(root.external, "classified-write.txt");
        const allowedTarget = join(root.external, "allowed-write.txt");
        const tracePath = join(root.root, "permission-trace.log");
        writeFileSync(readTarget, "Y2_E2E_EXTERNAL_READ\n");
        writeFileSync(classifiedTarget, "before");
        writeFileSync(join(root.home, ".y2", "settings.json"), "{}");

        const { result: readResult } = await runWithFakeGateway(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--auto",
            `Use only the read_file tool to read ${readTarget}, then reply with exactly the file content and nothing else.`,
          ],
          [
            fakeGatewayToolCall("external_read_1", "read_file", { path: readTarget }),
            fakeGatewayFinalText("Y2_E2E_EXTERNAL_READ"),
          ],
        );
        const read = parseY2Json(readResult);
        expect(read.tool_calls).toContainEqual({ name: "read_file", status: "success" });
        expect(read.output).toContain("Y2_E2E_EXTERNAL_READ");

        const { gateway: classifiedGateway, result: classifiedResult } =
          await runWithFakeGateway(
            root,
            [
              "ask",
              "--json",
              "--no-save",
              "--auto",
              `Use only the write_file tool to overwrite ${classifiedTarget} with exactly this content: Y2_E2E_EXTERNAL_CLASSIFIED.`,
            ],
            [
              fakeGatewayToolCall("classified_write_1", "write_file", {
                path: classifiedTarget,
                content: "Y2_E2E_EXTERNAL_CLASSIFIED",
              }),
              fakeGatewayFinalText("classified write complete"),
            ],
            {
              Y2_TRACE_LOG: tracePath,
              Y2_TRACE_SCOPES: "permission",
            },
          );
        const trace = readFileSync(tracePath, "utf-8");
        expect(trace.match(/event=auto_review_start/g)).toHaveLength(1);
        expect(trace.match(/event=auto_review_result/g)).toHaveLength(1);
        expect(trace).toContain("event=auto_review_result tool_name=write_file decision=clear");
        expect(classifiedGateway.classifierRequests).toHaveLength(1);
        const classified = parseY2Json(classifiedResult);
        expect(classified.tool_calls).toContainEqual({ name: "write_file", status: "success" });
        expect(readFileSync(classifiedTarget, "utf-8")).toBe("Y2_E2E_EXTERNAL_CLASSIFIED");

        writeFileSync(
          join(root.home, ".y2", "settings.json"),
          JSON.stringify({
            permission: {
              edit: {
                [`${root.external}/**`]: "allow",
              },
            },
          }),
        );

        const { gateway: allowedGateway, result: allowedResult } = await runWithFakeGateway(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--auto",
            `Use only the write_file tool to create ${allowedTarget} with exactly this content: Y2_E2E_EXTERNAL_ALLOWED.`,
          ],
          [
            fakeGatewayToolCall("allowed_write_1", "write_file", {
              path: allowedTarget,
              content: "Y2_E2E_EXTERNAL_ALLOWED",
            }),
            fakeGatewayFinalText("allowed write complete"),
          ],
        );
        const allowed = parseY2Json(allowedResult);
        expect(allowed.tool_calls).toContainEqual({ name: "write_file", status: "success" });
        expect(readFileSync(allowedTarget, "utf-8")).toBe("Y2_E2E_EXTERNAL_ALLOWED");
        expect(allowedGateway.classifierRequests).toHaveLength(0);
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
