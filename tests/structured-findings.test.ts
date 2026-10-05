import { describe, it, expect } from "vitest";
import {
  CoordinatorDecisionEngine,
  isFindingActionable,
  isFindingBlocking,
  hasActionableFindings,
  hasBlockingFindings,
} from "../src/decision/decision-engine.js";
import type {
  StructuredFinding,
  FindingSeverity,
  FindingStatus,
} from "../src/domain/types.js";
import type { CoordinatorExecutionContext } from "../src/decision/types.js";

describe("G-4: Structured Finding Contract & Decision Engine", () => {
  const engine = new CoordinatorDecisionEngine();

  const baseExecution = {
    id: "exec-find-1",
    feature: "payment-service",
    branch: "feat/payment",
    iteration: 1,
    remediation_iteration: 0,
  };

  describe("isFindingActionable & isFindingBlocking helpers", () => {
    it("recognizes all standard severity levels (CRITICAL, HIGH, MEDIUM, LOW) as actionable and ADVISORY as non-actionable", () => {
      const critical: StructuredFinding = {
        id: "F-1",
        severity: "CRITICAL",
        category: "security",
        evidence: "SQL injection vulnerability detected",
        expected: "Parameterized queries",
        actual: "String interpolation",
        required_remediation: "Use db.prepare",
        status: "OPEN",
      };
      const high: StructuredFinding = { ...critical, id: "F-2", severity: "HIGH" };
      const medium: StructuredFinding = { ...critical, id: "F-3", severity: "MEDIUM" };
      const low: StructuredFinding = { ...critical, id: "F-4", severity: "LOW" };
      const advisory: StructuredFinding = { ...critical, id: "F-5", severity: "ADVISORY" };
      const explicitAdvisory: StructuredFinding = { ...critical, id: "F-6", advisory: true };

      expect(isFindingActionable(critical)).toBe(true);
      expect(isFindingActionable(high)).toBe(true);
      expect(isFindingActionable(medium)).toBe(true);
      expect(isFindingActionable(low)).toBe(true);
      expect(isFindingActionable(advisory)).toBe(false);
      expect(isFindingActionable(explicitAdvisory)).toBe(false);
    });

    it("correctly separates blocking findings (CRITICAL, HIGH, MEDIUM) from non-blocking findings (LOW, ADVISORY)", () => {
      const critical: StructuredFinding = {
        id: "F-1",
        severity: "CRITICAL",
        status: "OPEN",
      };
      const high: StructuredFinding = { ...critical, id: "F-2", severity: "HIGH" };
      const medium: StructuredFinding = { ...critical, id: "F-3", severity: "MEDIUM" };
      const low: StructuredFinding = { ...critical, id: "F-4", severity: "LOW" };
      const explicitBlockingLow: StructuredFinding = {
        ...critical,
        id: "F-4B",
        severity: "LOW",
        blocking: true,
      };
      const advisory: StructuredFinding = { ...critical, id: "F-5", severity: "ADVISORY" };

      expect(isFindingBlocking(critical)).toBe(true);
      expect(isFindingBlocking(high)).toBe(true);
      expect(isFindingBlocking(medium)).toBe(true);
      expect(isFindingBlocking(low)).toBe(false); // LOW is non-blocking by default!
      expect(isFindingBlocking(explicitBlockingLow)).toBe(true); // Contract override respected!
      expect(isFindingBlocking(advisory)).toBe(false);
    });

    it("evaluates status lifecycle (OPEN = actionable; RESOLVED and ACCEPTED = non-actionable and non-blocking)", () => {
      const open: StructuredFinding = {
        id: "F-1",
        severity: "HIGH",
        status: "OPEN",
      };
      const resolved: StructuredFinding = {
        id: "F-1",
        severity: "HIGH",
        status: "RESOLVED",
      };
      const accepted: StructuredFinding = {
        id: "F-1",
        severity: "HIGH",
        status: "ACCEPTED",
      };

      expect(isFindingActionable(open)).toBe(true);
      expect(isFindingActionable(resolved)).toBe(false);
      expect(isFindingActionable(accepted)).toBe(false);

      expect(isFindingBlocking(open)).toBe(true);
      expect(isFindingBlocking(resolved)).toBe(false);
      expect(isFindingBlocking(accepted)).toBe(false);
    });

    it("handles malformed findings gracefully without throwing", () => {
      expect(isFindingActionable(null)).toBe(false);
      expect(isFindingActionable(undefined)).toBe(false);
      expect(isFindingActionable("string-finding")).toBe(false);
      expect(isFindingActionable({})).toBe(true); // Untyped open finding defaults to actionable

      expect(isFindingBlocking(null)).toBe(false);
      expect(isFindingBlocking(undefined)).toBe(false);
      expect(isFindingBlocking("string-finding")).toBe(false);
      expect(isFindingBlocking({})).toBe(true); // Untyped open finding defaults to blocking
    });
  });

  describe("Decision Engine Routing with Structured Findings", () => {
    it("routes INDEPENDENT_REVIEW -> REMEDIATION when OPEN CRITICAL finding exists", () => {
      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "INDEPENDENT_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-SEC-1",
              severity: "CRITICAL",
              category: "security",
              evidence: "Unauthenticated endpoint exposed",
              expected: "Requires Bearer token",
              actual: "Allows anonymous access",
              required_remediation: "Add auth middleware",
              status: "OPEN",
            },
          ],
        },
      };

      const decision = engine.decide(context);
      expect(decision).toEqual({
        action: "TRANSITION",
        from: "INDEPENDENT_REVIEW",
        to: "REMEDIATION",
        reason: "Review findings require remediation",
      });
    });

    it("Case A: routes INDEPENDENT_REVIEW -> CONVERGE when only an open LOW finding exists (non-blocking)", () => {
      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "INDEPENDENT_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-LOW-1",
              severity: "LOW",
              category: "style",
              evidence: "Minor formatting inconsistency in header",
              expected: "Standard header spacing",
              actual: "Extra whitespace",
              required_remediation: "Run formatter",
              status: "OPEN",
            },
          ],
        },
      };

      const decision = engine.decide(context);
      expect(decision).toEqual({
        action: "TRANSITION",
        from: "INDEPENDENT_REVIEW",
        to: "CONVERGE",
        reason: "Independent review passed",
      });
    });

    it("Case B: routes INDEPENDENT_REVIEW -> REMEDIATION when open MEDIUM finding exists (blocking)", () => {
      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "INDEPENDENT_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-MED-1",
              severity: "MEDIUM",
              category: "validation",
              evidence: "Missing phone number format validation",
              expected: "E.164 validation regex",
              actual: "Unchecked string",
              required_remediation: "Add validation helper",
              status: "OPEN",
            },
          ],
        },
      };

      const decision = engine.decide(context);
      expect(decision).toEqual({
        action: "TRANSITION",
        from: "INDEPENDENT_REVIEW",
        to: "REMEDIATION",
        reason: "Review findings require remediation",
      });
    });

    it("Case C: routes INDEPENDENT_REVIEW -> REMEDIATION on mixed findings (LOW + MEDIUM)", () => {
      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "INDEPENDENT_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-LOW-1",
              severity: "LOW",
              status: "OPEN",
            },
            {
              id: "F-MED-1",
              severity: "MEDIUM",
              status: "OPEN",
            },
          ],
        },
      };

      const decision = engine.decide(context);
      expect(decision).toEqual({
        action: "TRANSITION",
        from: "INDEPENDENT_REVIEW",
        to: "REMEDIATION",
        reason: "Review findings require remediation",
      });
    });

    it("Case D: preserves LOW findings as observable in context and result", () => {
      const lowFinding: StructuredFinding = {
        id: "F-LOW-OBS",
        severity: "LOW",
        category: "logging",
        evidence: "Debug log left in service",
        expected: "Removed in production",
        actual: "Present",
        required_remediation: "Remove console.log",
        status: "OPEN",
      };

      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
        findings: [lowFinding],
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "INDEPENDENT_REVIEW",
          status: "FINDINGS",
          evidence: [{ test: "unit-tests", passed: true }],
          findings: [lowFinding],
        },
      };

      const decision = engine.decide(context);
      // Advances to CONVERGE because LOW is non-blocking
      expect(decision.action).toBe("TRANSITION");
      expect((decision as any).to).toBe("CONVERGE");

      // Finding is NOT ignored or deleted: observable in context and result
      expect(context.findings).toHaveLength(1);
      expect(context.findings![0]).toEqual(lowFinding);
      expect(context.result?.findings).toHaveLength(1);
      expect(context.result?.findings?.[0]).toEqual(lowFinding);
    });

    it("Case E: routes INDEPENDENT_REVIEW -> REMEDIATION when LOW finding is explicitly marked blocking: true", () => {
      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "INDEPENDENT_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-LOW-BLOCKING",
              severity: "LOW",
              blocking: true,
              status: "OPEN",
            },
          ],
        },
      };

      const decision = engine.decide(context);
      expect(decision).toEqual({
        action: "TRANSITION",
        from: "INDEPENDENT_REVIEW",
        to: "REMEDIATION",
        reason: "Review findings require remediation",
      });
    });

    it("Case F: ANALYZE gate blocks on MEDIUM finding but allows LOW finding to pass", () => {
      const analyzeWithMedium: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "ANALYZE" },
        result: {
          execution_id: "exec-find-1",
          agent: "ARCHITECTURE",
          state: "ANALYZE",
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "A-1", severity: "MEDIUM", status: "OPEN" }],
        },
      };

      const blockingDecision = engine.decide(analyzeWithMedium);
      expect(blockingDecision.action).toBe("REQUIRE_HUMAN_INTERVENTION");

      const analyzeWithLow: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "ANALYZE" },
        result: {
          execution_id: "exec-find-1",
          agent: "ARCHITECTURE",
          state: "ANALYZE",
          status: "FINDINGS",
          evidence: [],
          findings: [{ id: "A-2", severity: "LOW", status: "OPEN" }],
        },
      };

      const passingDecision = engine.decide(analyzeWithLow);
      expect(passingDecision.action).toBe("TRANSITION");
      expect((passingDecision as any).to).toBe("IMPLEMENT");
    });

    it("routes INDEPENDENT_REVIEW -> CONVERGE when all findings are RESOLVED or ACCEPTED", () => {
      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "INDEPENDENT_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-1",
              severity: "HIGH",
              status: "RESOLVED",
            },
            {
              id: "F-2",
              severity: "MEDIUM",
              status: "ACCEPTED",
            },
          ],
        },
      };

      const decision = engine.decide(context);
      expect(decision).toEqual({
        action: "TRANSITION",
        from: "INDEPENDENT_REVIEW",
        to: "CONVERGE",
        reason: "Independent review passed",
      });
    });

    it("routes INDEPENDENT_REVIEW -> CONVERGE when only advisory findings (advisory: true) are present", () => {
      const context: CoordinatorExecutionContext = {
        execution: { ...baseExecution, state: "INDEPENDENT_REVIEW" },
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "INDEPENDENT_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-TYPO",
              severity: "LOW",
              category: "style",
              advisory: true,
              evidence: "Comment typo on line 42",
              expected: "Correct spelling",
              actual: "Typo",
              required_remediation: "Fix spelling in comment",
              status: "OPEN",
            },
          ],
        },
      };

      const decision = engine.decide(context);
      expect(decision).toEqual({
        action: "TRANSITION",
        from: "INDEPENDENT_REVIEW",
        to: "CONVERGE",
        reason: "Independent review passed",
      });
    });

    it("preserves remediation iteration limit (3) with structured findings", () => {
      const context: CoordinatorExecutionContext = {
        execution: {
          ...baseExecution,
          state: "RE_REVIEW",
          remediation_iteration: 3,
        },
        result: {
          execution_id: "exec-find-1",
          agent: "INDEPENDENT_REVIEW",
          state: "RE_REVIEW",
          status: "FINDINGS",
          evidence: [],
          findings: [
            {
              id: "F-PERSIST",
              severity: "HIGH",
              status: "OPEN",
            },
          ],
        },
      };

      const decision = engine.decide(context);
      expect(decision.action).toBe("REQUIRE_HUMAN_INTERVENTION");
      if (decision.action === "REQUIRE_HUMAN_INTERVENTION") {
        expect(decision.state).toBe("HUMAN_INTERVENTION_REQUIRED");
        expect(decision.from).toBe("RE_REVIEW");
        expect(decision.reason).toContain("Maximum remediation iterations reached (3)");
      }
    });
  });
});
