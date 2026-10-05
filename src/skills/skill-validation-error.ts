// packages/project-run-engine/src/skills/skill-validation-error.ts

import type { SkillValidationResult } from "../domain/types.js";

/**
 * Structured error thrown when an agent role cannot be dispatched
 * due to missing required skills.
 */
export class SkillValidationError extends Error {
  readonly result: SkillValidationResult;

  constructor(result: SkillValidationResult) {
    const message =
      result.failureReason ??
      `Workflow cannot continue: missing required skills for role ${result.role}`;
    super(message);
    this.name = "SkillValidationError";
    this.result = result;
    Object.setPrototypeOf(this, SkillValidationError.prototype);
  }
}
