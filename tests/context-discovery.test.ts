import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  discoverGitBranch,
  discoverFeature,
  discoverProjectContext,
} from "../src/project/context-discovery.js";

describe("G-1: Context Auto-Discovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-discovery-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Git Branch Discovery", () => {
    it("detects current git branch from standard .git/HEAD", () => {
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(
        path.join(gitDir, "HEAD"),
        "ref: refs/heads/feat/payment-gateway\n",
        "utf8",
      );

      const result = discoverGitBranch(tmpDir);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.branch).toBe("feat/payment-gateway");
      }
    });

    it("detects git branch from detached HEAD sha", () => {
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(gitDir, { recursive: true });
      const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
      fs.writeFileSync(path.join(gitDir, "HEAD"), `${sha}\n`, "utf8");

      const result = discoverGitBranch(tmpDir);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.branch).toBe(sha);
      }
    });

    it("detects branch in git worktree via .git pointer file", () => {
      const commonGitDir = path.join(tmpDir, "commondir");
      fs.mkdirSync(commonGitDir, { recursive: true });
      fs.writeFileSync(
        path.join(commonGitDir, "HEAD"),
        "ref: refs/heads/fix/security-audit\n",
        "utf8",
      );

      const worktreeDir = path.join(tmpDir, "worktree");
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(worktreeDir, ".git"),
        `gitdir: ${commonGitDir}\n`,
        "utf8",
      );

      const result = discoverGitBranch(worktreeDir);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.branch).toBe("fix/security-audit");
      }
    });

    it("fails deterministically when directory is not inside a git repository", () => {
      const result = discoverGitBranch(tmpDir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("PROJECT_NOT_GIT_REPOSITORY");
        expect(result.reason).toContain("not inside a git repository");
      }
    });
  });

  describe("Feature Discovery", () => {
    it("detects feature from explicit feature option", () => {
      const specsDir = path.join(tmpDir, "specs", "billing-service");
      fs.mkdirSync(specsDir, { recursive: true });

      const result = discoverFeature(tmpDir, {
        explicitFeature: "billing-service",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.feature).toBe("billing-service");
        expect(result.featureDirectory).toBe(path.join("specs", "billing-service"));
      }
    });

    it("matches feature from active git branch with standard prefix stripped", () => {
      const specsDir = path.join(tmpDir, "specs", "005-lead-scoring");
      fs.mkdirSync(specsDir, { recursive: true });

      const result = discoverFeature(tmpDir, {
        branch: "feat/005-lead-scoring",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.feature).toBe("005-lead-scoring");
      }
    });

    it("detects feature when single feature exists in specs/ directory", () => {
      const specsDir = path.join(tmpDir, "specs", "user-onboarding");
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(path.join(specsDir, "spec.md"), "# Spec\n", "utf8");

      const result = discoverFeature(tmpDir);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.feature).toBe("user-onboarding");
      }
    });

    it("fails deterministically when multiple feature specifications exist and branch does not match", () => {
      fs.mkdirSync(path.join(tmpDir, "specs", "feature-a"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "specs", "feature-b"), { recursive: true });

      const result = discoverFeature(tmpDir, {
        branch: "main",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("FEATURE_NOT_DISCOVERED");
        expect(result.reason).toContain("Multiple feature specifications found in specs/");
      }
    });

    it("does not fabricate context if no specs directory exists", () => {
      const result = discoverFeature(tmpDir, {
        branch: "feat/unknown",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("FEATURE_NOT_DISCOVERED");
      }
    });
  });

  describe("Combined Context Auto-Discovery (discoverProjectContext)", () => {
    it("discovers both branch and feature in clean consumer repo outside Incito naming", () => {
      // Set up git repo
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(
        path.join(gitDir, "HEAD"),
        "ref: refs/heads/feature/customer-crm\n",
        "utf8",
      );

      // Set up specs
      const specDir = path.join(tmpDir, "specs", "customer-crm");
      fs.mkdirSync(specDir, { recursive: true });
      fs.writeFileSync(path.join(specDir, "spec.md"), "# CRM Spec\n", "utf8");

      const result = discoverProjectContext({
        projectRoot: tmpDir,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.context.branch).toBe("feature/customer-crm");
        expect(result.context.feature).toBe("customer-crm");
        expect(result.context.projectRoot).toBe(path.resolve(tmpDir));
      }
    });
  });
});
