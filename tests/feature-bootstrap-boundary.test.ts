// packages/project-run-engine/tests/feature-bootstrap-boundary.test.ts
//
// ENG-001 / ENG-003 — the engine/host ownership boundary for feature identity.
//
// Disposition (see docs/backlog.md and ARCHITECTURE.md §4.16): the HOST/consumer owns
// creating a brand-new feature's workspace; the ENGINE owns discovering it and keeping
// three identities distinct — feature, execution id, and git branch. These tests pin
// that boundary rather than any particular host's bootstrap behavior.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverFeature } from "../src/project/context-discovery.js";
import { nextProjectRunStep } from "../src/host/project-run-step.js";
import { FileExecutionStateStore } from "../src/project/state-store.js";
import { runProjectInit } from "../src/project/bootstrap.js";

const FEATURE = "007-lifecycle-smoke-test";
const BRANCH = "tmp/project-run-lifecycle-smoke";

describe("ENG-001 — the engine discovers features; the host creates them", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-bootstrap-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), `ref: refs/heads/${BRANCH}\n`, "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("an explicitly named feature with no directory fails with an actionable reason and creates nothing", () => {
    const result = discoverFeature(tmpDir, { explicitFeature: FEATURE, branch: BRANCH });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("FEATURE_NOT_DISCOVERED");
    expect(result.reason).toContain(`specs/${FEATURE}`);
    expect(result.reason).toContain("never creates feature directories");
    expect(result.reason).toContain("host/consumer must create");

    expect(fs.existsSync(path.join(tmpDir, "specs"))).toBe(false);
  });

  it("nextProjectRunStep for a new feature returns FAILED without creating the workspace or an execution record; once the host seeds it, the same call starts SPECIFY", async () => {
    const first = await nextProjectRunStep({ projectRoot: tmpDir, feature: FEATURE, executionId: "exec-bootstrap" });

    expect(first.status).toBe("FAILED");
    if (first.status !== "FAILED") return;
    expect(first.failureReason).toContain("FEATURE_NOT_DISCOVERED");
    expect(fs.existsSync(path.join(tmpDir, "specs"))).toBe(false);
    expect(await new FileExecutionStateStore(tmpDir).exists("exec-bootstrap")).toBe(false);

    // The host (or the specify step) seeds the feature workspace, then retries.
    fs.mkdirSync(path.join(tmpDir, "specs", FEATURE), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "specs", FEATURE, ".keep"), "", "utf8");

    const second = await nextProjectRunStep({ projectRoot: tmpDir, feature: FEATURE, executionId: "exec-bootstrap" });
    expect(second.status).toBe("AGENT_ACTION_REQUIRED");
    if (second.status !== "AGENT_ACTION_REQUIRED") return;
    expect(second.request.role).toBe("SPECIFICATION");
    expect(second.request.state).toBe("SPECIFY");
  });

  it("a branch whose name is not a feature directory does not auto-discover a feature (by design)", () => {
    fs.mkdirSync(path.join(tmpDir, "specs", FEATURE), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "specs", "008-other"), { recursive: true });

    const result = discoverFeature(tmpDir, { branch: BRANCH });
    expect(result.success).toBe(false);
  });
});

describe("ENG-003 — the engine keeps feature, execution and branch identities distinct", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-"));
    await runProjectInit({ projectRoot: tmpDir, silent: true });
    fs.mkdirSync(path.join(tmpDir, "specs", FEATURE), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "HEAD"), `ref: refs/heads/${BRANCH}\n`, "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists the real git branch separately from the feature name and the execution id, and never forces them to match", async () => {
    const executionId = "exec-1791412982780-58use";
    const response = await nextProjectRunStep({ projectRoot: tmpDir, feature: FEATURE, executionId });
    expect(response.status).toBe("AGENT_ACTION_REQUIRED");
    if (response.status !== "AGENT_ACTION_REQUIRED") return;

    const persisted = await new FileExecutionStateStore(tmpDir).load(executionId);
    expect(persisted?.feature).toBe(FEATURE);
    expect(persisted?.branch).toBe(BRANCH);
    expect(persisted?.execution_id).toBe(executionId);

    expect(response.request.feature).toBe(FEATURE);
    expect(response.request.branch).toBe(BRANCH);
    expect(response.request.execution_id).toBe(executionId);
  });
});
