// The PUBLIC surface, tested the way a consumer meets it: the package is compiled, and
//   1. every subpath in package.json "exports" is imported at runtime and must expose the symbols it
//      promises (and none of the internal helpers);
//   2. TypeScript fixtures are compiled as a consumer that resolves "@incito-labs/project-run-engine[/sub]"
//      through that "exports" map and the emitted .d.ts files — including the 0.3.0-era shapes that must
//      keep compiling (a subclass of FileExecutionStateStore overriding save(): Promise<void>).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures", "consumer-types");
const PKG_NAME = "@incito-labs/project-run-engine";

let tmp: string;
let pkgDir: string;
let consumerDir: string;
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  exports: Record<string, { import: string; types: string }>;
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "api-surface-"));
  pkgDir = path.join(tmp, "pkg");
  fs.mkdirSync(pkgDir, { recursive: true });
  // Build exactly as `npm run build` does (declarations on), into a throwaway package directory.
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(REPO_ROOT, "tsconfig.build.json"), "--outDir", path.join(pkgDir, "dist"), "--sourceMap", "false", "--declarationMap", "false"],
    { cwd: REPO_ROOT, stdio: "pipe" },
  );
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(pkgDir, "package.json"));

  // A consumer project that depends on the package by name.
  consumerDir = path.join(tmp, "consumer");
  fs.mkdirSync(path.join(consumerDir, "node_modules", "@incito-labs"), { recursive: true });
  fs.symlinkSync(pkgDir, path.join(consumerDir, "node_modules", PKG_NAME), "dir");
  fs.writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(consumerDir, f));
}, 180_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function load(subpath: "." | "./domain" | "./project" | "./host"): Promise<Record<string, unknown>> {
  const target = path.join(pkgDir, manifest.exports[subpath].import);
  return (await import(/* @vite-ignore */ "file://" + target)) as Record<string, unknown>;
}

function tsc(project: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", project], { cwd: consumerDir, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function writeProject(name: string, files: string[]): string {
  const file = path.join(consumerDir, name);
  fs.writeFileSync(
    file,
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, noEmit: true, skipLibCheck: false, types: [] }, files }),
  );
  return file;
}

