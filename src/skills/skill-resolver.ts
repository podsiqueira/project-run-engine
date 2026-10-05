// packages/project-run-engine/src/skills/skill-resolver.ts

import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillDescriptor } from "../domain/types.js";

export interface SkillResolverOptions {
  projectRoot?: string;
  searchPaths?: string[];
  preloadedSkills?: SkillDescriptor[];
  disableDiskDiscovery?: boolean;
}

/**
 * Discovers and indexes skills from workspace directories and programmatic registrations.
 *
 * Scans directories like:
 * - `<projectRoot>/.project-run/skills`
 * - `<projectRoot>/.agents/skills`
 * - Any custom search paths
 *
 * Parses YAML frontmatter in SKILL.md to extract metadata.
 */
export class SkillResolver {
  private readonly projectRoot: string;
  private readonly searchPaths: string[];
  private readonly disableDiskDiscovery: boolean;
  private readonly programmaticSkills = new Map<string, SkillDescriptor>();
  private discoveredSkills: Map<string, SkillDescriptor> | null = null;

  constructor(options?: SkillResolverOptions) {
    this.projectRoot = options?.projectRoot ?? process.cwd();
    this.searchPaths = options?.searchPaths ?? [];
    this.disableDiskDiscovery = options?.disableDiskDiscovery ?? false;

    if (options?.preloadedSkills) {
      for (const skill of options.preloadedSkills) {
        this.programmaticSkills.set(skill.id, skill);
      }
    }
  }

  /**
   * Programmatically registers a skill descriptor.
   */
  registerSkill(descriptor: SkillDescriptor): void {
    this.programmaticSkills.set(descriptor.id, descriptor);
    if (this.discoveredSkills) {
      this.discoveredSkills.set(descriptor.id, descriptor);
    }
  }

  /**
   * Resolves all available skills across configured locations.
   */
  async resolveSkills(forceRefresh = false): Promise<Map<string, SkillDescriptor>> {
    if (this.discoveredSkills && !forceRefresh) {
      return new Map(this.discoveredSkills);
    }

    const skills = new Map<string, SkillDescriptor>();

    // 1. Collect all directories to search unless disk discovery is disabled
    const candidateDirs = this.disableDiskDiscovery
      ? []
      : [
          path.join(this.projectRoot, ".project-run", "skills"),
          path.join(this.projectRoot, ".agents", "skills"),
          ...this.searchPaths.map((p) =>
            path.isAbsolute(p) ? p : path.join(this.projectRoot, p),
          ),
        ];

    // 2. Scan each directory
    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) {
        continue;
      }

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillDir = path.join(dir, entry.name);
            const descriptor = this.inspectSkillDirectory(entry.name, skillDir);
            if (descriptor) {
              skills.set(descriptor.id, descriptor);
            }
          }
        }
      } catch {
        // Gracefully ignore directory read errors
      }
    }

    // 3. Layer programmatic skills (they can override or supplement discovered ones)
    for (const [id, descriptor] of this.programmaticSkills) {
      skills.set(id, descriptor);
    }

    this.discoveredSkills = skills;
    return new Map(skills);
  }

  /**
   * Checks whether a skill exists and is marked as available.
   */
  async hasSkill(id: string): Promise<boolean> {
    const skills = await this.resolveSkills();
    const descriptor = skills.get(id);
    return descriptor ? descriptor.available : false;
  }

  /**
   * Retrieves the descriptor for a specific skill.
   */
  async getSkill(id: string): Promise<SkillDescriptor | undefined> {
    const skills = await this.resolveSkills();
    return skills.get(id);
  }

  /**
   * Inspects a skill folder and parses SKILL.md.
   */
  private inspectSkillDirectory(
    folderName: string,
    skillDir: string,
  ): SkillDescriptor | null {
    const candidates = ["SKILL.md", "skill.md", "SKILL.MD"];
    let skillFile: string | null = null;

    for (const file of candidates) {
      const fullPath = path.join(skillDir, file);
      if (fs.existsSync(fullPath)) {
        skillFile = fullPath;
        break;
      }
    }

    if (!skillFile) {
      return null;
    }

    try {
      const content = fs.readFileSync(skillFile, "utf8");
      const parsed = this.parseFrontmatter(content);

      const id = parsed.name || folderName;
      return {
        id,
        name: parsed.name || folderName,
        description: parsed.description,
        compatibility: parsed.compatibility,
        available: true,
        source: skillFile,
        version: parsed.version || parsed.metadata?.version,
        metadata: parsed.metadata,
      };
    } catch {
      return {
        id: folderName,
        name: folderName,
        available: true,
        source: skillFile,
      };
    }
  }

  /**
   * Parses simple YAML frontmatter between `---` delimiters.
   */
  private parseFrontmatter(content: string): {
    name?: string;
    description?: string;
    compatibility?: string;
    version?: string;
    metadata?: Record<string, string>;
  } {
    const lines = content.split(/\r?\n/);
    if (lines.length < 2 || lines[0].trim() !== "---") {
      return {};
    }

    const frontmatterLines: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        break;
      }
      frontmatterLines.push(lines[i]);
    }

    const result: {
      name?: string;
      description?: string;
      compatibility?: string;
      version?: string;
      metadata?: Record<string, string>;
    } = {};

    let currentSection: "root" | "metadata" = "root";

    for (const line of frontmatterLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      if (line.startsWith("metadata:")) {
        currentSection = "metadata";
        result.metadata = {};
        continue;
      }

      if (currentSection === "metadata" && (line.startsWith("  ") || line.startsWith("\t"))) {
        const colonIndex = trimmed.indexOf(":");
        if (colonIndex > 0) {
          const key = trimmed.slice(0, colonIndex).trim();
          const val = this.cleanValue(trimmed.slice(colonIndex + 1));
          result.metadata![key] = val;
          if (key === "version") {
            result.version = val;
          }
        }
        continue;
      }

      // Root level key
      currentSection = "root";
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex > 0) {
        const key = trimmed.slice(0, colonIndex).trim();
        const val = this.cleanValue(trimmed.slice(colonIndex + 1));
        if (key === "name") result.name = val;
        else if (key === "description") result.description = val;
        else if (key === "compatibility") result.compatibility = val;
        else if (key === "version") result.version = val;
      }
    }

    return result;
  }

  private cleanValue(val: string): string {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }
}
