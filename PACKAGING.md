# Packaging & Release Guide: `@incito-labs/project-run-engine`

This document details the packaging, compilation, and distribution requirements for `@incito-labs/project-run-engine`.

---

## 1. Package Structure & Exports

The package is published as an ESM library compiled with `NodeNext` module resolution.

```
project-run-engine/
├── dist/                     # Generated compilation artifacts (.js, .d.ts, .map)
│   ├── index.js
│   ├── index.d.ts
│   ├── cli/
│   │   └── project-run-cli.js # Executable CLI binary (bin: project-run)
│   ├── coordinator/
│   ├── decision/
│   ├── domain/
│   ├── runtime/
│   ├── skills/
│   ├── presets/
│   ├── project/
│   ├── host/
│   └── templates/skills/     # Compiled/copied offline skill templates
├── templates/skills/         # Canonical offline Spec-Kit skill templates
├── src/                      # TypeScript sources
├── tests/                    # Standalone unit & integration tests
├── ARCHITECTURE.md           # Architecture specification
├── CONSUMER-GUIDE.md         # Consumer integration guide
├── README.md                 # Project overview
├── PACKAGING.md              # This document
├── package.json              # Package manifest (includes "bin" and "files")
├── tsconfig.json             # Development TypeScript config
└── tsconfig.build.json       # Production build TypeScript config
```

### CLI Executable (`bin`)

```json
{
  "bin": {
    "project-run": "./dist/cli/project-run-cli.js"
  }
}
```

### Subpath Export Map

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./domain": {
      "types": "./dist/domain/index.d.ts",
      "import": "./dist/domain/index.js",
      "default": "./dist/domain/index.js"
    },
    "./coordinator": {
      "types": "./dist/coordinator/index.d.ts",
      "import": "./dist/coordinator/index.js",
      "default": "./dist/coordinator/index.js"
    },
    "./runtime": {
      "types": "./dist/runtime/index.d.ts",
      "import": "./dist/runtime/index.js",
      "default": "./dist/runtime/index.js"
    },
    "./skills": {
      "types": "./dist/skills/index.d.ts",
      "import": "./dist/skills/index.js",
      "default": "./dist/skills/index.js"
    },
    "./presets": {
      "types": "./dist/presets/index.d.ts",
      "import": "./dist/presets/index.js",
      "default": "./dist/presets/index.js"
    },
    "./project": {
      "types": "./dist/project/index.d.ts",
      "import": "./dist/project/index.js",
      "default": "./dist/project/index.js"
    },
    "./host": {
      "types": "./dist/host/index.d.ts",
      "import": "./dist/host/index.js",
      "default": "./dist/host/index.js"
    }
  }
}
```

---

## 2. Zero Runtime Dependencies Invariant

`project-run-engine` must maintain:

```json
"dependencies": {}
```

Only Node.js standard libraries (`node:fs`, `node:path`) are permitted. All provider libraries (OpenRouter, OpenAI, Anthropic, Vercel AI SDK), database drivers (Supabase, Postgres), and frontend frameworks (React, Next.js) are strictly prohibited. Context discovery and execution state persistence are implemented entirely using Node.js built-ins without child-process shell execution or external database dependencies.

This constraint is continuously enforced by automated package-boundary tests.

---

## 3. Runtime Persistence Directory

During execution, `project-run-engine` checkpoints state to `.project-run/runs/<execution_id>.json`. This directory is managed by the consumer project and should be added to `.gitignore`. Checkpoints are sanitized of credentials and sensitive tokens prior to disk persistence.

---

## 4. Build & Clean

This repository is the package root; every command below runs from the repository root (the directory containing `package.json`). Install dependencies first with `npm ci`.

```bash
npm run build       # clean (prebuild), compile with tsconfig.build.json, copy templates/ into dist/, chmod the CLI
npm run clean       # remove dist/
```

`npm run build` is the single supported way to produce `dist/`; it cleans first (`prebuild`), so a stale `dist/` can never leak into the package.

---

## 5. Verification Before Release

Run all of these from the repository root. Each must pass; none publishes anything.

```bash
npm run typecheck   # tsc --noEmit over src/ only (tsconfig.json includes src/**/* and excludes tests/**/*)
npm test            # vitest run — the whole suite, including the compiled-package and multi-process tests
npm run build       # production build (see section 4); the locking/CLI tests also compile into a temporary directory
git diff --check    # no whitespace errors in the working tree
npm pack --dry-run  # lists exactly what would be published (dist/, templates/, LICENSE and the *.md files in "files")
```

Test files are **not** type-checked by `npm run typecheck`; they are transpiled and executed by `vitest` (via `npm test`), which does not report type errors. There is no separate test typecheck command.

`npm test` requires the build tooling only (`tsc` is a dev dependency); it does not need a prior `npm run build`. Run the tests *before* the final build so the build output is not left half-validated, and run `npm pack --dry-run` *after* `npm run build` so the listing reflects the fresh `dist/`.

---

## 6. Publishing

`@incito-labs/project-run-engine` is published to the public npm registry (`"publishConfig": { "access": "public" }`). Versions `0.1.0`, `0.1.1` and `0.2.0` have been published so far.

A release is prepared and published by a maintainer from an authenticated session, after the verification in section 5 (typecheck, tests, build, `git diff --check` and `npm pack --dry-run`). The version bump (`package.json` and `package-lock.json`) is committed on its own before publishing, and a published version is never modified. The sandboxed environments used for implementation work so far have held no npm credentials, so they prepared releases and a maintainer published them.
