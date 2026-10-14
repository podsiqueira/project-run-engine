# Contract: Verification Pipeline, Allowlist and Snapshot (H3)

Drives FR-024..FR-036, D-04, D-05, D-11, D-20.

## 1. Ports (core defines types only; Node implementation lives in the amended-boundary module — OD-1)

```ts
interface ValidatorExecutor {
  run(def: ValidatorDefinition, ctx: { workspaceRoot: string; env: Record<string,string>; signal: AbortSignal;
       evidence: EvidenceWriter }): Promise<RawRun>;   // never throws for ordinary failure; returns RawRun
}
interface SnapshotProvider {
  capture(workspaceRoot: string, opts: { excludeGlobs: string[]; maxFileBytes: number }): Promise<SnapshotIdentity>;
  diff(baseline: SnapshotIdentity, subject: SnapshotIdentity): Promise<DiffArtifact>;  // content-addressed
}
```
The controller MUST refuse to run without both ports (`HARNESS_PORTS_MISSING`, fail closed).

## 2. `ValidatorDefinition` (policy allowlist entry)

```ts
interface ValidatorDefinition {
  id: string;                              // stable, e.g. "unit-tests"
  argv: [string, ...string[]];             // executable + args; NO shell; no interpolation of agent text
  cwd: string;                             // workspace-relative; resolved real path MUST stay inside the workspace
  timeoutMs: number;
  risk: "LOW" | "MEDIUM" | "HIGH";         // HIGH ⇒ requires explicit envelope listing and a gate
  required: boolean;
  appliesTo: "ALL_TASKS" | string[];
  envAllowlist: string[];                  // variable names passed through; everything else is dropped
  maxOutputBytes: number;
  expectedExitCodes: number[];             // default [0]
  digest: string;                          // engine-computed over all fields
}
```
The allowlist (`policy.validators`) is protected: not editable by agents during an authorised execution; digest pinned in the envelope.

## 3. Execution rules

1. `argv[0]` resolved by the executor against a fixed `PATH` supplied by the policy (not the agent's). Spawn with `shell: false`.
2. `cwd` realpath-checked; symlink escape ⇒ `ERROR(CWD_ESCAPE)`.
3. Environment = only `envAllowlist` names present in the host process env; secrets are never added implicitly.
4. Output streams captured to evidence files with the size cap; truncation recorded (`truncated: true`).
5. Timeout ⇒ kill the process group, record `timedOut: true`, outcome `ERROR(TIMEOUT)`.
6. Cancellation via `AbortSignal` ⇒ `ERROR(CANCELLED)`.
7. Validators run **sequentially** in policy order (deterministic logs), each on the same subject snapshot; the snapshot is re-captured after the last validator and must equal the subject, otherwise all results are `INVALIDATED(SNAPSHOT_DRIFT)` and the cycle suspends (`WORKSPACE_MUTATED_DURING_VERIFICATION`).

## 4. `ValidatorResult`

```ts
interface ValidatorResult {
  resultId: string; validatorId: string; validatorDigest: string; snapshotId: string; runSeq: number;
  outcome: "PASSED" | "FAILED" | "ERROR";
  errorCode?: "SPAWN_FAILED" | "TIMEOUT" | "CANCELLED" | "CWD_ESCAPE" | "MISSING_OUTPUT" | "PORTS_MISSING";
  exitCode?: number; signal?: string; timedOut: boolean; durationMs: number;
  startedAt: string; completedAt: string;
  logs: { stdout: EvidenceReference; stderr: EvidenceReference };
}
```
Outcome mapping: exit code ∈ `expectedExitCodes` ⇒ `PASSED`; any other exit ⇒ `FAILED`; anything where no trustworthy exit status exists ⇒ `ERROR`. A result may only be created by the executor; an API for submitting a validator result from outside does not exist.

## 5. Gate semantics

- Any required validator `FAILED` ⇒ raise a `HarnessFinding{source:"VALIDATOR", severity:"HIGH", blocking:true, evidenceRefs:[log refs]}` per failed validator ⇒ `REMEDIATE` (budget permitting).
- Any required validator `ERROR`, or missing ⇒ `SUSPEND(VALIDATOR_ERROR)`; no attempt consumed; no review dispatched.
- Non-required validator failures become non-blocking findings (visible to the reviewer).
- Review is dispatched only when every required validator `PASSED` for the subject snapshot.

## 6. Snapshot (D-04, FR-033..036)

```ts
interface SnapshotIdentity { schemaVersion: 1; baseCommit: string; entries: SnapshotEntry[]; snapshotId: string }
interface SnapshotEntry { path: string; kind: "ADDED"|"MODIFIED"|"DELETED"|"MODE_CHANGED"|"RENAMED"|"OPAQUE";
                          mode: string; sha256?: string; renamedFrom?: string; bytes?: number; note?: string }
```
Canonical form: UTF-8 JSON, keys sorted, entries sorted by `path` (bytewise). Excluded: policy `protectedPaths`' Harness-owned subset (evidence dir, ledger), `.git`, VCS-ignored paths. Untracked files are included. Files over the size cap and submodule/symlink targets are `OPAQUE` with a visible note.
`DiffArtifact{baselineSnapshotId, subjectSnapshotId, files[], patchRef: EvidenceReference, digest}`; `digest` is part of every `ReviewRequest`.

## 7. Protected and sensitive paths

Diff inspection runs after every implementation/remediation result and before validators: any entry whose path matches `protectedPaths` or lies outside `allowedPaths` ⇒ `OUT_OF_SCOPE_CHANGE` suspension (no validator run, no attempt consumed). `sensitivePaths` matches do not suspend; they add a mandatory `verifierTampering` disposition to the review request (and a gate if the envelope requires).

## 8. Honest limits

No network isolation (`network: "not-enforced"`); no filesystem sandbox beyond cwd confinement; allowlisted commands execute repository code (tests/scripts) the implementer may legitimately edit — the control is review, sensitive-path rules and digest-bound results, not prevention. Redaction is pattern-based.

## 9. Test list (H3)

allowed command passes · exit≠0 ⇒ FAILED + finding · spawn error ⇒ ERROR · timeout ⇒ ERROR + process group killed · missing binary · cwd symlink escape · env var not allowlisted absent · secret value in output masked · output cap truncation recorded · validator definition edited ⇒ `PIN_MISMATCH` · agent-claimed pass ignored · result for old snapshot not reusable · snapshot drift during run ⇒ invalidated · required validator missing ⇒ no review · protected-path diff ⇒ suspension before validators.
