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
7. Validators run **sequentially** in policy order (deterministic logs), each on the same subject snapshot; the snapshot is re-captured after the last validator and its **non-ignored** entries must equal the subject's (ignored-file side effects are recorded, §6.2), otherwise all results are `INVALIDATED(SNAPSHOT_DRIFT)` and the cycle suspends (`WORKSPACE_MUTATED_DURING_VERIFICATION`).

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

## 6. Snapshot, baseline and ignored files (D-04, FR-033..036, FR-082..084; revised)

```ts
interface SnapshotIdentity { schemaVersion: 1; baseCommit: string; treeDigest: string; entries: SnapshotEntry[]; snapshotId: string }
interface SnapshotEntry { path: string;
  kind: "ADDED"|"MODIFIED"|"DELETED"|"MODE_CHANGED"|"RENAMED"|"OPAQUE"|"IGNORED_TRACKED_BY_HASH"|"EXCLUDED_BY_POLICY";
  mode: string; sha256?: string; renamedFrom?: string; bytes?: number; matchedRule?: string; note?: string }
```
- `treeDigest` = sha256 over **every non-excluded file in the working tree** (tracked, untracked, and ignored-but-not-excluded) as sorted `(path, mode, sha256)` triples. It is independent of `HEAD`, so it supports chain of custody across a human commit.
- `entries` = the delta of that tree against `baseCommit`'s tree (what changed), plus the `IGNORED_TRACKED_BY_HASH` and `EXCLUDED_BY_POLICY` markers below. `snapshotId = sha256(canonical JSON {baseCommit, treeDigest, entries})`.
- Canonical JSON: UTF-8, keys sorted, entries sorted bytewise by path.

### 6.1 Baseline rules

1. **Default `CLEAN_REQUIRED`**: at `issueEnvelope` the tree has no uncommitted changes (tracked or untracked non-ignored) other than Harness-owned paths. The envelope records `startTreeDigest` and `startCommit`.
2. **Chain of custody**: the baseline of the first task must equal `startTreeDigest`; the baseline of task *n+1* must equal the `treeDigest` of the accepted subject of task *n* (or, after a human commit, a clean tree whose `treeDigest` is identical). Otherwise `BASELINE_DRIFT`: nothing dispatched; human decides (re-baseline via amendment with a fresh clean/approved baseline, or revert).
   Consequently an uncommitted change can only enter a baseline through (a) an accepted, reviewed task of this envelope or (b) an explicit `DirtyBaselineApproval`.
3. **Dirty baseline** (only if `policy.baseline.allowDirtyBaseline`): `DirtyBaselineApproval{approvalId, actor, files:[{path, kind, sha256, reason, risk}], patchRef (evidence of the patch against HEAD), decidedAt}` pinned in the envelope. The reviewer receives the approved dirty files (list + patch) and must return a `baselineInfluence` disposition (`NONE_FOUND | FINDING`) because a dirty file can influence validator output without appearing in the task delta. Validators additionally record `treeDigest` so the influence is attributable. Any additional dirty file or modification of an approved one ⇒ `BASELINE_DRIFT`.
4. Feature 009's working tree, or any real consumer tree, is never used as a baseline or fixture.

### 6.2 Ignored files (no wholesale exclusion)

- Always excluded: the Harness-owned paths (`.project-run/evidence/**`, `.project-run/runs/**`, ledger files) and `.git/**`.
- Excluded only if listed in `policy.ignoredExclusions` (e.g. `node_modules/**`, `dist/**`, `.cache/**`); they appear as `EXCLUDED_BY_POLICY` entries naming the matching rule, so the reviewer can see what was not examined.
- Every other VCS-ignored file that exists is **hashed into `treeDigest`** and listed as `IGNORED_TRACKED_BY_HASH`; its **content is never copied** into patches or evidence (it may be a secret such as `.env.local`). If one changes, appears or disappears during a cycle: finding `IGNORED_FILE_CHANGED` (blocking until the reviewer dispositions it; a gate if it matches `sensitivePaths`). Pre-existing ignored files that influence builds/tests are therefore visible by hash in every snapshot and in the review request.
- **Validator side effects**: validators legitimately create ignored files (coverage, caches, build output). The post-validation drift check (§3.7) compares **non-ignored** entries strictly (any difference ⇒ `WORKSPACE_MUTATED_DURING_VERIFICATION`); differences in `IGNORED_TRACKED_BY_HASH` entries are not drift: they are recorded on the `ValidatorResult` as `ignoredSideEffects[]` (path + hash) and shown to the reviewer. Projects reduce noise by listing such directories in `ignoredExclusions`; the exclusion is then visible, not hidden.
- Ignored files larger than the size cap are hashed in streaming mode; if hashing is not possible they become `OPAQUE` with a visible note.
- `ignoredExclusions` patterns follow `path-matching.md`; an exclusion that matches a file also matched by `sensitivePaths` or by `allowedPaths` is rejected at validation (`EXCLUSION_CONFLICT`).

`DiffArtifact{baselineSnapshotId, subjectSnapshotId, files[], patchRef: EvidenceReference, digest}` is as before; the patch contains content only for non-ignored (tracked/untracked) files.

## 7. Protected and sensitive paths

Diff inspection runs after every implementation/remediation result and before validators, using the scope decision of `path-matching.md` §4: any entry that is not in scope (protected, outside `allowedPaths`, invalid path, symlink change, `tasks.md` change beyond the own checkbox) ⇒ `OUT_OF_SCOPE_CHANGE` suspension (no validator run, no new attempt consumed). This is **detection after the fact (E2)**: the changes stay on disk and the Harness does not roll them back. `sensitivePaths` matches do not suspend; they add a mandatory `verifierTampering` disposition to the review request (and a gate if the envelope requires).

## 8. Honest limits

Logical enforcement only (see authorization-envelope §0). No network isolation (`network: "not-enforced"`); no filesystem sandbox beyond cwd confinement (a validator can read any file the OS user can, including secrets outside the workspace); allowlisted commands execute repository code (tests/scripts) the implementer may legitimately edit — the control is review, sensitive-path rules and digest-bound results, not prevention. Redaction is pattern-based.

## 9. Test list (H3)

allowed command passes · exit≠0 ⇒ FAILED + finding · spawn error ⇒ ERROR · timeout ⇒ ERROR + process group killed · missing binary · cwd symlink escape · env var not allowlisted absent · secret value in output masked · output cap truncation recorded · validator definition edited ⇒ `PIN_MISMATCH` · agent-claimed pass ignored · result for old snapshot not reusable · snapshot drift during run ⇒ invalidated · dirty tree at issuance refused · chain of custody between tasks · BASELINE_DRIFT after out-of-band edit · approved dirty baseline reaches reviewer · ignored file hashed but content absent from patch · ignored change ⇒ IGNORED_FILE_CHANGED · exclusion visible as EXCLUDED_BY_POLICY · required validator missing ⇒ no review · protected-path diff ⇒ suspension before validators.
