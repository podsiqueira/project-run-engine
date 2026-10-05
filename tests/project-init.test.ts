// packages/project-run-engine/tests/project-init.test.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  runProjectInit,
  inferProjectName,
  resolveTemplatesDir,
  type ProjectInitResult,
} from "../src/project/bootstrap.js";
import { validateProjectConfig } from "../src/project/project-config.js";
import { runProjectDoctor } from "../src/project/doctor.js";
import { main } from "../src/cli/project-run-cli.js";

describe("Project Bootstrap & Initialization (project-run init)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-run-init-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("1. Directory Structure & File Creation", () => {
    it("creates .project-run/config.json and .agents/skills/ in a clean repository", async () => {
      const result = await runProjectInit({
        projectRoot: tmpDir,
        name: "test-service",
      });

      expect(result.success).toBe(true);
      expect(result.projectName).toBe("test-service");
      expect(result.configCreated).toBe(true);
      expect(fs.existsSync(result.configPath)).toBe(true);

      // Validate created config with official schema validator
      const configContent = fs.readFileSync(result.configPath, "utf8");
      const parsedConfig = JSON.parse(configContent);
      const validation = validateProjectConfig(parsedConfig);
      expect(validation.valid).toBe(true);
      expect(parsedConfig.project.name).toBe("test-service");
      expect(parsedConfig.project.workflow_version).toBe("v1");

      // Verify skills were scaffolded
      const skillsDir = path.join(tmpDir, ".agents", "skills");
      expect(fs.existsSync(skillsDir)).toBe(true);

      const requiredSkills = [
        "speckit-specify",
        "speckit-clarify",
        "speckit-plan",
        "speckit-tasks",
        "speckit-analyze",
        "speckit-implement",
        "speckit-bug-assess",
        "speckit-bug-fix",
        "speckit-bug-test",
        "speckit-converge",
      ];

      for (const skillId of requiredSkills) {
        const skillFile = path.join(skillsDir, skillId, "SKILL.md");
        expect(fs.existsSync(skillFile)).toBe(true);
        const content = fs.readFileSync(skillFile, "utf8");
        expect(content).toMatch(new RegExp(`name:\\s*"?${skillId}"?`));
      }
    });

    it("passes project doctor immediately after initialization", async () => {
      const initResult = await runProjectInit({
        projectRoot: tmpDir,
        name: "healthy-consumer",
      });
      expect(initResult.success).toBe(true);

      const doctorReport = await runProjectDoctor({ projectRoot: tmpDir });
      expect(doctorReport.overallStatus).toBe("HEALTHY");
      expect(doctorReport.issues).toHaveLength(0);
      expect(doctorReport.project.configValid).toBe(true);
      expect(doctorReport.roles.every((r) => r.status === "HEALTHY")).toBe(true);
    });
  });

  describe("2. Project Name Inference", () => {
    it("uses explicit name when provided", () => {
      const name = inferProjectName(tmpDir, "custom-name");
      expect(name).toBe("custom-name");
    });

    it("infers project name from package.json if present", () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "package-json-service" }),
        "utf8",
      );

      const name = inferProjectName(tmpDir);
      expect(name).toBe("package-json-service");
    });

    it("falls back to directory basename when no package.json exists", () => {
      const name = inferProjectName(tmpDir);
      expect(name).toBe(path.basename(tmpDir));
      expect(name).not.toBe("incito");
    });
  });

  describe("3. Idempotency & Repeat Executions", () => {
    it("is strictly idempotent when executed repeatedly", async () => {
      // First run: installs fresh
      const firstRun = await runProjectInit({
        projectRoot: tmpDir,
        name: "idempotent-app",
      });
      expect(firstRun.success).toBe(true);
      expect(firstRun.configCreated).toBe(true);
      expect(firstRun.skillsInstalled.every((s) => s.status === "INSTALLED")).toBe(true);

      // Second run: preserves identical files
      const secondRun = await runProjectInit({
        projectRoot: tmpDir,
        name: "idempotent-app",
      });
      expect(secondRun.success).toBe(true);
      expect(secondRun.configCreated).toBe(false);
      expect(secondRun.conflicts).toHaveLength(0);
      expect(secondRun.skillsInstalled.every((s) => s.status === "ALREADY_EXISTS")).toBe(true);

      // Third run: still identical
      const thirdRun = await runProjectInit({
        projectRoot: tmpDir,
        name: "idempotent-app",
      });
      expect(thirdRun.success).toBe(true);
      expect(thirdRun.conflicts).toHaveLength(0);
    });
  });

  describe("4. Non-Destructive Conflict Safety", () => {
    it("refuses to overwrite modified skill without --force and returns failure", async () => {
      // 1. Initialize
      await runProjectInit({ projectRoot: tmpDir });

      // 2. Modify a skill
      const specifySkillPath = path.join(tmpDir, ".agents", "skills", "speckit-specify", "SKILL.md");
      fs.writeFileSync(specifySkillPath, "---\nname: \"speckit-specify\"\n---\n# Custom user prompt\n", "utf8");

      // 3. Re-run without force
      const conflictRun = await runProjectInit({ projectRoot: tmpDir });
      expect(conflictRun.success).toBe(false);
      expect(conflictRun.conflicts).toContain("speckit-specify");

      // Assert custom content was NOT overwritten
      const preservedContent = fs.readFileSync(specifySkillPath, "utf8");
      expect(preservedContent).toBe("---\nname: \"speckit-specify\"\n---\n# Custom user prompt\n");

      // 4. Re-run with --force
      const forcedRun = await runProjectInit({ projectRoot: tmpDir, force: true });
      expect(forcedRun.success).toBe(true);
      expect(forcedRun.conflicts).toHaveLength(0);

      // Assert canonical template was restored
      const overwrittenContent = fs.readFileSync(specifySkillPath, "utf8");
      expect(overwrittenContent).not.toBe("---\nname: \"speckit-specify\"\n---\n# Custom user prompt\n");
      expect(overwrittenContent).toContain("Create or update the feature specification");
    });
  });

  describe("5. Offline & Zero-Dependency Invariant", () => {
    it("resolves bundled templates locally from filesystem without network", () => {
      const templatesDir = resolveTemplatesDir();
      expect(fs.existsSync(templatesDir)).toBe(true);
      expect(fs.existsSync(path.join(templatesDir, "skills"))).toBe(true);
    });
  });

  describe("6. CLI Entry Point Integration (main)", () => {
    it("executes project-run init through CLI main runner with exit code 0", async () => {
      const exitCode = await main(["init", "--dir", tmpDir, "--name", "cli-tested-app"]);
      expect(exitCode).toBe(0);

      expect(fs.existsSync(path.join(tmpDir, ".project-run", "config.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".agents", "skills", "speckit-specify", "SKILL.md"))).toBe(true);
    });

    it("returns exit code 1 when conflict occurs without --force", async () => {
      // First run: success
      await main(["init", "--dir", tmpDir]);

      // Introduce conflict
      const planSkillPath = path.join(tmpDir, ".agents", "skills", "speckit-plan", "SKILL.md");
      fs.writeFileSync(planSkillPath, "# Custom local modification\n", "utf8");

      // Second run without force: returns 1
      const conflictCode = await main(["init", "--dir", tmpDir]);
      expect(conflictCode).toBe(1);

      // Third run with --force: returns 0
      const forceCode = await main(["init", "--dir", tmpDir, "--force"]);
      expect(forceCode).toBe(0);
    });
  });
});
