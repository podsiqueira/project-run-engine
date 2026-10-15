# Specification Analysis Report: Harness MVP, revision 2 (correction pass)

**Method**: the procedure of `templates/skills/speckit-analyze/SKILL.md`, applied manually (no `.specify/` scripts and no
`constitution.md` in this repository; `ARCHITECTURE.md` §2 and the package-boundary test stand in for the constitution).
Traceability numbers come from a script (regex over FR/AS/SC/T/D/OD ids and file references); the findings are a manual read.
**Deviation**: the skill says "no file writes"; this report is saved for Gate A review. Nothing else was modified by running it.
**Scope of this pass**: specification only. No code, checkpoint, runtime behaviour, Incito or Feature 009 content was touched. H1–H7 are **not** ticked.

## 1. Mechanical results

| Measure | Revision 1 (after its own fixes) | **Revision 2** |
|---|---|---|
| Functional requirements | 78 | **95** (FR-079…FR-095 added; 15 existing FRs reworded) |
| FRs with ≥ 1 task / ≥ 1 scenario | 78 / 78 | **95 / 95** |
| Acceptance scenarios | 68 | **96**, no gaps, no duplicates, all referenced by a task |
| Success criteria | 7 | **11** (SC-008…SC-011), all referenced |
| Tasks | 44 | **48** (T045–T048 added; T001–T044 unchanged ids), no duplicates, no unknown dependencies, no cycles |
| Undefined FR / D- / OD- references | 0 | 0 |
| Contracts | 7 | **8** (`path-matching.md` added) |
| Path-matching vectors | n/a | 30 (23 pure-matcher vectors plus 4 invalid-pattern cases cross-checked with a throw-away reference matcher kept outside the repository: 0 mismatches) |

Traceability means an id is cited, **not** that the scenario is adequate; adequacy is judged in §4.

## 2. Issues corrected in this pass (mapped to your six items)

