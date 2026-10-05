import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const PACKAGE_SRC = path.join(PACKAGE_ROOT, "src");
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, "package.json");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

function extractImportSpecifiers(sourceCode: string): string[] {
  const specifiers: string[] = [];
  const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(sourceCode)) !== null) {
    specifiers.push(match[1]);
  }

  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(sourceCode)) !== null) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

describe("Package Boundary Validation: standalone project-run-engine", () => {
  it("should have zero runtime external dependencies in package.json", () => {
    expect(fs.existsSync(PACKAGE_JSON_PATH)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));

    expect(pkg.name).toBe("@incito-labs/project-run-engine");
    expect(pkg.dependencies).toBeDefined();
    expect(Object.keys(pkg.dependencies)).toEqual([]);
  });

  it("should not import Incito application code (@/ or path escapes into incito src)", () => {
    const tsFiles = getAllTsFiles(PACKAGE_SRC);
    expect(tsFiles.length).toBeGreaterThan(10);

    const violations: { file: string; specifier: string }[] = [];

    for (const filePath of tsFiles) {
      const code = fs.readFileSync(filePath, "utf8");
      const specifiers = extractImportSpecifiers(code);

      for (const specifier of specifiers) {
        if (specifier.startsWith("@/")) {
          violations.push({ file: filePath, specifier });
        }
        if (specifier.includes("/src/app") || specifier.includes("/src/components") || specifier.includes("/src/lib")) {
          violations.push({ file: filePath, specifier });
        }
        if (specifier.startsWith("../../../") || specifier.startsWith("../../../../")) {
          violations.push({ file: filePath, specifier });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("should not import Next.js, React, or React DOM", () => {
    const tsFiles = getAllTsFiles(PACKAGE_SRC);
    const violations: { file: string; specifier: string }[] = [];

    for (const filePath of tsFiles) {
      const code = fs.readFileSync(filePath, "utf8");
      const specifiers = extractImportSpecifiers(code);

      for (const specifier of specifiers) {
        if (
          specifier === "next" ||
          specifier.startsWith("next/") ||
          specifier === "react" ||
          specifier.startsWith("react/") ||
          specifier === "react-dom" ||
          specifier.startsWith("react-dom/")
        ) {
          violations.push({ file: filePath, specifier });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("should not import Supabase, Postgres, or database libraries", () => {
    const tsFiles = getAllTsFiles(PACKAGE_SRC);
    const violations: { file: string; specifier: string }[] = [];

    for (const filePath of tsFiles) {
      const code = fs.readFileSync(filePath, "utf8");
      const specifiers = extractImportSpecifiers(code);

      for (const specifier of specifiers) {
        if (
          specifier === "supabase" ||
          specifier.startsWith("@supabase/") ||
          specifier === "postgres" ||
          specifier === "pg"
        ) {
          violations.push({ file: filePath, specifier });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("should not import Vercel AI SDK, OpenRouter, OpenAI, Anthropic, or any LLM provider SDKs", () => {
    const tsFiles = getAllTsFiles(PACKAGE_SRC);
    const violations: { file: string; specifier: string }[] = [];

    const forbiddenPackages = [
      "ai",
      "@ai-sdk",
      "@openrouter",
      "openai",
      "@anthropic-ai",
      "@google/generative-ai",
      "langchain",
      "llamaindex",
    ];

    for (const filePath of tsFiles) {
      const code = fs.readFileSync(filePath, "utf8");
      const specifiers = extractImportSpecifiers(code);

      for (const specifier of specifiers) {
        for (const forbidden of forbiddenPackages) {
          if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
            violations.push({ file: filePath, specifier });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("should only import node built-ins (node:fs, node:path) or local relative files", () => {
    const tsFiles = getAllTsFiles(PACKAGE_SRC);
    const nonCompliant: { file: string; specifier: string }[] = [];

    for (const filePath of tsFiles) {
      const code = fs.readFileSync(filePath, "utf8");
      const specifiers = extractImportSpecifiers(code);

      for (const specifier of specifiers) {
        const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
        const isNodeBuiltin =
          specifier === "node:fs" ||
          specifier === "node:path" ||
          specifier === "fs" ||
          specifier === "path";

        if (!isRelative && !isNodeBuiltin) {
          nonCompliant.push({ file: filePath, specifier });
        }
      }
    }

    expect(nonCompliant).toEqual([]);
  });
});
