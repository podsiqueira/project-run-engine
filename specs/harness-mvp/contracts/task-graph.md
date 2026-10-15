# Contract: Task Graph and Sequential Scheduler (H2)

Drives FR-011..FR-018, D-02, D-03, D-21.

## 1. Source and parsing

Source: the file named by `envelope.pins.tasks.path` (normally `specs/<feature>/tasks.md`), read-only, structurally pinned (below).
Recognised constructs (anything else is ignored and reported in `GraphParseReport.ignoredLines`, never guessed):

| Construct | Example | Meaning |
|---|---|---|
| Task line | `- [ ] T039 [US1] Implement …` / `- [x] T037 [P] [US1] …` | id `T\d{3,}`, checkbox, markers |
| Dependency clause | `DEPENDS ON T030, T032 AND T033` | explicit edges; separators `,` and `AND`; only `T###` tokens count |
| Gate marker | `OWNER GATE`, `STOP:` note | creates a required `GateDecision` |
| Phase heading | `## Phase 3: User Story 1` | label only (informational) |

Not inferred: order, phase barriers, `[P]` (parsed, ignored in the sequential MVP). Unstated dependencies are the
plan author's responsibility (risk R-4); `GraphParseReport` emits an `IMPLICIT_ORDER_RISK` warning when an unchecked task
precedes a task in the same phase without any declared edge, so the human sees it before authorising.

## 2. Types

```ts
interface TaskNode { id: string; title: string; fileChecked: boolean; markers: string[];
  dependsOn: string[]; gates: GateRef[]; definitionDigest: string; phaseLabel?: string; line: number }
interface TaskGraph { parserVersion: string; graphStructureDigest: string; nodes: TaskNode[]; report: GraphParseReport }  // no raw-bytes digest
type TaskHarnessState = "NOT_STARTED" | "IN_CYCLE" | "ACCEPTED" | "SUSPENDED" | "EXCLUDED";
interface TaskEligibilityDecision {
  taskId: string; eligible: boolean; evaluatedAt: string; revision: number; envelopeDigest: string;
  reasons: EligibilityReason[];  // all failing reasons, not only the first
}
type EligibilityReason =
  | "NOT_AUTHORIZED" | "DEPENDENCY_NOT_SATISFIED:<id>" | "GATE_NOT_SATISFIED:<gateId>"
  | "DEFINITION_CHANGED" | "DEPENDENCY_DEFINITION_CHANGED:<id>" | "BASELINE_DRIFT" | "ANOTHER_TASK_IN_CYCLE:<id>" | "ENVELOPE_NOT_ACTIVE" | "UPSTREAM_CHANGED:<id>"
  | "RECONCILIATION_REQUIRED" | "ALREADY_ACCEPTED" | "BUDGET_EXHAUSTED";
```

### Canonical structural digests (FR-085, FR-086; resolves the whole-file vs per-task conflict)

`tasks.md` is **never** pinned by raw bytes. The parser (identified by `parserVersion`) produces, per task, a **canonical record**:

```
{ id, description, acceptanceText, dependsOn: sorted ids, gates: sorted gate ids/kinds, markers: sorted (e.g. "P","US1") }
```
- `description` = the task line text after the id/markers, plus continuation lines up to the next task or heading, with Unicode NFC, all whitespace runs collapsed to one space, trimmed.
- `acceptanceText` = any `Acceptance:`/`Criteria:` sub-bullets belonging to the task (same normalisation); empty if none.
- Excluded from every digest: checkbox state (`[ ]`/`[x]`/`[X]`), line numbers, phase/section headings, unrelated prose, and ordering of tasks in the file.
- `definitionDigest(task)` = sha256(canonical JSON of its record, keys sorted, `parserVersion` included).
- `dependencyClosure(task)` = all transitive `dependsOn` ids; the envelope pins `taskDefinitionDigests` for authorised tasks and `dependencyClosureDigests` for every closure member that is not itself authorised.
- `graphStructureDigest` = sha256 over all canonical records sorted by id; used **only** to report `GRAPH_CHANGED_OUTSIDE_SCOPE` (informational), never to invalidate.
- A parser change that alters any digest for unchanged text is `PARSER_VERSION_CHANGED` and requires re-pinning; it is never absorbed silently.