| # | Your item | What was wrong | Correction (where) |
|---|---|---|---|
| 1 | Security boundary | Text implied the allowlist, protected paths and human-only operations *prevented* things | Enforcement classes **E1 engine-refused / E2 detected after the fact / E3 not enforced unless host or environment does** (FR-079, envelope contract §0). FR-003, 005, 020, 029, 030 reworded; `OPERATION_NOT_PERMITTED` only on visible evidence (FR-080); NG-10; risks R-9 rewritten, R-15, R-16 added; status must print the limitations; AS-04 rewritten, AS-69…AS-72; doc-lint test (T047). **Fixture hygiene** FR-081, SC-008, AS-71 (sanitised env, redirected `HOME`, canary secrets, no credential files) |
| 2 | Baseline integrity | "Absorb all pre-existing dirt into the baseline" and "exclude all VCS-ignored" could hide influence from the reviewer | Default **`CLEAN_REQUIRED`** at issuance; **chain of custody** on `treeDigest` between tasks, else `BASELINE_DRIFT` (FR-082); **evidence-backed `DirtyBaselineApproval`**, off by default, reviewer must answer `baselineInfluence` (FR-083); ignored files **hashed, never copied**, only policy-listed `ignoredExclusions` excluded and visible as `EXCLUDED_BY_POLICY`, ignored changes need a reviewer disposition (FR-084); validator side effects on ignored files recorded, not drift. D-04 revised, D-24, R-17, AS-73…AS-79 (AS-79: Feature 009 never used) |
| 3 | Pinning consistency | Whole-file `tasks.md` digest vs per-task digest vs checkbox tolerance | **No whole-file digest.** Canonical structural records per task (text, acceptance text, sorted deps/gates/markers), `parserVersion`, dependency-closure digests; checkbox, headings, order, prose excluded (FR-085). Diff rule: unchanged structural digests and only the **own** checkbox toggled (FR-086). FR-008/061/063 reworded; invalidation matrix rebuilt (envelope §7); D-25; AS-80…AS-84; R-20 |
| 4a | State vocabulary | `HarnessStep` looked like a second orchestrator | `HarnessStep` is an **embedded refinement**; closed **projection table** over (`state`, `lifecycle_status`, `pending_action`, step); anything else ⇒ `FAIL_CLOSED(STATE_INCOHERENT)` with zero writes; only human `reconcileCycle` (to `SUSPENDED`, never forward) (FR-087/088, controller §3a, invariant I8); `TASK_ACCEPTED` is transient, not at rest; held actions live in `heldAction` because the engine clears `pending_action` outside `AWAITING_AGENT_ACTION`; D-26; SC-010; AS-85/86; R-19 |
| 4b | Revocation recovery | R16 let a result be "received" although evaluation step 5 rejects the envelope first | Evaluation order now: …coherence (4) → ports (5) → **envelope validity (6)** → **pending action (7)**; §2a defines refusal without application, `SUBMISSION_REFUSED` (digest only), `HOLD`/`ABANDON` at revocation, restoration of the same `step_id` after re-authorisation (FR-089, D-27, R16 row rewritten, AS-87…AS-89) |
| 5a | OD-5 | Policy location undecided | **`.project-run/harness/policy.json`** (tracked, beside the tracked `.project-run/config.json`, distinct from the ignored `runs/` and `evidence/`; must be committed and unmodified at issuance; mandatory protected set built in) (FR-090, D-28, AS-90). Checked against `project-config.ts`, `bootstrap.ts`, `CONSUMER-GUIDE.md` |
| 5b | Limit relations | Policy ceiling, envelope limit, grants and amendment `GRANT` carry-over blurred "exactly three" | Ceiling 3 ≥ envelope limit = **initial attempts**; grants are **separate, additional, capped** authorisations; the amendment `budgetCarryOver: GRANT` option was **removed**; consumption shared per `(executionId, taskId)` across lineages so re-issuing never resets it (FR-041/045/091, envelope §5, remediation §2–3, AS-91). OD-6, OD-7 |
| 5c | `NO_PROGRESS` | Vague "strict reduction", no normalisation | Exact fingerprint (`fp1|category|file|criterion|ruleKey`, no lines/severity/wording), blocking *set*, progress ⇔ **proper subset**, streak counter, default 2, dispatch-failed attempts leave the set unchanged; **policy value is a floor** an envelope cannot weaken (`RECURRENCE_WEAKER_THAN_POLICY`) (FR-049/092, remediation §6, envelope §4a, AS-92/93, D-13) |
| 6a | AS-67 | Said suspension on the "third outcome" | Rewritten: the **second** rejected submission suspends; the first does not; FR-068, controller R5 and remediation table aligned |
| 6b | Glob/path semantics | Dialect undefined | New `contracts/path-matching.md`: POSIX only, anchored, case-sensitive, closed dialect (`*`, `?`, whole-segment `**`, trailing `/`), patterns rejected not rewritten, candidates validated not normalised, traversal/absolute/backslash/empty-segment/control-char rules, NFC and case-collision handling, deny-wins, symlink rules, 30 normative vectors (FR-093/094, SC-009, AS-94…AS-96, T046) |
| 6c | Exports | A subpath export was implied for the Node module | **No new exports, subpaths, `bin` or public types at Gate B**; `package.json` byte-identical (FR-077, FR-095, SC-011, AS-49 now P1, D-15, D-11 text); host/CLI exposure moved to Gate C (T048, OD-9) |

Also corrected for consistency while editing: `HarnessStep` type (no `TASK_ACCEPTED`), `SuspensionReason` catalogue (+ `BASELINE_*`, `IGNORED_FILE_CHANGED`, `PATH_AMBIGUOUS`, `SUBMISSION_REFUSED`, `LIMIT_REACHED`), data-model invariants 9–11, review contract (`ruleKey`, `baselineInfluence`, `ignoredFileDispositions`, `excludedByPolicy`), recovery table R1–R19, plan risk register R-9, R-15…R-20, scenario references AS-34/AS-61.

## 3. Unresolved items (separate from the corrections above)

### Owner decisions
| ID | Item | Blocks |
|---|---|---|
| **OD-1** | Boundary amendment: `node:crypto` in core, `node:child_process` only in `src/harness/node/` (internal, unexported) | **Gate B** |
| **OD-8** | Confirm the path-matching dialect, POSIX-only scope and the `CLEAN_REQUIRED` default baseline | **Gate B** |
| OD-2 | Preset-local transition edges (`INDEPENDENT_REVIEW|RE_REVIEW → IMPLEMENT`, `IMPLEMENT → REMEDIATION`, `REMEDIATION → REMEDIATION`) as the per-task loop | Gate B |
| OD-3 | Default `NO_PROGRESS` streak 2 | no (parameter) |
| OD-4 | No ledger compaction in the MVP | no |
| OD-6 | Cumulative grant cap (`maxGrantedAttemptsPerTask`, default 3 ⇒ at most 6 attempts per task) | no |
| OD-7 | Consumption shared across envelope lineages (a conservative reading of "per task and per envelope"; each attempt still records its envelope) | no |
| OD-9 | Host/CLI exposure of human-only operations deferred to Gate C | no |

