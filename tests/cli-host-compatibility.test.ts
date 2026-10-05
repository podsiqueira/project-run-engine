// packages/project-run-engine/tests/cli-host-compatibility.test.ts
//
// Phase 1 — CLI becomes an adapter over the host/orchestration API, not the core
// interface. `project-run-cli.ts`'s `run`/`resume` commands were refactored to call
// `startProjectRun`/`resumeProjectRun` (src/host/project-run-host.ts) instead of
// `executeProjectRun`/`executeProjectResume` directly. This suite proves the existing
// CLI behavior (exit codes, stderr/stdout messages) is unchanged by that refactor.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { main } from "../src/cli/project-run-cli.js";
import { FileExecutionStateStore, type PersistedExecutionState } from "../src/project/state-store.js";

describe("Phase 1 — CLI compatibility through the new host/orchestration layer", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-compat-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("`project-run doctor` with no config reports ISSUES_FOUND and exits 1 (unchanged)", async () => {
    const code = await main(["doctor", "--dir", tmpDir]);

    expect(code).toBe(1);
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("ISSUES FOUND");
  });

  it("`project-run` (run) fails with 'No runtime adapter registered' and exits 1 — the bundled CLI never wires a real adapter, and that pre-existing behavior is unchanged by routing through startProjectRun", async () => {
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

    const code = await main(["--dir", tmpDir, "--runtime", "MOCK"]);

    // A fresh run always transitions INTAKE -> SPECIFY before any dispatch is
    // attempted, so it reaches the AgentDispatcher's adapter lookup (not the
    // pre-flight skill guard) first. Since this bundled CLI never supplies a real
    // AgentRuntimeAdapter (a consumer wires its own via the programmatic API — see
    // CONSUMER-GUIDE.md), this failure is pre-existing, expected behavior; the point
    // of this test is that it is IDENTICAL whether `run` calls `startProjectRun`
    // (current) or `executeProjectRun` directly (before this refactor).
    expect(code).toBe(1);
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Project run failed");
    expect(stderr).toContain("No runtime adapter registered for runtime: MOCK");
  });

  it("`project-run resume` into a dispatch-pending state with a missing required skill returns BLOCKED_MISSING_SKILLS and exits 2 (unchanged, now routed through resumeProjectRun)", async () => {
    const configDir = path.join(tmpDir, ".project-run");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          project: { name: "svc", workflow_version: "v1", feature_directory: "specs/feat" },
          runtime: { default_runtime: "MOCK", supported_runtimes: ["MOCK"] },
          agents: {
            SPECIFICATION: { name: "Spec", required_skills: [{ id: "speckit-specify", required: true }] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    // Deliberately no skills on disk anywhere (no `init` run, no search paths).

    const executionId = "exec-cli-missing-skill";
    const stateStore = new FileExecutionStateStore(tmpDir);
    const suspended: PersistedExecutionState = {
      version: 1,
      execution_id: executionId,
      project: "svc",
      feature: "feat",
      branch: "feat/feat",
      state: "HUMAN_INTERVENTION_REQUIRED",
      suspended_from: "CLARIFY",
      lifecycle_status: "HUMAN_INTERVENTION_REQUIRED",
      runtime: "MOCK",
      iteration: 1,
      remediation_iteration: 0,
      preset: "v1",
      findings: [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN" }],
      last_result: {
        execution_id: executionId,
        agent: "SPECIFICATION",
        state: "CLARIFY",
        status: "FINDINGS",
        evidence: [],
        findings: [{ id: "AMB-1", severity: "CRITICAL", status: "OPEN" }],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await stateStore.save(suspended);

    const code = await main(["resume", "--execution-id", executionId, "--dir", tmpDir, "--runtime", "MOCK"]);

    expect(code).toBe(2);
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Missing required skills");
    expect(stderr).toContain("speckit-specify");
  });

  it("`project-run resume --execution-id <unknown>` fails with EXECUTION_NOT_FOUND and exits 1 (unchanged, now routed through resumeProjectRun)", async () => {
    const code = await main(["resume", "--execution-id", "exec-does-not-exist", "--dir", tmpDir]);

    expect(code).toBe(1);
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Project resume failed");
    expect(stderr).toContain("EXECUTION_NOT_FOUND");
  });

  it("`project-run resume` without --execution-id still fails fast with exit 1 before touching the orchestration layer (unchanged)", async () => {
    const code = await main(["resume", "--dir", tmpDir]);

    expect(code).toBe(1);
    const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("--execution-id");
  });
});
