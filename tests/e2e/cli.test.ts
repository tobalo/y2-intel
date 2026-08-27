import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  cleanupIsolatedTestHome,
  createIsolatedTestHome,
  Y2_BIN,
  HAS_API_KEY,
  REPO_ROOT,
  runY2,
} from "../evals/eval-helpers";
import {
  FAKE_GATEWAY_MODEL,
  fakeGatewayFinalText,
  startFakeGateway,
} from "./tmux-helpers";

const TIMEOUT = 15_000;
const NO_API_AUTH = {
  Y2_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
};
const MISSING_AUTH_MESSAGE =
  "Y2 Information Dominance needs an API key. Run y2 setup or set Y2_API_KEY. For another OpenAI-compatible endpoint, set OPENAI_API_KEY and OPENAI_BASE_URL.";

const KEYCHAIN_SERVICE = "Y2_API_KEY";

function maxLineWidth(text: string): number {
  return Math.max(...text.split(/\r?\n/).map((line) => Bun.stringWidth(line)));
}

function sourceVersion(): string {
  const source = readFileSync(join(REPO_ROOT, "src/main.zig"), "utf8");
  const match = source.match(/pub const version = "([^"]+)";/);
  if (!match) throw new Error("src/main.zig version declaration not found");
  return match[1];
}

function doctorSessionDiagnosticsLimit(): number {
  const source = readFileSync(
    join(REPO_ROOT, "src/core/cli/doctor_runtime.zig"),
    "utf8",
  );
  const match = source.match(/const default_session_diagnostics_limit: usize = (\d+);/);
  if (!match) throw new Error("doctor session diagnostics limit not found");
  return Number(match[1]);
}

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (path: string, relative: string): void => {
    const info = lstatSync(path);
    entries.push(
      `${relative}|${info.isDirectory() ? "dir" : "file"}|${info.mode & 0o777}|${info.size}`,
    );
    if (!info.isDirectory()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relative ? join(relative, name) : name);
    }
  };
  visit(root, "");
  return entries;
}

function writeLegacySession(
  home: string,
  workspaceRoot: string,
  sessionId: string,
  opts: {
    createdAtMs?: number;
    updatedAtMs?: number;
    historyLen?: number;
  } = {},
): void {
  const sessionDir = join(home, ".y2", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".y2"), 0o700);
  chmodSync(join(home, ".y2", "sessions"), 0o700);
  chmodSync(sessionDir, 0o700);
  const historyLen = opts.historyLen ?? 0;
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 2,
      id: sessionId,
      created_at_ms: opts.createdAtMs ?? 1,
      updated_at_ms: opts.updatedAtMs ?? 2,
      workspace_root: workspaceRoot,
      conversation_language: "en",
      history_len: historyLen,
      history: historyLen > 0 ? [{ role: "user", content: "saved" }] : [],
      total_input_tokens: 0,
      total_output_tokens: 0,
    }) + "\n",
    { mode: 0o600 },
  );
}

