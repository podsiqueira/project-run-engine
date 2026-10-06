// packages/project-run-engine/tests/cli-engine-step-transport.test.ts
//
// Phase 3 Closure — `project-run engine next-step|submit-step`: the pull-based step
// API exposed through the same JSON CLI transport `start/resume/status` already use.
// Exercises the REAL CLI argument parsing (`main()`) against the real
// `nextProjectRunStep`/`submitProjectRunStep` functions — no mock adapter is involved
// at all here, since pull-mode never needs one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { main } from "../src/cli/project-run-cli.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import type { ProjectRunStepResponse } from "../src/host/step-types.js";

function writeConfig(tmpDir: string): void {
  const configDir = path.join(tmpDir, ".project-run");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(
      {
        project: { name: "svc", workflow_version: "v1", feature_directory: "specs/feat" },
        runtime: { default_runtime: "MOCK", supported_runtimes: ["MOCK"] },
        agents: {
          SPECIFICATION: { name: "Spec", required_skills: [{ id: "speckit-specify", required: false }] },
          ARCHITECTURE: { name: "Arch", required_skills: [{ id: "speckit-plan", required: false }] },
          IMPLEMENTATION: { name: "Impl", required_skills: [{ id: "speckit-implement", required: false }] },
          INDEPENDENT_REVIEW: { name: "Rev", required_skills: [{ id: "speckit-analyze", required: false }] },
          REMEDIATION: { name: "Rem", required_skills: [{ id: "speckit-bug-fix", required: false }] },
          CONVERGENCE: { name: "Conv", required_skills: [{ id: "speckit-converge", required: false }] },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.mkdirSync(path.join(tmpDir, "specs", "feat"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "specs", "feat", "spec.md"), "# Feature\n", "utf8");
  fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/feat/feat\n", "utf8");
}

describe("Phase 3 Closure — `project-run engine next-step`/`submit-step` CLI transport", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-engine-step-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    writeConfig(tmpDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function lastJsonLine(): ProjectRunStepResponse {
    const line = logSpy.mock.calls[logSpy.mock.calls.length - 1][0] as string;
    return JSON.parse(line);
  }

  it('"engine next-step" starting fresh returns AGENT_ACTION_REQUIRED for SPECIFICATION:SPECIFY, no adapter involved', async () => {
    const code = await main([
      "engine",
      "next-step",
      "--json",
      JSON.stringify({ executionId: "exec-cli-step-1", runtime: "MOCK" }),
      "--dir",
      tmpDir,
    ]);

    expect(code).toBe(0);
    const response = lastJsonLine();
    expect(response.status).toBe("AGENT_ACTION_REQUIRED");
    if (response.status === "AGENT_ACTION_REQUIRED") {
      expect(response.request.role).toBe("SPECIFICATION");
      expect(response.request.state).toBe("SPECIFY");
    }
  });

  it('"engine submit-step" accepts the result and advances to the next action, via the real CLI argument parsing', async () => {
    const executionId = "exec-cli-step-2";

    const startCode = await main(["engine", "next-step", "--json", JSON.stringify({ executionId, runtime: "MOCK" }), "--dir", tmpDir]);
    expect(startCode).toBe(0);
    const first = lastJsonLine();
    expect(first.status).toBe("AGENT_ACTION_REQUIRED");
    if (first.status !== "AGENT_ACTION_REQUIRED") return;

    const submitCode = await main([
      "engine",
      "submit-step",
      "--json",
      JSON.stringify({
        executionId,
        stepId: first.stepId,
        result: {
          execution_id: first.request.execution_id,
          agent: first.request.role,
          state: first.request.state,
          status: "PASS",
          evidence: [],
          findings: [],
        },
      }),
      "--dir",
      tmpDir,
    ]);

    expect(submitCode).toBe(0);
    const second = lastJsonLine();
    expect(second.status).toBe("AGENT_ACTION_REQUIRED");
    if (second.status === "AGENT_ACTION_REQUIRED") {
      expect(second.request.state).toBe("CLARIFY");
    }
  });

  it('"engine submit-step" with a stale stepId is rejected via the printed JSON, CLI exit code still 0', async () => {
    const executionId = "exec-cli-step-stale";
    await main(["engine", "next-step", "--json", JSON.stringify({ executionId, runtime: "MOCK" }), "--dir", tmpDir]);

    const code = await main([
      "engine",
      "submit-step",
      "--json",
      JSON.stringify({
        executionId,
        stepId: "not-the-real-step-id",
        result: { execution_id: executionId, agent: "SPECIFICATION", state: "SPECIFY", status: "PASS", evidence: [], findings: [] },
      }),
      "--dir",
      tmpDir,
    ]);

    expect(code).toBe(0);
    const response = lastJsonLine();
    expect(response.status).toBe("FAILED");
    if (response.status === "FAILED") {
      expect(response.failureReason).toContain("STALE_STEP");
    }
  });

  it('"engine next-step" without --json exits 1 with a usage error', async () => {
    const code = await main(["engine", "next-step", "--dir", tmpDir]);
    expect(code).toBe(1);
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("--json");
  });
});
