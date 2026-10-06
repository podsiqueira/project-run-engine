// packages/project-run-engine/tests/config-skill-requirement-precedence.test.ts
//
// MEDIUM finding (Phase 2/3): `.project-run/config.json`'s `required_skills[].required:
// false` did not actually override the hardcoded SpecKitV1Preset's skill requirements,
// because AgentDispatcher.dispatch() validated against `request.skills` (preset-derived,
// populated by the decision engine) before ever consulting `definition.skills`
// (config-derived, from the registry). A config explicitly marking a skill optional
// would still fail dispatch with a missing-skill error if the preset marked it required.
//
// Fixed in src/agents/agent-dispatcher.ts by preferring the registry definition's
// skills over the preset-derived request skills. This suite proves a genuinely missing
// skill, marked `required: false` in config, no longer blocks dispatch — without
// relying on `runProjectInit` to paper over the issue by installing the skill anyway.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { executeProjectRun } from "../src/project/project-run.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { MockRuntimeAdapter } from "../src/runtime/mock-runtime-adapter.js";

describe("Phase 3 Closure — config required:false overrides the preset's default requirement", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-precedence-"));

    // Deliberately do NOT run `project-run init` — no skills exist on disk anywhere.
    const configDir = path.join(tmpDir, ".project-run");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          project: { name: "svc", workflow_version: "v1", feature_directory: "specs/feat" },
          runtime: { default_runtime: "MOCK", supported_runtimes: ["MOCK"] },
          agents: {
            // speckit-specify is required:true in the hardcoded SpecKitV1Preset, but
            // this config explicitly marks it optional for this project.
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
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dispatches SPECIFICATION:SPECIFY successfully with zero skills on disk, because config marks speckit-specify optional", async () => {
    const dispatchedRoles: string[] = [];
    const adapter = new MockRuntimeAdapter((req) => {
      dispatchedRoles.push(`${req.role}:${req.state}`);
      return { execution_id: req.execution_id, agent: req.role, state: req.state, status: "PASS", evidence: [], findings: [] };
    });

    const result = await executeProjectRun({
      projectRoot: tmpDir,
      runtime: "MOCK",
      stateStore: new FileExecutionStateStore(tmpDir),
      adapters: [adapter],
      context: { state: "INTAKE", runtime: "MOCK" },
    });

    // Before the fix: BLOCKED_MISSING_SKILLS the moment SPECIFICATION:SPECIFY was
    // dispatched, because AgentDispatcher validated against the preset's
    // required:true for speckit-specify, ignoring the config's required:false.
    expect(result.status).toBe("COMPLETED");
    expect(dispatchedRoles).toContain("SPECIFICATION:SPECIFY");
  });
});