### Verification gaps and risks that remain open
| ID | Item | Why it stays open |
|---|---|---|
| X7/R-13 | `coordinator.ts`, `host-dispatch-adapter.ts`, `bootstrap.ts`, `doctor.ts` and the engine's `resume` reconstruction (`suspended_from`) were not read line by line; the projection table and the carry-forward design rest on code comments, types and tests | needs the first Gate B task |
| R-14 | Interaction with the existing human-answer revalidation (commit `cdd4d41`): Harness suspensions are cleared only by typed operations, but the coexistence is unproven | exercised only at Gate B |
| R-7 | An older engine rewriting a Harness checkpoint drops the block; the tripwire only **detects** | inherent |
| R-9/R-15/R-16 | Human actors are unauthenticated; prohibited operations are denied by policy, not prevented; validators have no network/filesystem isolation | inherent to the MVP; documented as limits, not defects |
| R-17 | Contents of ignored files are never shown to the reviewer (only path + hash); `ignoredExclusions` are not examined | deliberate trade-off against secret leakage |
| R-18 | Hard links, bind mounts, Windows | not detected / unsupported |
| R-20 | Prose not following the Spec Kit task format is invisible to the parser | by design (no guessing) |
| A1 | `ruleKey` stability depends on reviewer discipline; fingerprints stay heuristic | mitigated, not eliminable |
| X5 | No performance budget for hashing large trees | add to the Gate B fixture |
| R-8 | Feature 009 H0 inconsistencies; excluded from every fixture, pilot and test, including its dirty working tree | separate review and authorisation |

## 4. Adequacy review of the highest-risk criteria (revision 2)

| Requirement | Scenarios | Adequate? | Remaining gap |
|---|---|---|---|
| Exactly 3 initial attempts, grants separate | AS-27…33, AS-91, AS-54 | Yes | multi-process restart proof needs T037 |
| `NO_PROGRESS` definition | AS-92, AS-93 | Yes (table tests) | fingerprint stability is heuristic (A1) |
| Honest enforcement boundary | AS-69…AS-72, AS-04 | Partly | doc-lint can only check wording, not that hosts behave |
| Clean baseline / chain of custody | AS-73…AS-79 | Yes | real-git edge cases (rename, submodule, large files) rely on T017 |
| Structural pinning | AS-80…AS-84, SC-007 | Yes | parser fidelity on real consumer files untested by design (no Feature 009) |
| State coherence | AS-85, AS-86, SC-010 | Yes (exhaustive property test) | resume reconstruction still unverified against engine code (X7) |
| Revocation with pending action | AS-87…AS-89 | Yes | host behaviour when a held `step_id` is never resubmitted is a policy question for Gate C |
| Path matching | AS-94…AS-96, SC-009 | Yes (30 vectors, adversarial timing) | hard links and bind mounts undetected |
| Package surface unchanged | AS-49, SC-011 | Yes | none |

## 5. Metrics (revision 2)

Requirements 95 · Success criteria 11 · Scenarios 96 · Tasks 48 (all future; H0 approved, H1–H7 unticked) · Traceability 100 % ·
Open owner decisions 8 (2 block Gate B) · Open risks listed above · Critical items open: **OD-1** (blocks Gate B).

## 6. Status after owner approval (2026-10-15)

The owner approved OD-1…OD-9 and formally concluded the H0–H7 specification phase (H1–H7 ticked). **Gate B remains blocked** until the pre-Gate-B technical review (T049, covering X7/R-13/R-14) and a new explicit authorisation. The owner noted the approval rests on this report, not on direct reading of the revision-2 files.

## 7. Next actions (superseded by §6 where they conflict)

1. Owner review of revision 2. If approved, tick H1–H7 (that is the Gate A act).
2. Owner decides OD-1 and OD-8 (block Gate B), and confirms OD-2, OD-6, OD-7.
3. Re-run this analysis after any further edit.
4. Do not start T003+ (or T049-dependent work) until Gate B is authorised in writing; Feature 009 stays excluded.
