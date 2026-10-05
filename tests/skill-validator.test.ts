import { describe, it, expect } from "vitest";
import {
  SkillResolver,
  SkillValidator,
  type SkillDescriptor,
} from "../src/index.js";

describe("Skill Validation (project-run-engine)", () => {
  it("should validate all required skills are present", async () => {
    const preloaded: SkillDescriptor[] = [
      { id: "speckit-specify", name: "Specify", available: true },
      { id: "speckit-clarify", name: "Clarify", available: true },
    ];
    const resolver = new SkillResolver({ preloadedSkills: preloaded, disableDiskDiscovery: true });
    const validator = new SkillValidator(resolver);

    const result = await validator.validateRole("SPECIFICATION", [
      { id: "speckit-specify", required: true },
      { id: "speckit-clarify", required: false },
    ]);

    expect(result.valid).toBe(true);
    expect(result.missingRequiredSkills).toEqual([]);
    expect(result.availableSkills.length).toBe(2);
  });

  it("should fail validation deterministically when a required skill is missing", async () => {
    const preloaded: SkillDescriptor[] = [
      { id: "speckit-clarify", name: "Clarify", available: true },
    ];
    const resolver = new SkillResolver({ preloadedSkills: preloaded, disableDiskDiscovery: true });
    const validator = new SkillValidator(resolver);

    const result = await validator.validateRole("SPECIFICATION", [
      { id: "speckit-specify", required: true },
      { id: "speckit-clarify", required: false },
    ]);

    expect(result.valid).toBe(false);
    expect(result.missingRequiredSkills).toContain("speckit-specify");
    expect(result.failureReason).toContain("Missing required skills");
  });
});