describe("cli: help", () => {
  test(
    "y2 help exits 0 and renders the complete navigation page",
    async () => {
      const r = await runY2(["help"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).not.toContain("\x1b[");
      expect(r.stdout).not.toContain("\x1b]2;");
      expect(r.stdout).toStartWith(
        `Y2 INFORMATION DOMINANCE v${sourceVersion()}\nNative agentic intelligence harness for the terminal.\n`,
      );
      expect(r.stdout).toContain("Commands:\n");
      expect(r.stdout).toContain("Run one noninteractive request");
      expect(r.stdout).not.toContain("credits|balance");
      expect(r.stdout).toContain("Flags:\n");
      expect(r.stdout).toContain("--context-limit <spec>");
      expect(r.stdout).toContain("Set name=bytes|off; repeatable");
      expect(r.stdout).toContain("--add-dir <path>");
      expect(r.stdout).toContain("-c, --continue");
      expect(r.stdout).toContain("-r");
      expect(r.stdout).toContain("Open the saved-session picker");
      expect(r.stdout).not.toContain("-c, -r, --continue");
      expect(r.stdout).toContain("--resume [last|<id>]");
      expect(r.stdout).toContain("--resume-last");
      expect(r.stdout).toContain("session resume [last|id]");
      expect(r.stdout).toContain("-v, --version");
      expect(r.stdout).not.toContain("Must appear before the command");
      expect(r.stdout).toContain("Examples:\n");
      expect(r.stdout).toContain("https://y2.dev/docs/api/");
      expect(r.stdout).toContain("run `/feedback` inside the harness");
      expect(r.stdout).not.toContain("  Work      ");
      expect(r.stdout).not.toContain("\n\n\nRun `y2 <command> --help`");
    },
    TIMEOUT,
  );

  test(
    "y2 --help exits 0",
    async () => {
      const r = await runY2(["--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("ask");
    },
    TIMEOUT,
  );

  test(
    "y2 -h exits 0",
    async () => {
      const r = await runY2(["-h"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("ask");
    },
    TIMEOUT,
  );

  test(
    "y2 ask help renders documented options through both aliases",
    async () => {
      const env = {
        ...NO_API_AUTH,
        Y2_DISABLE_KEYCHAIN: "1",
      };
      const expected = `y2 ask

Run one noninteractive request

Usage:
  y2 ask [--auto|--yolo] [--image PATH] [--json] [--quiet] [--prompt-permissions] [--no-save] [--no-color] [--resume <last|id>|--resume-id <id>] [--continue-recovery] [--] <prompt>

Options:
  --auto                Automatically review unresolved permission requests
  --yolo                Disable y2 permission checks
  --image PATH          Attach an image file; repeat for multiple images
  --json                Emit machine-readable JSON instead of text
  --quiet               Suppress assistant output
  --prompt-permissions  Prompt for Y/N permission approval when stdin is a TTY
  --no-save             Do not save the session; incompatible with --resume and --resume-id
  --no-color            Render TTY output without colors or hyperlinks
  --resume <last|id>    Continue the last session or a session by id
  --resume-id <id>      Continue a session by exact id
  --continue-recovery   Resume the paused model response in the selected session
  --                    Treat every following argument as prompt text

The prompt may be passed as arguments or piped on stdin when no prompt args are given.
TTY stdout uses the Minimal transcript presentation; redirected stdout emits raw assistant Markdown.
Operational progress and diagnostics are written to stderr. JSON output keeps raw Markdown in \`output\`.
With --prompt-permissions, JSON and quiet requests may prompt on stderr only when stdin is a TTY.
`;

      for (const alias of ["--help", "-h"]) {
        const result = await runY2(["ask", alias], { env });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(expected);
      }
    },
    TIMEOUT,
  );

  test(
    "y2 session help documents inspect resume migrate and recover",
    async () => {
      for (const args of [
        ["session", "--help"],
        ["session", "resume", "--help"],
      ]) {
        const r = await runY2(args);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Inspect, resume, migrate, or recover saved sessions");
        expect(r.stdout).toContain("session <last|id>|--id <id>");
        expect(r.stdout).toContain("session resume [last|<id>]");
        expect(r.stdout).toContain("session migrate <id>|--id <id>");
        expect(r.stdout).toContain("session recover <id>|--id <id>");
      }
    },
    TIMEOUT,
  );

  test(
    "y2 acp help documents accepted options",
    async () => {
      for (const alias of ["--help", "-h"]) {
        const r = await runY2(["acp", alias]);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain(
          "Usage:\n  y2 acp [--model <id>] [--log-file <path>]",
        );
        expect(r.stdout).toContain("--model <id>");
        expect(r.stdout).toContain("--log-file <path>");
      }
    },
    TIMEOUT,
  );

  test(
    "y2 replay help describes golden output",
    async () => {
      const r = await runY2(["replay", "--help"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("--golden <path>");
      expect(r.stdout).toContain("Write the final rendered grid to a file");
      expect(r.stdout).not.toContain("Compare output against a golden file");
    },
    TIMEOUT,
  );

  test(
    "y2 acp rejects unknown options and missing option values",
    async () => {
      for (const args of [["--bogus"], ["--model"], ["--log-file"]]) {
        const result = await runY2(["acp", ...args]);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "usage: y2 acp [--model <id>] [--log-file <path>]\n",
        );
      }
    },
    TIMEOUT,
  );

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `y2 ${alias} respects COLUMNS=60`,
      async () => {
        const r = await runY2([alias], { env: { COLUMNS: "60" } });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Commands:");
        expect(r.stdout).toContain("ask");
        expect(r.stdout).toContain("setup");
        expect(r.stdout).toContain("status");
        expect(r.stdout).toContain("doctor");
        expect(maxLineWidth(r.stdout)).toBeLessThanOrEqual(60);
      },
      TIMEOUT,
    );
  }

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `y2 ${alias} --record rejects the interactive-only modifier`,
      async () => {
        const r = await runY2([alias, "--record"]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(
          "usage: y2 --record is only supported for interactive startup",
        );
      },
      TIMEOUT,
    );
  }
});

describe("cli: version", () => {
  for (const alias of ["--version", "-v"]) {
    test(
      `y2 ${alias} prints the source version`,
      async () => {
        const r = await runY2([alias]);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(`${sourceVersion()}\n`);
        expect(r.stderr).toBe("");
      },
      TIMEOUT,
    );
  }
});

describe("cli: status", () => {
  test(
    "status and doctor expose the MCP profile error that blocks ask startup",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-mcp-config-diagnostic-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const y2Dir = join(home, ".y2");
      mkdirSync(y2Dir, { recursive: true, mode: 0o700 });
      mkdirSync(workspace);
      writeFileSync(join(y2Dir, "mcp.json"), "{invalid json", { mode: 0o600 });
      const gateway = startFakeGateway([]);

      try {
        const env = {
          HOME: realpathSync(home),
          OPENAI_API_KEY: "mcp-config-diagnostic-key",
          Y2_DISABLE_KEYCHAIN: "1",
          Y2_AUTO_UPGRADE: "0",
          Y2_MODEL: FAKE_GATEWAY_MODEL,
          Y2_API_CHAT_URL: gateway.chatUrl,
        };
        const cwd = realpathSync(workspace);
        const before = snapshotTree(home);

        const statusText = await runY2(["status"], { cwd, env });
        const statusJsonResult = await runY2(["status", "--json"], { cwd, env });
        const doctorText = await runY2(["doctor"], { cwd, env });
        const doctorJsonResult = await runY2(["doctor", "--json"], { cwd, env });
        const ask = await runY2(
          ["ask", "--json", "--no-save", "Do nothing."],
          { cwd, env },
        );

        for (const result of [statusText, statusJsonResult, doctorText, doctorJsonResult]) {
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
        }
        expect(statusText.stdout).toContain(
          "[status] mcp_config_error=McpConfigInvalidJson\n",
        );
        expect(JSON.parse(statusJsonResult.stdout)).toMatchObject({
          kind: "status",
          mcp_config_error: "McpConfigInvalidJson",
        });
        expect(doctorText.stdout).toContain(
          "[fail] mcp_config: failed to load ~/.y2/mcp.json: McpConfigInvalidJson\n",
        );
        const doctorJson = JSON.parse(doctorJsonResult.stdout);
        expect(doctorJson.fail_count).toBe(1);
        expect(
          doctorJson.checks.filter(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toEqual([
          {
            name: "mcp_config",
            status: "fail",
            detail: "failed to load ~/.y2/mcp.json: McpConfigInvalidJson",
          },
        ]);
        expect(ask.code).toBe(1);
        expect(ask.stderr).toBe("");
        expect(JSON.parse(ask.stdout)).toMatchObject({
          exit_code: 1,
          error: "McpConfigInvalidJson",
        });
        expect(gateway.requestCount()).toBe(0);
        expect(snapshotTree(home)).toEqual(before);

        writeFileSync(join(y2Dir, "mcp.json"), '{"mcp":{}}\n', { mode: 0o600 });
        const validBefore = snapshotTree(home);
        const validStatus = await runY2(["status", "--json"], { cwd, env });
        const validDoctor = await runY2(["doctor", "--json"], { cwd, env });
        expect(validStatus.code).toBe(0);
        expect(validDoctor.code).toBe(0);
        expect(JSON.parse(validStatus.stdout)).not.toHaveProperty("mcp_config_error");
        expect(
          JSON.parse(validDoctor.stdout).checks.some(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toBe(false);
        expect(gateway.requestCount()).toBe(0);
        expect(snapshotTree(home)).toEqual(validBefore);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor share the missing auth snapshot",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-status-noauth-"));
      try {
        const env = {
          ...NO_API_AUTH,
          HOME: realpathSync(root),
          Y2_DISABLE_KEYCHAIN: "1",
        };
        const status = await runY2(["status", "--json"], { env });
        const doctor = await runY2(["doctor", "--json"], { env });

        expect(status.code).toBe(0);
        expect(doctor.code).toBe(0);
        const statusJson = JSON.parse(status.stdout.trim());
        const doctorJson = JSON.parse(doctor.stdout.trim());
        expect(statusJson).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
          auth_help: MISSING_AUTH_MESSAGE,
        });
        expect(statusJson).not.toHaveProperty("sandbox");
        expect(doctorJson).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
        });
        expect(doctorJson.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );


  test(
    "status reports an active Y2 API key without exposing it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-status-precedence-"));
      try {
        const envToken = "preferred-environment-token";
        const env = {
          HOME: realpathSync(root),
          OPENAI_API_KEY: undefined,
          Y2_API_KEY: envToken,
          Y2_DISABLE_KEYCHAIN: "1",
        };

        const status = await runY2(["status", "--json"], { env });
        const doctor = await runY2(["doctor", "--json"], { env });

        const expectedAuth = {
          auth: "API key",
          auth_refreshable: false,
        };
        expect(JSON.parse(status.stdout.trim())).toMatchObject(expectedAuth);
        expect(JSON.parse(doctor.stdout.trim())).toMatchObject(expectedAuth);
        expect(status.stdout).not.toContain(envToken);
        expect(doctor.stdout).not.toContain(envToken);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 status --json returns valid status JSON",
    async () => {
      const r = await runY2(["status", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("status");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("workspace");
      expect(json).toHaveProperty("permission_mode");
      expect(json).toHaveProperty("history_turns");
      expect(json).toHaveProperty("agent_step_limit");
      expect(json.update_channel).toBe("stable");
      expect(json.build_channel).toBe("stable");
      expect(json.build_revision).toMatch(/^[0-9a-f]{12}$/);
    },
    TIMEOUT,
  );

  test(
    "y2 status reports a persisted dev update channel",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-update-channel-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".y2"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(
          join(home, ".y2", "settings.json"),
          '{"update_channel":"dev"}\n',
          { mode: 0o600 },
        );

        const result = await runY2(["status", "--json"], {
          cwd: realpathSync(workspace),
          env: { ...NO_API_AUTH, HOME: home },
        });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          kind: "status",
          update_channel: "dev",
          build_channel: "stable",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 upgrade help documents release channels",
    async () => {
      const result = await runY2(["upgrade", "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--channel <stable|dev>");
      expect(result.stdout).toContain("Select and remember the release channel");
    },
    TIMEOUT,
  );

  test(
    "y2 status --json defaults permission mode to auto",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-permission-default-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runY2(["status", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_API_AUTH,
            HOME: realpathSync(home),
            Y2_PERMISSION_MODE: undefined,
          },
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.permission_mode).toBe("auto");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor apply an exact Y2_MAX_AGENT_STEPS override",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-agent-step-limit-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          ...NO_API_AUTH,
          HOME: realpathSync(home),
          Y2_MAX_AGENT_STEPS: "3",
        };

        const status = await runY2(["status", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout.trim()).agent_step_limit).toBe(3);

        const doctor = await runY2(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        const startup = JSON.parse(doctor.stdout.trim()).checks.find(
          (check: { name: string }) => check.name === "startup",
        );
        expect(startup.detail).toContain("agent_step_limit=3");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "project profile-only settings are ignored before parsing and profile overrides win",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-profile-config-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".y2"), { recursive: true });
        mkdirSync(workspace);
        const homeRoot = realpathSync(home);
        const workspaceRoot = realpathSync(workspace);
        const env = {
          ...NO_API_AUTH,
          HOME: homeRoot,
          Y2_MODEL: undefined,
          Y2_PERMISSION_MODE: undefined,
          Y2_MAX_AGENT_STEPS: undefined,
        };

        writeFileSync(
          join(home, ".y2", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
          }) + "\n",
        );
        writeFileSync(
          join(workspace, ".y2.json"),
          JSON.stringify({
            model: 123,
            permission_mode: "danger",
            permission: { bash: true },
            statusLine: 7,
            max_agent_steps: 7,
          }) + "\n",
        );

        const status = await runY2(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        const first = JSON.parse(status.stdout.trim());
        expect(first.model).toBe("anthropic/claude-sonnet-4.6");
        expect(first.permission_mode).toBe("auto");
        expect(first.agent_step_limit).toBe(7);
        expect(status.stderr).toContain(
          "y2: config project: ignored_project_user_only_setting; key=model",
        );
        expect(status.stderr).toContain(
          "y2: config project: ignored_project_user_only_setting; key=permission_mode",
        );
        expect(status.stderr).toContain(
          "y2: config project: ignored_project_user_only_setting; key=permission",
        );
        expect(status.stderr).toContain(
          "y2: config project: ignored_project_user_only_setting; key=statusLine",
        );
        expect(status.stderr).not.toContain("danger");

        writeFileSync(
          join(home, ".y2", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
            workspaces: {
              [workspaceRoot]: {
                max_agent_steps: 4,
              },
            },
          }) + "\n",
        );

        const overridden = await runY2(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(overridden.code).toBe(0);
        const second = JSON.parse(overridden.stdout.trim());
        expect(second.model).toBe("anthropic/claude-sonnet-4.6");
        expect(second.permission_mode).toBe("auto");
        expect(second.agent_step_limit).toBe(4);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "special settings files fail closed without blocking CLI startup",
    async () => {
      if (platform() === "win32") return;
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-config-special-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const y2Dir = join(home, ".y2");
        mkdirSync(y2Dir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(y2Dir, 0o700);

        const env = {
          ...NO_API_AUTH,
          HOME: home,
          Y2_DISABLE_KEYCHAIN: "1",
          Y2_SKIP_ONBOARDING: "1",
          Y2_SOUND: "0",
        };

        expect(spawnSync("mkfifo", [join(y2Dir, "settings.json")]).status).toBe(0);
        const userStartedAt = Date.now();
        const user = await runY2(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 3_000,
        });
        expect(Date.now() - userStartedAt).toBeLessThan(3_000);
        expect(user.code).toBe(0);
        expect(JSON.parse(user.stdout)).toMatchObject({ kind: "status" });
        expect(user.stderr).toContain("y2: config user: durable_path_unsafe");

        rmSync(join(y2Dir, "settings.json"));
        expect(spawnSync("mkfifo", [join(workspace, ".y2.json")]).status).toBe(0);
        const projectStartedAt = Date.now();
        const project = await runY2(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 3_000,
        });
        expect(Date.now() - projectStartedAt).toBeLessThan(3_000);
        expect(project.code).toBe(0);
        expect(JSON.parse(project.stdout)).toMatchObject({ kind: "status" });
        expect(project.stderr).toContain("y2: config project: durable_path_unsafe");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: usage", () => {
  test(
    "y2 usage reads rolling local facts without credentials or profile mutation",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-usage-"));
      try {
        const home = join(root, "home");
        const y2Dir = join(home, ".y2");
        mkdirSync(y2Dir, { recursive: true, mode: 0o700 });
        chmodSync(y2Dir, 0o700);
        const now = Date.now();
        const records = [
          {
            schema_version: 1,
            kind: "coverage",
            started_at_ms: now - 40 * 24 * 60 * 60 * 1000,
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              created_at_ms: now - 60 * 60 * 1000,
              model: "provider/a",
              input_tokens: 15,
              output_tokens: 3,
              cache_read_tokens: 5,
              cache_write_tokens: 1,
              reasoning_tokens: 2,
              total_cost: 0.25,
            },
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAW",
              created_at_ms: now - 2 * 24 * 60 * 60 * 1000,
              model: "provider/b",
              input_tokens: 10,
              output_tokens: 2,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              reasoning_tokens: null,
              total_cost: 0.1,
            },
          },
        ];
        const usagePath = join(y2Dir, "usage.jsonl");
        writeFileSync(
          usagePath,
          records.map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        chmodSync(usagePath, 0o600);
        const before = readFileSync(usagePath, "utf8");
        const entriesBefore = readdirSync(y2Dir).sort();
        const env = {
          ...NO_API_AUTH,
          HOME: realpathSync(home),
          Y2_DISABLE_KEYCHAIN: "1",
        };

        const text = await runY2(["usage"], { env });
        expect(text.code).toBe(0);
        expect(text.stderr).toBe("");
        expect(text.stdout).toContain("Usage (30 days)");
        expect(text.stdout).toContain("Total tokens  30");
        expect(text.stdout.indexOf("provider/a")).toBeLessThan(
          text.stdout.indexOf("provider/b"),
        );

        const json = await runY2(
          ["usage", "--json", "--period", "24h"],
          { env },
        );
        expect(json.code).toBe(0);
        expect(json.stderr).toBe("");
        const report = JSON.parse(json.stdout);
        expect(report).toMatchObject({
          kind: "usage",
          schema_version: 1,
          period: "24h",
          completeness: "complete",
          totals: {
            total_tokens: 18,
            input_tokens: 15,
            output_tokens: 3,
            request_count: 1,
          },
        });
        expect(report.models.map((model: { model: string }) => model.model))
          .toEqual(["provider/a"]);
        expect(readFileSync(usagePath, "utf8")).toBe(before);
        expect(readdirSync(y2Dir).sort()).toEqual(entriesBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 usage preserves known totals when the ledger is incomplete",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-usage-incomplete-"));
      try {
        const home = join(root, "home");
        const y2Dir = join(home, ".y2");
        mkdirSync(y2Dir, { recursive: true, mode: 0o700 });
        const now = Date.now();
        const records = [
          {
            schema_version: 1,
            kind: "coverage",
            started_at_ms: now - 40 * 24 * 60 * 60 * 1000,
          },
          {
            schema_version: 1,
            kind: "generation",
            fact: {
              id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              created_at_ms: now - 2,
              model: "provider/model",
              input_tokens: 4,
              output_tokens: 2,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              reasoning_tokens: 1,
              total_cost: 0.01,
            },
          },
          {
            schema_version: 1,
            kind: "incident",
            occurred_at_ms: now - 1,
            completeness: "incomplete",
          },
        ];
        writeFileSync(
          join(y2Dir, "usage.jsonl"),
          records.map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(y2Dir, "usage.lock"), "", { mode: 0o600 });
        const env = {
          ...NO_API_AUTH,
          HOME: realpathSync(home),
          Y2_DISABLE_KEYCHAIN: "1",
        };

        const text = await runY2(["usage"], { env });
        expect(text.code).toBe(0);
        expect(text.stdout).toContain("Known totals may be incomplete.");
        expect(text.stdout).toContain("Total tokens  6");

        const json = await runY2(["usage", "--json"], { env });
        expect(json.code).toBe(0);
        expect(JSON.parse(json.stdout)).toMatchObject({
          completeness: "incomplete",
          totals: { total_tokens: 6, spend: 0.01 },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 usage distinguishes empty, invalid, corrupt, and unsafe local state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-usage-states-"));
      try {
        const home = realpathSync(root);
        const env = { ...NO_API_AUTH, HOME: home, Y2_DISABLE_KEYCHAIN: "1" };
        const empty = await runY2(["usage", "--json"], { env });
        expect(empty.code).toBe(0);
        expect(JSON.parse(empty.stdout)).toMatchObject({
          coverage: { status: "not_started" },
          totals: null,
        });
        expect(existsSync(join(home, ".y2"))).toBe(false);

        const invalid = await runY2(
          ["usage", "--period", "session", "--json"],
          { env },
        );
        expect(invalid.code).toBe(1);
        expect(JSON.parse(invalid.stdout)).toMatchObject({
          kind: "usage",
          code: "InvalidUsageArgs",
        });

        const y2Dir = join(home, ".y2");
        mkdirSync(y2Dir, { mode: 0o700 });
        chmodSync(y2Dir, 0o700);
        writeFileSync(
          join(y2Dir, "usage.jsonl"),
          `${JSON.stringify({
            schema_version: 1,
            kind: "coverage",
            started_at_ms: Date.now() - 1,
          })}\n`,
          { mode: 0o600 },
        );
        if (platform() !== "win32") {
          chmodSync(y2Dir, 0o755);
          const entries = readdirSync(y2Dir);
          const unsafeDirectory = await runY2(["usage", "--json"], { env });
          expect(unsafeDirectory.code).toBe(1);
          expect(JSON.parse(unsafeDirectory.stdout)).toMatchObject({
            kind: "usage",
            code: "PrivateStatePermissionsUnsupported",
          });
          expect(lstatSync(y2Dir).mode & 0o777).toBe(0o755);
          expect(readdirSync(y2Dir)).toEqual(entries);
          chmodSync(y2Dir, 0o700);
        }
        writeFileSync(join(y2Dir, "usage.jsonl"), "{\"broken\":true}\n", {
          mode: 0o600,
        });
        writeFileSync(join(y2Dir, "usage.lock"), "", { mode: 0o600 });
        const corrupt = await runY2(["usage", "--json"], { env });
        expect(corrupt.code).toBe(1);
        expect(JSON.parse(corrupt.stdout)).toMatchObject({
          kind: "usage",
          code: "InvalidUsageStore",
        });

        if (platform() !== "win32") {
          rmSync(join(y2Dir, "usage.jsonl"));
          const fifo = spawnSync("mkfifo", [join(y2Dir, "usage.jsonl")]);
          expect(fifo.status).toBe(0);
          const special = await runY2(["usage", "--json"], { env });
          expect(special.code).toBe(1);
          expect(JSON.parse(special.stdout)).toMatchObject({
            kind: "usage",
            code: "DurablePathUnsafe",
          });

          rmSync(join(y2Dir, "usage.jsonl"));
          const socketPath = join(y2Dir, "usage.jsonl");
          const server = createServer();
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
              server.off("error", reject);
              resolve();
            });
          });
          try {
            const socket = await runY2(["usage", "--json"], { env });
            expect(socket.code).toBe(1);
            expect(JSON.parse(socket.stdout)).toMatchObject({
              kind: "usage",
              code: "DurablePathUnsafe",
            });
          } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 usage preserves known totals but fails closed when recovery storage is unsafe",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-usage-recovery-"));
      try {
        const home = join(root, "home");
        const y2Dir = join(home, ".y2");
        mkdirSync(y2Dir, { recursive: true, mode: 0o700 });
        chmodSync(y2Dir, 0o700);
        writeFileSync(
          join(y2Dir, "usage.jsonl"),
          [
            {
              schema_version: 1,
              kind: "coverage",
              started_at_ms: Date.now() - 40 * 24 * 60 * 60 * 1000,
            },
            {
              schema_version: 1,
              kind: "generation",
              fact: {
                id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                created_at_ms: Date.now() - 1,
                model: "provider/model",
                input_tokens: 4,
                output_tokens: 2,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                reasoning_tokens: 1,
                total_cost: 0.01,
              },
            },
          ].map((record) => JSON.stringify(record)).join("\n") + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(y2Dir, "usage.lock"), "", { mode: 0o600 });
        const outside = join(root, "outside");
        writeFileSync(outside, "not a session directory");
        symlinkSync(outside, join(y2Dir, "sessions"));

        const result = await runY2(["usage", "--json"], {
          env: {
            ...NO_API_AUTH,
            HOME: realpathSync(home),
            Y2_DISABLE_KEYCHAIN: "1",
          },
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          kind: "usage",
          coverage: { status: "full" },
          completeness: "incomplete",
          totals: { total_tokens: 6, spend: 0.01 },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: permissions", () => {
  test(
    "y2 permissions --json returns valid permissions JSON",
    async () => {
      const r = await runY2(["permissions", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("permissions");
      expect(json).toHaveProperty("mode");
      expect(json).toHaveProperty("grant_count");
      expect(json.grant_scope).toBe("session");
      expect(json.runtime_grants_available).toBe(false);
      expect(json.rules_scope).toBe("persistent_config");
      expect(Array.isArray(json.rules)).toBe(true);
      expect(Array.isArray(json.grants)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("cli: doctor", () => {
  test(
    "y2 doctor --json returns valid doctor JSON",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-doctor-json-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runY2(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_API_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(Array.isArray(json.checks)).toBe(true);
        expect(json).toHaveProperty("ok_count");
        expect(json).toHaveProperty("warn_count");
        expect(json).toHaveProperty("fail_count");
        expect(json.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
        for (const check of json.checks) {
          expect(check).toHaveProperty("name");
          expect(check).toHaveProperty("status");
          expect(check).toHaveProperty("detail");
          expect(["ok", "warn", "fail"]).toContain(check.status);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 doctor --json leaves an empty home unchanged",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-doctor-no-create-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runY2(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_API_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout.trim()).kind).toBe("doctor");
        expect(existsSync(join(home, ".y2"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 doctor --json bounds session diagnostics without summary cache",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-doctor-bounded-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const limit = doctorSessionDiagnosticsLimit();
        const sessionCount = limit + 32;
        for (let i = 0; i < sessionCount; i += 1) {
          writeLegacySession(
            home,
            workspaceRoot,
            `doctor-bounded-${String(i).padStart(3, "0")}`,
            { updatedAtMs: i + 1 },
          );
        }

        expect(existsSync(join(home, ".y2", "sessions", "summary.json"))).toBe(false);

        const r = await runY2(["doctor", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...NO_API_AUTH,
            HOME: home,
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout.length).toBeLessThan(64 * 1024);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(json.checks.length).toBeLessThan(sessionCount);
        expect(json.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "session",
              status: "warn",
              detail: expect.stringContaining(
                `truncated after ${limit} session director`,
              ),
            }),
            expect.objectContaining({
              name: "sessions",
              status: "warn",
              detail: expect.stringContaining(
                "unavailable without a full session scan",
              ),
            }),
          ]),
        );
        expect(
          json.checks.some((check: { detail: string }) =>
            check.detail.includes(`${sessionCount} saved session(s)`),
          ),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});


describe("cli: setup", () => {
  test(
    "y2 setup is a top-level command and fails cleanly when Keychain is disabled",
    async () => {
      const r = await runY2(["setup"], {
        env: { ...NO_API_AUTH, Y2_DISABLE_KEYCHAIN: "1" },
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("stored API keys are disabled");
    },
    TIMEOUT,
  );

});

// The file backend is only selected off macOS, so these run on Linux CI.
describe("cli: stored key file backend", () => {
  test.skipIf(platform() === "darwin")(
    "a 0600 key file resolves, and a loosened one is refused rather than reported absent",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "y2-stored-key-file-"));
      const y2Dir = join(home, ".y2");
      mkdirSync(y2Dir, { recursive: true, mode: 0o700 });
      chmodSync(y2Dir, 0o700);
      const keyPath = join(y2Dir, "api-key");
      writeFileSync(keyPath, "vca_file_backend_key", { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      const env = { ...NO_API_AUTH, HOME: realpathSync(home) };

      try {
        const readable = await runY2(["status", "--json"], { env });
        expect(readable.code).toBe(0);
        const readableJson = JSON.parse(readable.stdout);
        expect(readableJson.auth).toBe("stored API key (profile file)");
        expect(readableJson.auth_help).toBeUndefined();
        expect(readable.stdout).not.toContain("vca_file_backend_key");

        chmodSync(keyPath, 0o644);
        const refused = await runY2(["status", "--json"], { env });
        expect(refused.code).toBe(0);
        const refusedJson = JSON.parse(refused.stdout);
        expect(refusedJson.auth).toBe("missing");
        // Refusal must not read as absence.
        expect(refusedJson.auth_help).toContain("could not read the stored API key");
        expect(refusedJson.auth_help).not.toBe(MISSING_AUTH_MESSAGE);

        rmSync(keyPath);
        const absent = await runY2(["status", "--json"], { env });
        const absentJson = JSON.parse(absent.stdout);
        expect(absentJson.auth).toBe("missing");
        expect(absentJson.auth_help).toBe(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});


describe("cli: read-only no-create matrix", () => {
  const probes = [
    { args: ["status", "--json"], code: 0, kind: "status" },
    { args: ["sessions", "--json"], code: 0, kind: "sessions", count: 0 },
    { args: ["session", "last", "--json"], code: 1, error: "no saved sessions" },
    { args: ["session", "--id", "missing.valid-id", "--json"], code: 1, error: "record not found" },
    { args: ["background", "--json"], code: 0, kind: "background", count: 0 },
    { args: ["background", "999999", "--json"], code: 1, error: "no persisted records" },
    { args: ["doctor", "--json"], code: 0, kind: "doctor" },
  ] as const;

  for (const probe of probes) {
    test(
      `${probe.args.join(" ")} leaves an empty home unchanged`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "y2-e2e-no-create-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(home);
          mkdirSync(workspace);
          const before = snapshotTree(home);

          const result = await runY2([...probe.args], {
            cwd: realpathSync(workspace),
            env: {
              ...NO_API_AUTH,
              HOME: realpathSync(home),
              Y2_E2E_FAIL_ON_DURABLE_MUTATION: "1",
            },
            timeoutMs: TIMEOUT,
          });

          expect(result.code).toBe(probe.code);
          if ("kind" in probe) {
            const output = JSON.parse(result.stdout);
            expect(output.kind).toBe(probe.kind);
            if ("count" in probe) expect(output.count).toBe(probe.count);
          } else {
            const output = JSON.parse(result.stdout);
            expect(output.error).toContain(probe.error);
            expect(result.stderr).toBe("");
          }
          expect(snapshotTree(home)).toEqual(before);
          expect(existsSync(join(home, ".y2"))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

describe("cli: missing durable home", () => {
  test(
    "read-only commands tolerate a nonexistent HOME and saved ask bootstraps it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-missing-home-path-"));
      const home = join(root, "missing-home");
      const workspace = join(root, "workspace");
      const gateway = startFakeGateway([
        fakeGatewayFinalText("missing home persisted"),
      ]);
      try {
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const baseEnv = {
          HOME: home,
          OPENAI_API_KEY: undefined,
          Y2_AUTO_UPGRADE: "0",
          Y2_DISABLE_KEYCHAIN: "1",
        };

        const status = await runY2(["status", "--json"], {
          cwd,
          env: { ...baseEnv, Y2_API_KEY: undefined },
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(status.stderr).toBe("");
        expect(JSON.parse(status.stdout).kind).toBe("status");
        expect(existsSync(home)).toBe(false);

        const listed = await runY2(["sessions", "--json"], {
          cwd,
          env: { ...baseEnv, Y2_API_KEY: undefined },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "sessions",
          count: 0,
          sessions: [],
        });
        expect(existsSync(home)).toBe(false);

        const asked = await runY2(
          ["ask", "--json", "--auto", "Persist under the new home."],
          {
            cwd,
            env: {
              ...baseEnv,
              OPENAI_API_KEY: "missing-home-key",
              Y2_GATEWAY_BASE_URL: gateway.baseUrl,
              Y2_API_CHAT_URL: gateway.chatUrl,
              Y2_MODEL: FAKE_GATEWAY_MODEL,
            },
            timeoutMs: TIMEOUT,
          },
        );
        expect(asked.code).toBe(0);
        expect(JSON.parse(asked.stdout).output.trim()).toBe(
          "missing home persisted",
        );
        expect(existsSync(join(home, ".y2", "sessions"))).toBe(true);
        expect(gateway.requests).toHaveLength(1);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session commands fail precisely while doctor remains available without HOME",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-no-home-"));
      try {
        const workspace = join(root, "workspace");
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const env = {
          ...NO_API_AUTH,
          HOME: undefined,
        };

        for (const args of [
          ["sessions", "--json"],
          ["session", "last", "--json"],
          ["session", "--id", "missing.valid-id", "--json"],
          ["session", "migrate", "--id", "missing.valid-id", "--json"],
        ]) {
          const result = await runY2(args, { cwd, env, timeoutMs: TIMEOUT });
          expect(result.code).toBe(1);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toEqual(
            expect.objectContaining({
              code: "HomeNotSet",
            }),
          );
        }

        const doctor = await runY2(["doctor", "--json"], {
          cwd,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        expect(JSON.parse(doctor.stdout).checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "state",
              detail: expect.stringContaining("HomeNotSet"),
            }),
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: sessions", () => {
  test(
    "y2 sessions --json returns valid sessions JSON",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "y2-e2e-sessions-empty-"));
      try {
        const r = await runY2(["sessions", "--json"], { env: { HOME: home } });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("sessions");
        expect(json).toHaveProperty("count");
        expect(Array.isArray(json.sessions)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 sessions text shows named, unnamed, and renamed sessions",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-session-names-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".y2", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".y2"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        const named = {
          id: "named-session",
          workspace_root: workspaceRoot,
          origin_workspace_root: workspaceRoot,
          title: "Investigate cache misses",
          preview: null,
          display_metadata_present: true,
          created_at_ms: 1,
          updated_at_ms: 3,
          conversation_language: "en",
          history_len: 2,
        };
        const unnamed = {
          ...named,
          id: "unnamed-session",
          title: null,
          display_metadata_present: false,
          updated_at_ms: 2,
          history_len: 0,
        };
        const scriptOnly = {
          ...named,
          id: "script-only-session",
          title: "Review landing page",
          updated_at_ms: 1_700_000_000_123,
          conversation_language: "und-Latn",
          history_len: 1,
        };
        const indexPath = join(sessionsDir, "index.json");
        writeFileSync(
          indexPath,
          JSON.stringify({
            schema_version: 3,
            sessions: [scriptOnly, named, unnamed],
          }),
          { mode: 0o600 },
        );

        const first = await runY2(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        expect(first.stdout).toContain(
          " - Investigate cache misses\n   id=named-session | 2 turns | English | updated 1970-01-01 00:00:00.003 UTC",
        );
        expect(first.stdout).toContain(
          " - Untitled session\n   id=unnamed-session | 0 turns | English | updated 1970-01-01 00:00:00.002 UTC",
        );
        expect(first.stdout).toContain(
          " - Review landing page\n   id=script-only-session | 1 turn | Latin script | updated 2023-11-14 22:13:20.123 UTC",
        );
        expect(first.stdout).not.toContain("updated_at_ms");
        expect(first.stdout).not.toContain("language=");

        const structured = await runY2(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(structured.code).toBe(0);
        expect(structured.stderr).toBe("");
        expect(JSON.parse(structured.stdout).sessions[0]).toMatchObject({
          id: "script-only-session",
          updated_at_ms: 1_700_000_000_123,
          conversation_language: "und-Latn",
        });

        writeFileSync(
          indexPath,
          JSON.stringify({
            schema_version: 3,
            sessions: [
              scriptOnly,
              { ...named, title: "Investigate cache hits" },
              unnamed,
            ],
          }),
          { mode: 0o600 },
        );
        const renamed = await runY2(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(renamed.code).toBe(0);
        expect(renamed.stderr).toBe("");
        expect(renamed.stdout).toContain(
          " - Investigate cache hits\n   id=named-session | 2 turns | English",
        );
        expect(renamed.stdout).not.toContain("Investigate cache misses");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session listing pages a 9001-entry index without scanning session directories",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-session-pages-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".y2", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".y2"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        const sessions = Array.from({ length: 9_001 }, (_, index) => {
          const id = `indexed-session-${index.toString().padStart(5, "0")}`;
          return {
            id,
            workspace_root: workspaceRoot,
            origin_workspace_root: workspaceRoot,
            title: id,
            preview: `${id} preview`,
            display_metadata_present: true,
            created_at_ms: 20_000 - index,
            updated_at_ms: 20_000 - index,
            conversation_language: "en",
            history_len: 0,
          };
        });
        writeFileSync(
          join(sessionsDir, "index.json"),
          JSON.stringify({ schema_version: 3, sessions }),
          { mode: 0o600 },
        );

        const first = await runY2(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(Buffer.byteLength(first.stdout)).toBeLessThan(100_000);
        const firstJson = JSON.parse(first.stdout) as {
          count: number;
          has_more: boolean;
          next_cursor: string;
          sessions: Array<{ id: string; history_len: number }>;
        };
        expect(firstJson.count).toBe(100);
        expect(firstJson.has_more).toBe(true);
        expect(firstJson.sessions).toHaveLength(100);
        expect(firstJson.sessions[0]).toMatchObject({
          id: "indexed-session-00000",
          history_len: 0,
        });
        expect(firstJson.sessions[99].id).toBe("indexed-session-00099");

        const second = await runY2(
          ["sessions", "--json", "--cursor", firstJson.next_cursor],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_API_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(second.code).toBe(0);
        const secondJson = JSON.parse(second.stdout) as {
          count: number;
          has_more: boolean;
          sessions: Array<{ id: string }>;
        };
        expect(secondJson.count).toBe(100);
        expect(secondJson.has_more).toBe(true);
        expect(secondJson.sessions[0].id).toBe("indexed-session-00100");
        expect(secondJson.sessions[99].id).toBe("indexed-session-00199");

        const one = await runY2(["sessions", "--json", "--limit", "1"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(one.code).toBe(0);
        expect(JSON.parse(one.stdout)).toMatchObject({
          count: 1,
          has_more: true,
          sessions: [{ id: "indexed-session-00000" }],
        });

        const invalid = await runY2(["sessions", "--limit", "0"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(invalid.code).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session lists use projections without opening unreadable event logs",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-session-projections-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const fixture = spawnSync(
          "python3",
          [
            join(REPO_ROOT, "benchmarks", "session_list_fixture.py"),
            "--home",
            home,
            "--workspace",
            workspaceRoot,
            "--sessions",
            "2",
            "--log-size",
            "4096",
            "--deny-event-read",
          ],
          { encoding: "utf8" },
        );
        expect(fixture.status).toBe(0);

        const before = snapshotTree(join(home, ".y2"));
        const listed = await runY2(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "sessions",
          count: 2,
          sessions: [
            {
              id: "benchmark-session-01",
              title: "Benchmark session 01",
              preview: "Benchmark session 01 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1001,
              updated_at_ms: 2001,
              history_len: 1,
              conversation_language: "en",
            },
            {
              id: "benchmark-session-00",
              title: "Benchmark session 00",
              preview: "Benchmark session 00 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1000,
              updated_at_ms: 2000,
              history_len: 0,
              conversation_language: "en",
            },
          ],
        });
        expect(snapshotTree(join(home, ".y2"))).toEqual(before);

        const latest = await runY2(["session", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(0);
        expect(JSON.parse(latest.stdout)).toEqual({
          kind: "session_summary",
          id: "benchmark-session-01",
          title: "Benchmark session 01",
          preview: "Benchmark session 01 preview",
          workspace_root: workspaceRoot,
          origin_workspace_root: workspaceRoot,
          created_at_ms: 1001,
          updated_at_ms: 2001,
          history_len: 1,
          conversation_language: "en",
        });
        expect(snapshotTree(join(home, ".y2"))).toEqual(before);

        const detail = await runY2(
          ["session", "--id", "benchmark-session-00", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          },
        );
        expect(detail.code).not.toBe(0);
        expect(detail.stderr).toContain("AccessDenied");
        expect(snapshotTree(join(home, ".y2"))).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "workspace-scoped session discovery filters list and last by cwd",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-workspace-sessions-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        mkdirSync(home);
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);

        writeLegacySession(home, workspaceARoot, "workspace-a-older", {
          updatedAtMs: 20,
        });
        writeLegacySession(home, workspaceARoot, "workspace-a-latest", {
          updatedAtMs: 40,
        });
        writeLegacySession(home, workspaceBRoot, "workspace-b-newest", {
          updatedAtMs: 80,
        });

        const listA = await runY2(["sessions", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listA.code).toBe(0);
        const jsonA = JSON.parse(listA.stdout);
        expect(jsonA.kind).toBe("sessions");
        expect(jsonA.count).toBe(2);
        expect(jsonA.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-a-latest", "workspace-a-older"]);

        const lastA = await runY2(["session", "last", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(lastA.code).toBe(0);
        expect(JSON.parse(lastA.stdout).id).toBe("workspace-a-latest");

        const listB = await runY2(["sessions", "--json"], {
          cwd: workspaceBRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listB.code).toBe(0);
        const jsonB = JSON.parse(listB.stdout);
        expect(jsonB.count).toBe(1);
        expect(jsonB.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-b-newest"]);

        const exactForeign = await runY2(
          ["session", "--id", "workspace-b-newest", "--json"],
          {
            cwd: workspaceARoot,
            env: { HOME: home, ...NO_API_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(exactForeign.code).toBe(0);
        expect(JSON.parse(exactForeign.stdout).id).toBe("workspace-b-newest");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session discovery reports corrupt records and distinguishes an unreadable latest session",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-corrupt-sessions-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "readable-session", {
          updatedAtMs: 30,
        });
        for (const [id, contents] of [
          ["invalid-json", "{"],
          ["truncated", '{"schema_version":2,"id":"truncated"}'],
        ] as const) {
          const directory = join(home, ".y2", "sessions", id);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(join(directory, "session.json"), contents, {
            mode: 0o600,
          });
        }

        const listed = await runY2(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toMatchObject({
          kind: "sessions",
          count: 1,
          skipped_invalid: 2,
          sessions: [{ id: "readable-session" }],
        });

        rmSync(join(home, ".y2", "sessions", "readable-session"), {
          recursive: true,
          force: true,
        });
        const latest = await runY2(["session", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(1);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout)).toMatchObject({
          error: expect.stringContaining("saved sessions are unreadable"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "profile-wide session discovery recovers sessions after a workspace rename",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-renamed-workspace-"));
      try {
        const home = join(root, "home");
        const original = join(root, "workspace-before");
        const renamed = join(root, "workspace-after");
        mkdirSync(home);
        mkdirSync(original);
        const originalRoot = realpathSync(original);
        writeLegacySession(home, originalRoot, "renamed-workspace-session", {
          updatedAtMs: 40,
        });
        renameSync(original, renamed);
        const renamedRoot = realpathSync(renamed);

        const scoped = await runY2(["sessions", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(JSON.parse(scoped.stdout)).toMatchObject({ count: 0, sessions: [] });

        const recovered = await runY2(["sessions", "--all", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(recovered.code).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          count: 1,
          sessions: [
            {
              id: "renamed-workspace-session",
              workspace_root: originalRoot,
            },
          ],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 sessions --json ignores malformed and oversized list caches",
    async () => {
      for (const cached of ["{", "x".repeat(4 * 1024 * 1024 + 1)]) {
        const root = mkdtempSync(join(tmpdir(), "y2-e2e-sessions-cache-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(join(home, ".y2", "sessions"), { recursive: true });
          mkdirSync(workspace, { recursive: true });
          writeFileSync(join(home, ".y2", "sessions", "list.json"), cached);

          const r = await runY2(["sessions", "--json"], {
            cwd: realpathSync(workspace),
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          });
          expect(r.code).toBe(0);
          expect(JSON.parse(r.stdout.trim())).toEqual({
            kind: "sessions",
            count: 0,
            sessions: [],
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );

  test(
    "exact session flags address special-token and 255-byte IDs literally",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-session-exact-ids-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const ids = [
          "last",
          "migrate",
          "--json",
          "--allow-large",
          "x".repeat(255),
        ];
        for (const id of ids) writeLegacySession(home, workspaceRoot, id);

        for (const id of ids) {
          const result = await runY2(
            ["session", "--id", id, "--json"],
            {
              cwd: workspaceRoot,
              env: { HOME: home },
              timeoutMs: TIMEOUT,
            },
          );
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout).id).toBe(id);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "expected json failures emit machine-readable stdout",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-json-errors-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const cases: Array<{
          args: string[];
          kind: string;
          expectedError?: string;
        }> = [
          { args: ["session", "last", "--json"], kind: "session" },
          {
            args: ["ask", "--json"],
            kind: "ask",
            expectedError: "MissingPrompt",
          },
          {
            args: ["ask", "--json", "--no-save", "--resume", "last", "hello"],
            kind: "ask",
            expectedError: "InvalidAskArgs",
          },
        ];

        for (const item of cases) {
          const result = await runY2(item.args, {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_API_AUTH },
            timeoutMs: TIMEOUT,
          });
          expect(result.code).toBe(1);
          expect(result.stdout.trim().length).toBeGreaterThan(0);
          const parsed = JSON.parse(result.stdout.trim());
          expect(parsed.kind ?? item.kind).toBe(item.kind);
          expect(typeof parsed.error).toBe("string");
          if (item.expectedError) expect(parsed.error).toBe(item.expectedError);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: removed delegated-task commands", () => {
  test(
    "y2 task and y2 tasks are unknown commands",
    async () => {
      for (const command of ["task", "tasks"]) {
        const result = await runY2([command], { env: NO_API_AUTH });
        expect(result.code).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain("unknown subcommand");
      }
    },
    TIMEOUT,
  );

  test(
    "legacy tasks files are ignored by ordinary session loading",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-legacy-tasks-ignored-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "legacy-tasks-session");
        const tasksDir = join(home, ".y2", "sessions", "legacy-tasks-session", "tasks");
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, "unreadable-legacy-shape.json"), "not json\n");

        const result = await runY2(
          ["session", "--id", "legacy-tasks-session", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_API_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).id).toBe("legacy-tasks-session");
        expect(existsSync(join(tasksDir, "unreadable-legacy-shape.json"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: background", () => {
  test(
    "y2 background --json returns valid background JSON",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-background-empty-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });

        const r = await runY2(["background", "--json"], {
          cwd: workspace,
          env: { HOME: home },
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("background");
        expect(json).toHaveProperty("count");
        expect(Array.isArray(json.records)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 background --json revalidates saved workspace background records",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-background-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const logs = join(root, "logs");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        mkdirSync(logs, { recursive: true });

        const workspaceRoot = realpathSync(workspace);
        const liveLog = join(logs, "live.log");
        const staleLog = join(logs, "stale.log");
        writeFileSync(liveLog, "ready on http://localhost:48976\n");
        writeFileSync(staleLog, "started once\n");

        writeBackgroundSession({
          home,
          sessionId: "session-live",
          workspaceRoot,
          updatedAt: 20,
          record: {
            id: 1,
            pid: String(process.pid),
            command: "npm run dev",
            cwd: workspaceRoot,
            logPath: realpathSync(liveLog),
            expectUrl: true,
            state: "running",
          },
        });
        writeBackgroundSession({
          home,
          sessionId: "session-stale",
          workspaceRoot,
          updatedAt: 10,
          record: {
            id: 2,
            pid: "not-a-pid",
            command: "npm run dev",
            cwd: workspaceRoot,
            logPath: realpathSync(staleLog),
            expectUrl: true,
            state: "running",
          },
        });

        const r = await runY2(["background", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("background");
        expect(json.count).toBe(2);

        const records = json.records as BackgroundRecordJson[];
        const live = records.find((record) => record.log_path === realpathSync(liveLog));
        expect(live).toBeTruthy();
        expect(live?.command).toBe("npm run dev");
        expect(live?.state).toBe("stale");
        expect(live?.server_url).toBeNull();
        expect(live?.diagnostic).toContain("no process identity token");

        const stale = records.find((record) => record.log_path === realpathSync(staleLog));
        expect(stale).toBeTruthy();
        expect(stale?.state).toBe("stale");
        expect(stale?.diagnostic).toContain("pid is missing or invalid");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 background exact json reports corrupt records instead of hiding them as missing",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-background-corrupt-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const logs = join(root, "logs");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        mkdirSync(logs, { recursive: true });

        const workspaceRoot = realpathSync(workspace);
        const logPath = join(logs, "corrupt.log");
        writeFileSync(logPath, "started\n");
        writeBackgroundSession({
          home,
          sessionId: "background-corrupt",
          workspaceRoot,
          updatedAt: 20,
          record: {
            id: 1,
            pid: "not-a-pid",
            command: "npm run dev",
            cwd: workspaceRoot,
            logPath: realpathSync(logPath),
            expectUrl: false,
            state: "running",
          },
        });
        const recordPath = join(
          home,
          ".y2",
          "sessions",
          "background-corrupt",
          "background",
          "1.json",
        );
        writeFileSync(recordPath, "{broken", { mode: 0o600 });

        const result = await runY2(["background", "1", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        const json = JSON.parse(result.stdout.trim());
        expect(json.kind).toBe("background");
        expect(json.code).toBe("InvalidBackgroundRecord");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

type BackgroundRecordJson = {
  log_path: string;
  command: string;
  state: string;
  server_url?: string | null;
  diagnostic?: string | null;
};

function writeBackgroundSession(args: {
  home: string;
  sessionId: string;
  workspaceRoot: string;
  updatedAt: number;
  record: {
    id: number;
    pid: string;
    command: string;
    cwd: string;
    logPath: string;
    expectUrl: boolean;
    state: string;
  };
}): void {
  const sessionDir = join(args.home, ".y2", "sessions", args.sessionId);
  const backgroundDir = join(sessionDir, "background");
  mkdirSync(backgroundDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionDir, 0o700);
  chmodSync(backgroundDir, 0o700);
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 1,
      id: args.sessionId,
      created_at_ms: 1,
      updated_at_ms: args.updatedAt,
      workspace_root: args.workspaceRoot,
      conversation_language: "en",
      history_len: 0,
      history: [],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(backgroundDir, `${args.record.id}.json`),
    JSON.stringify({
      schema_version: 1,
      id: args.record.id,
      started_at_ms: 1,
      updated_at_ms: args.updatedAt,
      pid: args.record.pid,
      command: args.record.command,
      cwd: args.record.cwd,
      log_path: args.record.logPath,
      expect_url: args.record.expectUrl,
      server_url: null,
      exit_code: null,
      state: args.record.state,
      diagnostic: null,
    }),
    { mode: 0o600 },
  );
}


function catalogTraceEvents(trace: string): string[] {
  return trace.split("\n").filter((line) =>
    line.includes("[catalog] event=model_catalog_load ")
  );
}


describe("cli: replay failures", () => {
  test(
    "y2 replay --json preserves structured failures for missing and malformed tapes",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-replay-json-errors-"));
      try {
        const missing = await runY2(["replay", join(root, "missing.y2tape"), "--json"]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toBe("");
        expect(JSON.parse(missing.stdout.trim())).toMatchObject({
          kind: "replay",
          code: "FileNotFound",
        });

        const malformedPath = join(root, "malformed.y2tape");
        writeFileSync(malformedPath, "not a tape");
        const malformed = await runY2(["replay", malformedPath, "--json"]);
        expect(malformed.code).toBe(1);
        expect(malformed.stderr).toBe("");
        expect(JSON.parse(malformed.stdout.trim())).toMatchObject({
          kind: "replay",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: ask input validation", () => {
  test(
    "y2 ask rejects invalid UTF-8 stdin before Gateway or session effects",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-ask-invalid-utf8-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(home);
      mkdirSync(workspace);
      const requests: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url).pathname);
          return Response.json({ error: "request should not arrive" }, { status: 400 });
        },
      });

      try {
        const result = await runY2(["ask", "--json", "--no-save"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_API_AUTH,
            HOME: realpathSync(home),
            OPENAI_API_KEY: "invalid-utf8-proof-key",
            Y2_DISABLE_KEYCHAIN: "1",
            Y2_API_CHAT_URL: `http://127.0.0.1:${server.port}/ai/v1/chat/completions`,
          },
          stdin: Uint8Array.from([0xff, 0xfe, 0x80, 0x68, 0x69]),
          timeoutMs: TIMEOUT,
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          exit_code: 1,
          error: "InvalidPromptText",
        });
        expect(requests).toEqual([]);
        expect(existsSync(join(home, ".y2"))).toBe(false);
      } finally {
        server.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: session", () => {
  test(
    "y2 session with no id exits non-zero or shows usage",
    async () => {
      const r = await runY2(["session"]);
      expect(r.code).not.toBe(0);
    },
    TIMEOUT,
  );
});

describe("cli: interactive startup", () => {
  test(
    "interactive startup without TTY exits one",
    async () => {
      const cases = [
        [],
        ["resume", "last"],
        ["--resume"],
        ["session", "resume", "last"],
        ["session", "resume", "--id", "session.v3"],
      ];

      for (const args of cases) {
        const home = realpathSync(mkdtempSync(join(tmpdir(), "y2-e2e-no-tty-")));
        try {
          const r = await runY2(args, { env: { HOME: home } });
          expect(r.code).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toBe("y2 requires an interactive terminal (TTY).\n");
          expect(readdirSync(home)).toEqual([]);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );
});

describe("cli: pr", () => {
  test(
    "y2 pr without gateway auth exits non-zero",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "y2-e2e-noauth-"));
      try {
        const r = await runY2(["pr"], {
          env: { ...NO_API_AUTH, HOME: home, Y2_DISABLE_KEYCHAIN: "1" },
        });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: issue", () => {
  test(
    "y2 issue without gateway auth exits non-zero",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "y2-e2e-noauth-"));
      try {
        const r = await runY2(["issue"], {
          env: { ...NO_API_AUTH, HOME: home, Y2_DISABLE_KEYCHAIN: "1" },
        });
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain(MISSING_AUTH_MESSAGE);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: ask success", () => {
  test(
    "y2 ask binds an explicitly invoked skill into the prompt",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-ask-explicit-skill-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const skillDirectory = join(home, ".y2", "skills", "cli-explicit");
      const skillBody = "CLI_EXPLICIT_SKILL_BODY";
      const gateway = startFakeGateway([
        fakeGatewayFinalText("explicit skill ask complete"),
      ]);
      try {
        mkdirSync(skillDirectory, { recursive: true });
        mkdirSync(workspace);
        writeFileSync(
          join(skillDirectory, "SKILL.md"),
          `---\nname: cli-explicit\ndescription: explicit CLI fixture\n---\n\n${skillBody}\n`,
        );

        const result = await runY2(
          [
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "$cli-explicit apply the selected skill.",
          ],
          {
            cwd: realpathSync(workspace),
            env: {
              HOME: realpathSync(home),
              OPENAI_API_KEY: "fake-explicit-skill-key",
              Y2_GATEWAY_BASE_URL: gateway.baseUrl,
              Y2_API_CHAT_URL: gateway.chatUrl,
              Y2_MODEL: FAKE_GATEWAY_MODEL,
              Y2_AUTO_UPGRADE: "0",
            },
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).output.trim()).toBe(
          "explicit skill ask complete",
        );
        expect(gateway.requests).toHaveLength(1);
        expect(gateway.modelRequests).toHaveLength(0);
        expect(gateway.requests[0]!.body).toContain(
          "Explicitly invoked skill content for this query:",
        );
        expect(gateway.requests[0]!.body).toContain(
          '<skill_content name=\\"cli-explicit\\" resource=\\"SKILL.md\\"',
        );
        expect(gateway.requests[0]!.body).toContain(skillBody);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 ask sends stdin prompts above the old 1 MiB limit byte-for-byte",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-ask-large-stdin-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const sizes = [1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024];
      const gateway = startFakeGateway(
        sizes.map((_, index) => fakeGatewayFinalText(`large stdin ${index}`)),
      );
      try {
        mkdirSync(join(home, ".y2"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(join(home, ".y2", "settings.json"), "{}\n");

        for (const [index, size] of sizes.entries()) {
          const prompt = `B${"x".repeat(size - 2)}E`;
          const result = await runY2(
            ["ask", "--json", "--auto", "--no-save"],
            {
              cwd: realpathSync(workspace),
              env: {
                HOME: home,
                OPENAI_API_KEY: "fake-large-stdin-key",
                Y2_GATEWAY_BASE_URL: gateway.baseUrl,
                Y2_API_CHAT_URL: gateway.chatUrl,
                Y2_MODEL: FAKE_GATEWAY_MODEL,
                Y2_AUTO_UPGRADE: "0",
              },
              stdin: prompt,
              timeoutMs: 60_000,
            },
          );

          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout).output.trim()).toBe(`large stdin ${index}`);
          const request = JSON.parse(gateway.requests[index]!.body) as {
            messages: Array<{ role: string; content: string }>;
          };
          const user = request.messages.findLast((message) => message.role === "user");
          expect(user?.content).toBe(prompt);
        }

        expect(gateway.requests).toHaveLength(sizes.length);
        expect(gateway.modelRequests).toHaveLength(0);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "y2 ask stdin resource overflow has distinct text and JSON errors",
    async () => {
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x78);

      const textResult = await runY2(["ask", "--auto", "--no-save"], {
        env: { ...NO_API_AUTH, Y2_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(textResult.code).toBe(1);
      expect(textResult.stdout).toBe("");
      expect(textResult.stderr).toBe(
        "y2 ask: prompt exceeds the local input safety limit\n",
      );

      const jsonResult = await runY2(["ask", "--json", "--auto", "--no-save"], {
        env: { ...NO_API_AUTH, Y2_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(jsonResult.code).toBe(1);
      expect(jsonResult.stderr).toBe("");
      expect(jsonResult.stdout).toBe(
        '{"output":"","exit_code":1,"model":"","session_id":"","steps":0,"tool_calls":[],"error":"PromptResourceLimitExceeded"}\n',
      );
    },
    120_000,
  );

  test(
    "saved ask resumes the exact session while no-save creates no durable state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-ask-persistence-"));
      const gateway = startFakeGateway([
        fakeGatewayFinalText("orange triangle"),
        fakeGatewayFinalText("blue circle"),
        fakeGatewayFinalText("green square"),
      ]);
      try {
        const savedHome = join(root, "saved-home");
        const noSaveHome = join(root, "no-save-home");
        const workspace = join(root, "workspace");
        mkdirSync(savedHome);
        mkdirSync(noSaveHome);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);

        const first = await runY2(
          ["ask", "--json", "--auto", "Reply with exactly: orange triangle"],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(savedHome),
              OPENAI_API_KEY: "fake-ask-persistence-key",
              Y2_GATEWAY_BASE_URL: gateway.baseUrl,
              Y2_API_CHAT_URL: gateway.chatUrl,
              Y2_MODEL: FAKE_GATEWAY_MODEL,
              Y2_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        const firstJson = JSON.parse(first.stdout.trim());
        expect(typeof firstJson.session_id).toBe("string");
        expect(firstJson.session_id.length).toBeGreaterThan(0);
        expect(gateway.requests[0]?.headers.get("x-session-id")).toBeNull();
        expect(gateway.requests[0]?.headers.get("x-session-affinity")).toBeNull();
        expect(
          existsSync(
            join(savedHome, ".y2", "sessions", firstJson.session_id),
          ),
        ).toBe(true);

        const resumed = await runY2(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            "last",
            "Reply with exactly: blue circle",
          ],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(savedHome),
              OPENAI_API_KEY: "fake-ask-persistence-key",
              Y2_GATEWAY_BASE_URL: gateway.baseUrl,
              Y2_API_CHAT_URL: gateway.chatUrl,
              Y2_MODEL: FAKE_GATEWAY_MODEL,
              Y2_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        expect(JSON.parse(resumed.stdout.trim()).session_id).toBe(
          firstJson.session_id,
        );
        expect(gateway.requests[1]?.headers.get("x-session-id")).toBeNull();
        expect(gateway.requests[1]?.headers.get("x-session-affinity")).toBeNull();
        const detail = await runY2(
          ["session", "--id", firstJson.session_id, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: realpathSync(savedHome) },
            timeoutMs: 60_000,
          },
        );
        expect(detail.code).toBe(0);
        expect(JSON.parse(detail.stdout).history_len).toBe(2);

        const noSave = await runY2(
          ["ask", "--json", "--auto", "--no-save", "Reply with exactly: green square"],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(noSaveHome),
              OPENAI_API_KEY: "fake-ask-persistence-key",
              Y2_GATEWAY_BASE_URL: gateway.baseUrl,
              Y2_API_CHAT_URL: gateway.chatUrl,
              Y2_MODEL: FAKE_GATEWAY_MODEL,
              Y2_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(noSave.code).toBe(0);
        expect(noSave.stderr).toBe("");
        expect(JSON.parse(noSave.stdout.trim()).session_id).toBe("");
        expect(gateway.requests[2]?.headers.get("x-session-id")).toBeNull();
        expect(gateway.requests[2]?.headers.get("x-session-affinity")).toBeNull();
        expect(existsSync(join(noSaveHome, ".y2"))).toBe(false);
        expect(gateway.requests).toHaveLength(3);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test(
    "saved ask survives session cache contention and repairs after release",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-session-cache-contention-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const lockReady = join(root, "latest-lock-ready");
      const unrelatedReply = `unrelated saved turn ${"x".repeat(64 * 1024)}`;
      const gateway = startFakeGateway([
        fakeGatewayFinalText(unrelatedReply),
        fakeGatewayFinalText("first saved turn"),
        fakeGatewayFinalText("contended exact turn"),
        fakeGatewayFinalText("contended latest turn"),
        fakeGatewayFinalText("repairing turn"),
      ]);
      let lockHolder: ReturnType<typeof Bun.spawn> | null = null;
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const env = {
          HOME: realpathSync(home),
          OPENAI_API_KEY: "fake-session-cache-contention-key",
          Y2_GATEWAY_BASE_URL: gateway.baseUrl,
          Y2_API_CHAT_URL: gateway.chatUrl,
          Y2_MODEL: FAKE_GATEWAY_MODEL,
          Y2_AUTO_UPGRADE: "0",
        };

        const unrelated = await runY2(
          ["ask", "--json", "--auto", "Save an unrelated long turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(unrelated.code).toBe(0);
        expect(unrelated.stderr).toBe("");
        const unrelatedJson = JSON.parse(unrelated.stdout);
        const unrelatedSessionId = unrelatedJson.session_id as string;
        expect(unrelatedJson.output).toBe(unrelatedReply);

        const first = await runY2(
          ["ask", "--json", "--auto", "Reply with the first saved turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        const sessionId = JSON.parse(first.stdout).session_id as string;
        const lockPath = join(home, ".y2", "sessions", "latest.lock");
        lockHolder = Bun.spawn(
          [
            "python3",
            "-c",
            [
              "import fcntl, os, sys, time",
              "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
              "fcntl.flock(fd, fcntl.LOCK_EX)",
              "open(sys.argv[2], 'w').close()",
              "time.sleep(300)",
            ].join("\n"),
            lockPath,
            lockReady,
          ],
          { stdout: "ignore", stderr: "pipe" },
        );
        for (let attempt = 0; attempt < 250 && !existsSync(lockReady); attempt += 1) {
          await Bun.sleep(20);
        }
        expect(existsSync(lockReady)).toBe(true);

        const exact = await runY2(
          [
            "ask",
            "--json",
            "--auto",
            "--resume-id",
            sessionId,
            "Reply with the contended exact turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(exact.code).toBe(0);
        expect(exact.stderr).toBe("");
        expect(JSON.parse(exact.stdout).output.trim()).toBe("contended exact turn");
        const tokenPath = join(
          home,
          ".y2",
          "sessions",
          "latest",
          "deferred",
          sessionId,
        );
        expect(existsSync(tokenPath)).toBe(true);

        const listed = await runY2(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_API_AUTH },
          timeoutMs: 60_000,
        });
        expect(listed.code).toBe(0);
        expect(listed.stderr).toBe("");
        const listedSessions = JSON.parse(listed.stdout).sessions;
        expect(listedSessions[0]).toMatchObject({
          id: sessionId,
          history_len: 2,
        });
        expect(listedSessions[1]).toMatchObject({
          id: unrelatedSessionId,
          history_len: 1,
        });
        expect(existsSync(tokenPath)).toBe(true);

        const latest = await runY2(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            "last",
            "Reply with the contended latest turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(latest.code).toBe(0);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout).session_id).toBe(sessionId);
        expect(JSON.parse(latest.stdout).output.trim()).toBe("contended latest turn");
        expect(existsSync(tokenPath)).toBe(true);

        lockHolder.kill();
        await lockHolder.exited;
        lockHolder = null;
        const repaired = await runY2(
          [
            "ask",
            "--json",
            "--auto",
            "--resume-id",
            sessionId,
            "Reply with the repairing turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(repaired.code).toBe(0);
        expect(repaired.stderr).toBe("");
        expect(JSON.parse(repaired.stdout).output.trim()).toBe("repairing turn");
        expect(existsSync(tokenPath)).toBe(false);
        const targetDetail = await runY2(
          ["session", "--id", sessionId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(targetDetail.code).toBe(0);
        expect(targetDetail.stderr).toBe("");
        expect(JSON.parse(targetDetail.stdout).history_len).toBe(4);
        const unrelatedDetail = await runY2(
          ["session", "--id", unrelatedSessionId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(unrelatedDetail.code).toBe(0);
        expect(unrelatedDetail.stderr).toBe("");
        expect(JSON.parse(unrelatedDetail.stdout).history_len).toBe(1);
        expect(gateway.requests).toHaveLength(5);
      } finally {
        if (lockHolder) {
          lockHolder.kill();
          await lockHolder.exited;
        }
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );

  test.skipIf(!HAS_API_KEY)(
    "y2 ask --json --no-save --auto returns valid JSON with output",
    async () => {
      const r = await runY2(
        ["ask", "--json", "--no-save", "--auto", "Say exactly: hello world"],
        { timeoutMs: 60_000 },
      );
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(typeof json.output).toBe("string");
      expect(json.output.length).toBeGreaterThan(0);
      expect(typeof json.model).toBe("string");
      expect(Array.isArray(json.tool_calls)).toBe(true);
      expect(typeof json.steps).toBe("number");
    },
    60_000,
  );
});

describe("cli: error handling", () => {
  test(
    "y2 ask rejects unknown options before a model turn and -- preserves literal prompt text",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-ask-options-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const gateway = startFakeGateway([
        fakeGatewayFinalText("literal option prompt complete"),
      ]);
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          HOME: realpathSync(home),
          OPENAI_API_KEY: "ask-options-key",
          Y2_GATEWAY_BASE_URL: gateway.baseUrl,
          Y2_API_CHAT_URL: gateway.chatUrl,
          Y2_MODEL: FAKE_GATEWAY_MODEL,
          Y2_AUTO_UPGRADE: "0",
        };

        const rejected = await runY2(["ask", "--definitely-unknown"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toContain("usage: y2 ask");
        expect(gateway.requests).toHaveLength(0);

        const literal = await runY2(
          [
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "--",
            "--definitely-prompt-text",
          ],
          {
            cwd: realpathSync(workspace),
            env,
            timeoutMs: TIMEOUT,
          },
        );
        expect(literal.code).toBe(0);
        expect(JSON.parse(literal.stdout).output.trim()).toBe(
          "literal option prompt complete",
        );
        expect(gateway.requests).toHaveLength(1);
        expect(gateway.requests[0]!.body).toContain("--definitely-prompt-text");
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "y2 ask with no prompt exits 1",
    async () => {
      const r = await runY2(["ask"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("missing prompt");
    },
    TIMEOUT,
  );

  test(
    "y2 unknown-command exits 1",
    async () => {
      const r = await runY2(["unknown-command"]);
      expect(r.code).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "y2 ask explains no-save resume conflicts before a model turn",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-e2e-ask-resume-no-save-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const gateway = startFakeGateway([]);
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          HOME: realpathSync(home),
          OPENAI_API_KEY: "ask-conflict-key",
          Y2_GATEWAY_BASE_URL: gateway.baseUrl,
          Y2_API_CHAT_URL: gateway.chatUrl,
          Y2_MODEL: FAKE_GATEWAY_MODEL,
          Y2_AUTO_UPGRADE: "0",
        };

        for (const args of [
          ["ask", "--no-save", "--resume", "last", "hello"],
          ["ask", "--resume-id", "session.v3", "--no-save", "hello"],
        ]) {
          const rejected = await runY2(args, {
            cwd: realpathSync(workspace),
            env,
            timeoutMs: TIMEOUT,
          });
          expect(rejected.code).toBe(1);
          expect(rejected.stdout).toBe("");
          expect(rejected.stderr).toContain(
            "y2 ask: --no-save cannot be used with --resume or --resume-id",
          );
          expect(rejected.stderr).toContain(
            "usage: y2 ask [--auto|--yolo] [--image PATH] [--json] [--quiet] [--prompt-permissions] [--no-save]",
          );
        }
        expect(gateway.requests).toHaveLength(0);
      } finally {
        gateway.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: workspace access", () => {
  test(
    "workspace launch modifiers preserve ask help and report friendly option errors",
    async () => {
      const enabled = {
        ...NO_API_AUTH,
      };

      const help = await runY2(
        ["--add-dir", "/tmp/shared", "ask", "--help"],
        { env: enabled },
      );
      expect(help.code).toBe(0);
      expect(help.stdout.startsWith("y2 ask\n\n")).toBe(true);
      expect(help.stderr).toBe("");

      const missing = await runY2(["--add-dir"], { env: enabled });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("--add-dir requires a directory path");
      expect(missing.stderr).not.toContain("MissingAddDirectoryValue");

      const duplicate = await runY2(
        ["--no-additional-dirs", "--no-additional-dirs"],
        { env: enabled },
      );
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain(
        "--no-additional-dirs may only be specified once",
      );
      expect(duplicate.stderr).not.toContain(
        "DuplicateAdditionalDirectorySuppression",
      );
    },
    TIMEOUT,
  );

  test(
    "workspace commands persist per-primary roots and track availability",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-workspace-access-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const unknown = join(root, "unknown");
        const missing = join(root, "missing");
        mkdirSync(join(home, ".y2"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".y2"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(unknown);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const unknownRoot = realpathSync(unknown);
        const baseEnv = {
          ...NO_API_AUTH,
          HOME: realpathSync(home),
        };

        const added = await runY2(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(added.code).toBe(0);
        const addedJson = JSON.parse(added.stdout.trim());
        expect(addedJson).toMatchObject({
          kind: "workspace",
          action: "add",
          changed: true,
          limit: 16,
          path: sharedRoot,
        });
        expect(addedJson.additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: true,
            active: true,
          },
        ]);

        const stored = JSON.parse(
          readFileSync(join(home, ".y2", "settings.json"), "utf8"),
        );
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          sharedRoot,
        ]);

        for (const path of [unknownRoot, missing]) {
          const unknownRemoval = await runY2(
            ["workspace", "remove", path, "--json"],
            { cwd: workspaceRoot, env: baseEnv },
          );
          expect(unknownRemoval.code).toBe(1);
          expect(JSON.parse(unknownRemoval.stdout.trim())).toEqual({
            kind: "workspace",
            error: "directory is not configured as an additional workspace",
            code: "UnknownAdditionalDirectory",
          });
        }

        const removed = await runY2(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removed.code).toBe(0);
        expect(JSON.parse(removed.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          launch_flag_can_restore: false,
          additional_directories: [],
        });

        const readded = await runY2(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(readded.code).toBe(0);

        const active = await runY2(["workspace", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(active.code).toBe(0);
        expect(JSON.parse(active.stdout.trim())).toMatchObject({
          action: "list",
          changed: false,
          additional_directories: [{ path: sharedRoot, active: true }],
        });

        rmSync(sharedRoot, { recursive: true, force: true });
        const unavailable = await runY2(["workspace", "list", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(unavailable.code).toBe(0);
        expect(JSON.parse(unavailable.stdout.trim()).additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: false,
            active: false,
          },
        ]);

        const unavailableRemoved = await runY2(
          ["workspace", "remove", `${sharedRoot}${sep}`, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unavailableRemoved.code).toBe(0);
        expect(JSON.parse(unavailableRemoved.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        const removedSettings = JSON.parse(
          readFileSync(join(home, ".y2", "settings.json"), "utf8"),
        );
        expect(
          removedSettings.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        mkdirSync(sharedRoot);
        const restored = await runY2(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(restored.code).toBe(0);

        const cleared = await runY2(["workspace", "clear", "--json"], {
          cwd: workspaceRoot,
          env: baseEnv,
        });
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout.trim())).toMatchObject({
          action: "clear",
          changed: true,
          additional_directories: [],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "workspace commands mutate persisted aliases by workspace identity",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "y2-workspace-alias-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const sharedLink = join(root, "shared-link");
        const missing = join(root, "missing");
        const realParent = join(root, "real-parent");
        const parentLink = join(root, "parent-link");
        mkdirSync(join(home, ".y2"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".y2"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(realParent);
        symlinkSync(shared, sharedLink, "dir");
        symlinkSync(realParent, parentLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const settingsPath = join(home, ".y2", "settings.json");
        const baseEnv = {
          ...NO_API_AUTH,
          HOME: realpathSync(home),
        };

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${sharedRoot}${sep}.`,
                  sharedLink,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        const unchanged = await runY2(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unchanged.code).toBe(0);
        expect(JSON.parse(unchanged.stdout.trim())).toMatchObject({
          action: "add",
          changed: true,
          saved_changed: true,
          runtime_changed: false,
        });

        const removedAvailable = await runY2(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedAvailable.code).toBe(0);
        expect(JSON.parse(removedAvailable.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        let stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${missing}${sep}.`,
                  join(missing, "child", ".."),
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedUnavailable = await runY2(
          ["workspace", "remove", missing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedUnavailable.code).toBe(0);
        expect(JSON.parse(removedUnavailable.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        const realMissing = join(realParent, "missing");
        const linkedMissing = join(parentLink, "missing");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [realMissing, linkedMissing],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedLinkedPrefix = await runY2(
          ["workspace", "remove", linkedMissing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedLinkedPrefix.code).toBe(0);
        expect(JSON.parse(removedLinkedPrefix.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