**Checkbox reconciliation without invalidation.** After an implementation/remediation result, diff inspection of `tasks.md` (if modified) requires:
(a) recomputed canonical records for **all** tasks equal the pinned/previous ones (nothing but checkboxes changed), and (b) the set of toggled checkboxes ⊆ {dispatched task}. Otherwise `OUT_OF_SCOPE_CHANGE` (detected, E2). A human toggling checkboxes between cycles changes no pin; the ledger/file reconciliation of §5 still applies.

## 3. Validation (graph build)

Errors (all collected, graph rejected with `GRAPH_INVALID`): duplicate id · unknown dependency id · self-dependency · cycle (reported as the id path) · malformed id · reconciliation conflict (§5).

## 4. Eligibility and selection

Eligible ⇔ all of: authorised; every dependency satisfied (§5); every gate has a recorded `GateDecision` for `(gateId, taskId, definitionDigest)`; structural `definitionDigest` and its dependency-closure digests equal the pins (§2); envelope `ACTIVE`; no task `IN_CYCLE`; budget not exhausted-and-unresolved.
Selection: the eligible task with the smallest numeric id. The decision (with all reasons for ineligible *authorised* tasks) is appended as an event. The same inputs MUST always produce the same decision (pure function; time is an input, not read implicitly).

## 5. Completion and reconciliation (D-03)

Satisfied dependency ⇔ `TASK_ACCEPTED` event with valid pins, or `DependencyAttestation{taskIds[], actor, rationale, evidenceRef}`.
| File | Ledger | Result |
|---|---|---|
| checked | accepted/attested | consistent |
| unchecked | not accepted | consistent |
| checked | no acceptance/attestation | `RECONCILIATION_REQUIRED` (suspend; human attests or unchecks) |
| unchecked | accepted | `RECONCILIATION_REQUIRED` (agent toggle missing or reverted) |
The Harness never edits the file to fix either.

## 6. Sequential invariant

Cycle states per task: `NOT_STARTED → IN_CYCLE → ACCEPTED | SUSPENDED`; `SUSPENDED → IN_CYCLE` only through a human resume decision. `IN_CYCLE` count ≤ 1, checked under the lock at every boundary; a violation is `FAIL_CLOSED`. A `SUSPENDED` task **keeps the cycle slot** (`harness.cycle.step = SUSPENDED`); no other task is eligible (`ANOTHER_TASK_IN_CYCLE`) until the task is resumed to acceptance or removed from the envelope by an amendment (`EXCLUDED`).

## 7. Phase end

When no authorised task remains eligible: if all authorised tasks are `ACCEPTED` → `PHASE_END` stop point (suspend for human decision; envelope → `COMPLETED` only on human confirmation); if some are blocked → suspend listing reasons. **OD-14 (approved 2026-10-15)**: `PHASE_END` is a mandatory stop point; the execution stays suspended and continues only through an explicit human `GateDecision{PHASE_END}` plus a new/amended ACTIVE envelope (harness-controller §10, FR-115). No hand-off to `CONVERGE`/`READY_FOR_PR` is authorised or specified (OD-17 approved 2026-10-15).

## 8. Test list (H2)

duplicate ids · unknown dep · self-dep · 3-cycle · malformed id · textual order not a dependency · `[P]` ignored · AND/comma dependency parsing · checkbox ticked without ledger · ledger without checkbox · definition edit changes digest · checkbox toggle does not · dependency-edge edit changes digest · gate edit changes digest · whitespace/reflow/heading/ordering changes do not · own-checkbox-only diff accepted · other task's checkbox toggled ⇒ OUT_OF_SCOPE_CHANGE · structural edit smuggled with a toggle ⇒ OUT_OF_SCOPE_CHANGE · parser version bump ⇒ PARSER_VERSION_CHANGED · deterministic selection · second task refused while one is in cycle · unauthorised task skipped · gate without decision · owner-gate task never auto-selected.