describe("public API surface — runtime exports of every published entry point", () => {
  it("package.json exposes exactly the entry points the docs promise", () => {
    expect(Object.keys(manifest.exports)).toEqual([".", "./domain", "./coordinator", "./runtime", "./skills", "./presets", "./project", "./host"]);
  });

  it("every entry point imports from the built package", async () => {
    for (const sub of Object.keys(manifest.exports)) {
      const mod = (await import(/* @vite-ignore */ "file://" + path.join(pkgDir, manifest.exports[sub].import))) as Record<string, unknown>;
      expect(Object.keys(mod).length, `${sub} exports nothing`).toBeGreaterThan(0);
    }
  });

  it("root exposes the persistence-failure and storage-contract symbols", async () => {
    const root = await load(".");
    for (const name of ["CheckpointWriteError", "CheckpointConflictError", "ExecutionLockError", "ExecutionLockTimeoutError", "ExecutionLockUnavailableError", "isExecutionLockFailure", "FileExecutionStateStore", "withExecutionLock", "executeProjectRun", "executeProjectResume", "nextProjectRunStep", "submitProjectRunStep", "startProjectRun", "resumeProjectRun", "statusProjectRun"]) {
      expect(typeof root[name], `root.${name}`).toBe("function");
    }
  });

  it("/domain exposes the error classes (and they are the SAME classes as the root's)", async () => {
    const root = await load(".");
    const domain = await load("./domain");
    for (const name of ["CheckpointWriteError", "CheckpointConflictError", "ExecutionLockError", "ExecutionLockTimeoutError", "ExecutionLockUnavailableError", "isExecutionLockFailure", "countAgentSteps"]) {
      expect(typeof domain[name], `domain.${name}`).toBe("function");
      expect(domain[name], `domain.${name} is a different class than root.${name}`).toBe(root[name]);
    }
  });

  it("/project exposes the store contract implementation and the push entry points", async () => {
    const project = await load("./project");
    for (const name of ["FileExecutionStateStore", "withExecutionLock", "executeProjectRun", "executeProjectResume", "validatePersistedState"]) {
      expect(typeof project[name], `project.${name}`).toBe("function");
    }
  });

  it("/host exposes start/resume/status, the pull API and the tool schema", async () => {
    const host = await load("./host");
    for (const name of ["startProjectRun", "resumeProjectRun", "statusProjectRun", "nextProjectRunStep", "submitProjectRunStep", "projectEngineRun"]) {
      expect(typeof host[name], `host.${name}`).toBe("function");
    }
    expect(host.PROJECT_ENGINE_RUN_TOOL_SCHEMA).toBeTypeOf("object");
  });

  it("the error classes behave as documented through the public entry points", async () => {
    const { CheckpointWriteError, CheckpointConflictError } = (await load("./domain")) as Record<string, new (...a: unknown[]) => Error & { code: string }>;
    const cause = new Error("ENOSPC");
    const write = new CheckpointWriteError("e1", "IN_PROGRESS", cause);
    expect(write.code).toBe("CHECKPOINT_WRITE_FAILED");
    const conflict = new CheckpointConflictError("e1", "IN_PROGRESS", 3, 4);
    expect(conflict.code).toBe("CHECKPOINT_CONFLICT");
    expect(conflict).toBeInstanceOf(CheckpointWriteError); // a conflict IS a write error
    expect(conflict.message).toMatch(/^CHECKPOINT_CONFLICT:/);
  });

  it("internal helpers are NOT part of any entry point", async () => {
    for (const sub of Object.keys(manifest.exports)) {
      const mod = (await import(/* @vite-ignore */ "file://" + path.join(pkgDir, manifest.exports[sub].import))) as Record<string, unknown>;
      expect(mod.runLockedTurn, `${sub} leaks runLockedTurn`).toBeUndefined();
      expect(mod.operationFailureReason, `${sub} leaks operationFailureReason`).toBeUndefined();
    }
  });

  it("the tool schema documents every failure code a response can carry", async () => {
    const host = await load("./host");
    const sem = (host.PROJECT_ENGINE_RUN_TOOL_SCHEMA as { response_semantics: { failure_code_field: string; failure_codes: string[] } }).response_semantics;
    expect(sem.failure_code_field).toBe("failureCode");
    expect([...sem.failure_codes].sort()).toEqual(["CHECKPOINT_CONFLICT", "CHECKPOINT_WRITE_FAILED", "EXECUTION_LOCKED", "EXECUTION_LOCK_UNAVAILABLE"]);
  });
});

describe("public API surface — a TypeScript consumer compiling against the emitted declarations", () => {
  it("every new type and value is importable from root, /domain, /project and /host and has the documented shape", () => {
    const { status, output } = tsc(writeProject("tsconfig.exports.json", ["exports.ts"]));
    expect(output).toBe("");
    expect(status).toBe(0);
  }, 120_000);

  it("F2: a subclass of FileExecutionStateStore written against 0.3.0 (save(): Promise<void>) still type-checks", () => {
    const { status, output } = tsc(writeProject("tsconfig.legacy.json", ["legacy-subclass.ts"]));
    expect(output).toBe("");
    expect(status).toBe(0);
  }, 120_000);

  it("stores that report revisions type-check in every supported shape (forwarding, narrowing, from scratch, legacy)", () => {
    const { status, output } = tsc(writeProject("tsconfig.receipt.json", ["receipt-store.ts"]));
    expect(output).toBe("");
    expect(status).toBe(0);
  }, 120_000);

  it("control: a save() resolving to something that is neither void nor a receipt is rejected (the check is not vacuous)", () => {
    const { status, output } = tsc(writeProject("tsconfig.negative.json", ["must-not-compile.ts"]));
    expect(status).not.toBe(0);
    expect(output).toMatch(/TS2416/);
  }, 120_000);
});
