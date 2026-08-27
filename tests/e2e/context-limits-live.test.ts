import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HAS_API_KEY, runY2 } from "../evals/eval-helpers";

const LIVE_ENABLED = process.env.Y2_E2E_REAL_API === "1";
const TIMEOUT = 180_000;
const MODEL = "openai/gpt-5";

describe.skipIf(!LIVE_ENABLED || !HAS_API_KEY)("live source context limits", () => {
  test(
    "fresh binary sends a bounded real Gateway request and returns normally",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "y2-context-limits-live-")));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const skillDirectory = join(
        workspace,
        ".agents",
        "skills",
        "live-context-probe",
      );
      const tracePath = join(root, "trace.log");
      mkdirSync(join(home, ".y2"), { recursive: true });
      mkdirSync(skillDirectory, { recursive: true });
      writeFileSync(
        join(home, ".y2", "settings.json"),
        JSON.stringify({
          model: MODEL,
          context_limits: { skill_description_bytes: 16 },
        }),
      );
      writeFileSync(
        join(workspace, "AGENTS.md"),
        "LIVE_PROJECT_PREFIX\nLIVE_PROJECT_SECOND\nLIVE_PROJECT_TAIL_SENTINEL\n",
      );
      writeFileSync(
        join(skillDirectory, "SKILL.md"),
        `---\nname: live-context-probe\ndescription: ${"live-description-".repeat(10)}\n---\n\nAnswer the user briefly.\n${"live-skill-line\n".repeat(16)}LIVE_SKILL_TAIL_SENTINEL\n`,
      );

      try {
        const result = await runY2(
          [
            "--context-limit",
            "project_instruction_file_bytes=32",
            "--context-limit",
            "skill_chunk_bytes=240",
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "--timeout",
            String(TIMEOUT),
            "$live-context-probe Reply with exactly LIVE_CONTEXT_LIMIT_OK and do not use tools.",
          ],
          {
            cwd: workspace,
            env: {
              HOME: home,
              Y2_MODEL: MODEL,
              Y2_AUTO_UPGRADE: "0",
              OPENAI_BASE_URL: undefined,
              Y2_API_CHAT_URL: undefined,
              Y2_TRACE_LOG: tracePath,
              Y2_TRACE_SCOPES: "agent,gateway,stream",
            },
            timeoutMs: TIMEOUT,
          },
        );
        if (result.code !== 0) {
          throw new Error(
            `live context-limit request failed\nstdout: ${result.stdout.slice(-4000)}\nstderr: ${result.stderr.slice(0, 8000)}`,
          );
        }

        const json = JSON.parse(result.stdout.trim()) as {
          output: string;
          exit_code: number;
          model: string;
        };
        const trace = readFileSync(tracePath, "utf8");
        expect(json.exit_code).toBe(0);
        expect(json.model).toBe(MODEL);
        expect(json.output.length).toBeGreaterThan(0);
        expect(result.stderr).toContain("project instruction file");
        expect(result.stderr).toContain("skill description");
        expect(result.stderr).toContain("skill resource");
        expect(result.stderr).toContain("source=command line");
        expect(trace).toContain("event=request_built");
        expect(trace).toContain("event=prompt_finish");
        expect(trace).toContain("outcome_kind=assistant");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
