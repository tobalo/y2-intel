import { describe, expect, test } from "bun:test";
import { buildEvalProcessEnv, shouldLoadDotEnv } from "./eval-helpers";

describe("eval helpers", () => {
  test("passes the selected eval model to y2 through Y2_MODEL", () => {
    const previous = process.env.Y2_MODEL;
    process.env.Y2_MODEL = "ambient/model";

    try {
      const env = buildEvalProcessEnv("/tmp/y2-eval-home-test", "selected/model");

      expect(env.Y2_MODEL).toBe("selected/model");
      expect(env.HOME).toBe("/tmp/y2-eval-home-test");
      expect(env.NO_COLOR).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env.Y2_MODEL;
      } else {
        process.env.Y2_MODEL = previous;
      }
    }
  });

  test("does not load repository dotenv files in a hermetic run", () => {
    expect(shouldLoadDotEnv({ Y2_E2E_DISABLE_DOTENV: "1" })).toBe(false);
    expect(shouldLoadDotEnv({})).toBe(true);
  });
});
