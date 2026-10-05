// packages/project-run-engine/src/index.ts

// Domain types & validation
export * from "./domain/index.js";

// Coordinator execution loop & options
export * from "./coordinator/index.js";

// Decision engine & state machine contracts
export * from "./decision/index.js";

// Agent registry & dispatcher
export * from "./agents/index.js";

// Host execution contracts & adapters
export * from "./runtime/index.js";

// Skill resolution & validation framework
export * from "./skills/index.js";

// Workflow presets (Spec-Kit)
export * from "./presets/index.js";

// Project configuration, runner, and doctor
export * from "./project/index.js";

// Provider-agnostic Host Skill Contract (Claude Code / Cursor / Antigravity / Codex)
export * from "./host/index.js";
