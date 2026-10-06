// packages/project-run-engine/tests/cli-engine-json-transport.test.ts
//
// Phase 3 — `project-run engine <start|resume|status>`: the JSON transport for hosts
// that cannot import TypeScript/JS (an interactive coding-agent Skill/tool whose only
// extension mechanism is running a local command and parsing structured output).
//
// Exercises the REAL CLI argument parsing (`main()`) end-to-end against the real
// `projectEngineRun` capability. The only thing not real is the dispatched agent's
// work itself (`--mock-scenario`, explicitly documented as demo/test-only) — exactly
// the one boundary every prior phase's tests have also mocked, and no more.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { main } from "../src/cli/project-run-cli.js";
import { runProjectInit } from "../src/project/bootstrap.js";
import type { ProjectRunHostResponse } from "../src/host/types.js";

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

describe("Phase 3 — `project-run engine` JSON transport", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-engine-"));
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

  function lastJsonLine(): ProjectRunHostResponse {
    const line = logSpy.mock.calls[logSpy.mock.calls.length - 1][0] as string;
    return JSON.parse(line);
  }

  it('"engine start" with --mock-scenario clean prints a single JSON line and reaches COMPLETED, exit 0', async () => {
    const code = await main([
      "engine",
      "start",
      "--json",
      JSON.stringify({ executionId: "exec-engine-clean", runtime: "MOCK" }),
      "--mock-scenario",
      "clean",
      "--dir",
      tmpDir,
    ]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const response = lastJsonLine();
    expect(response.status).toBe("COMPLETED");
    expect(response.terminal).toBe(true);
    expect(response.executionId).toBe("exec-engine-clean");
  });

  it('full lifecycle: "engine start" with --mock-scenario clarify-blocked -> HUMAN_INTERVENTION_REQUIRED with machine-readable questions -> "engine resume" -> COMPLETED', async () => {
    const executionId = "exec-engine-lifecycle";

    const startCode = await main([
      "engine",
      "start",
      "--json",
      JSON.stringify({ executionId, runtime: "MOCK" }),
      "--mock-scenario",
      "clarify-blocked",
      "--dir",
      tmpDir,
    ]);
    expect(startCode).toBe(0);

    const startResponse = lastJsonLine();
    expect(startResponse.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(startResponse.terminal).toBe(false);
    expect(startResponse.humanIntervention?.suspendedFrom).toBe("CLARIFY");
    expect(startResponse.humanIntervention?.questions).toHaveLength(1);
    const questionId = startResponse.humanIntervention!.questions[0].id;
    expect(questionId).toBe("DEMO-AMB-1");

    // The host (e.g. a Claude Code skill) would render this question, collect an
    // answer, and call "engine resume" with it — exercised here exactly as a real
    // host would, through the same CLI argument parsing.
    const resumeCode = await main([
      "engine",
      "resume",
      "--json",
      JSON.stringify({ executionId, humanAnswers: [{ questionId, answer: "Option A" }] }),
      "--mock-scenario",
      "clean",
      "--dir",
      tmpDir,
    ]);
    expect(resumeCode).toBe(0);

    const resumeResponse = lastJsonLine();
    expect(resumeResponse.status).toBe("COMPLETED");
    expect(resumeResponse.terminal).toBe(true);
  });

  it('"engine status" reads back a suspended execution\'s state as a single JSON line, exit 0 (never advances it)', async () => {
    const executionId = "exec-engine-status";

    await main([
      "engine",
      "start",
      "--json",
      JSON.stringify({ executionId, runtime: "MOCK" }),
      "--mock-scenario",
      "clarify-blocked",
      "--dir",
      tmpDir,
    ]);

    const statusCode = await main(["engine", "status", "--json", JSON.stringify({ executionId }), "--dir", tmpDir]);
    expect(statusCode).toBe(0);

    const statusResponse = lastJsonLine();
    expect(statusResponse.status).toBe("HUMAN_INTERVENTION_REQUIRED");
    expect(statusResponse.humanIntervention?.questions[0].id).toBe("DEMO-AMB-1");
  });

  it('a FAILED workflow outcome is still reported via the printed JSON with exit 0 — CLI exit code never encodes workflow outcome', async () => {
    // No --mock-scenario -> no adapter wired -> dispatch fails with "No runtime
    // adapter registered", which surfaces as a FAILED ProjectRunHostResponse, not a
    // CLI-level usage error.
    const code = await main([
      "engine",
      "start",
      "--json",
      JSON.stringify({ executionId: "exec-engine-no-adapter", runtime: "MOCK" }),
      "--dir",
      tmpDir,
    ]);

    expect(code).toBe(0);
    const response = lastJsonLine();
    expect(response.status).toBe("FAILED");
    expect(response.failureReason).toContain("No runtime adapter registered");
  });

  it('"engine" without a valid action exits 1 with a usage error (CLI-level failure, not a workflow outcome)', async () => {
    const code = await main(["engine", "--json", "{}", "--dir", tmpDir]);
    expect(code).toBe(1);
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("requires an action");
  });

  it('"engine start" without --json exits 1 with a usage error', async () => {
    const code = await main(["engine", "start", "--dir", tmpDir]);
    expect(code).toBe(1);
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("--json");
  });

  it('"engine start" with malformed JSON exits 1 with a usage error, not a crash', async () => {
    const code = await main(["engine", "start", "--json", "{not valid json", "--dir", tmpDir]);
    expect(code).toBe(1);
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("not valid JSON");
  });

  it('"engine status" for an unknown execution id reports FAILED/EXECUTION_NOT_FOUND via JSON, exit 0', async () => {
    const code = await main(["engine", "status", "--json", JSON.stringify({ executionId: "exec-nope" }), "--dir", tmpDir]);
    expect(code).toBe(0);
    const response = lastJsonLine();
    expect(response.status).toBe("FAILED");
    expect(response.failureReason).toContain("EXECUTION_NOT_FOUND");
  });
});
