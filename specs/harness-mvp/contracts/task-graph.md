# Contract: Task Graph and Sequential Scheduler (H2)

Drives FR-011..FR-018, D-02, D-03, D-21.

## 1. Source and parsing

Source: the file named by `envelope.tasksSource.path` (normally `specs/<feature>/tasks.md`), read-only, digest-pinned.
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
interface TaskGraph { sourceDigest: string; nodes: TaskNode[]; report: GraphParseReport }
type TaskHarnessState = "NOT_STARTED" | "IN_CYCLE" | "ACCEPTED" | "SUSPENDED" | "EXCLUDED";
interface TaskEligibilityDecision {
  taskId: string; eligible: boolean; evaluatedAt: string; revision: number; envelopeDigest: string;
  reasons: EligibilityReason[];  // all failing reasons, not only the first
}
type EligibilityReason =
  | "NOT_AUTHORIZED" | "DEPENDENCY_NOT_SATISFIED:<id>" | "GATE_NOT_SATISFIED:<gateId>"
  | "DEFINITION_CHANGED" | "ANOTHER_TASK_IN_CYCLE:<id>" | "ENVELOPE_NOT_ACTIVE" | "UPSTREAM_CHANGED:<id>"
  | "RECONCILIATION_REQUIRED" | "ALREADY_ACCEPTED" | "BUDGET_EXHAUSTED";
```

`definitionDigest` = sha256 of the normalised task line plus its continuation lines (until the next task/heading), whitespace-normalised; the checkbox character is **excluded** so ticking the box does not change the digest.

## 3. Validation (graph build)

Errors (all collected, graph rejected with `GRAPH_INVALID`): duplicate id · unknown dependency id · self-dependency · cycle (reported as the id path) · malformed id · line numbering inconsistent with the digest · reconciliation conflict (§5).

## 4. Eligibility and selection

Eligible ⇔ all of: authorised; every dependency satisfied (§5); every gate has a recorded `GateDecision` for `(gateId, taskId, definitionDigest)`; definition digest equals the pin; envelope `ACTIVE`; no task `IN_CYCLE`; budget not exhausted-and-unresolved.
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

When no authorised task remains eligible: if all authorised tasks are `ACCEPTED` → `PHASE_END` stop point (suspend for human decision; envelope → `COMPLETED` only on human confirmation); if some are blocked → suspend listing reasons. The Harness never advances to `CONVERGE`/`READY_FOR_PR` unless **all feature tasks** are satisfied and a human has confirmed `PHASE_END`.

## 8. Test list (H2)

duplicate ids · unknown dep · self-dep · 3-cycle · malformed id · textual order not a dependency · `[P]` ignored · AND/comma dependency parsing · checkbox ticked without ledger · ledger without checkbox · definition edit changes digest · checkbox toggle does not · deterministic selection · second task refused while one is in cycle · unauthorised task skipped · gate without decision · owner-gate task never auto-selected.
