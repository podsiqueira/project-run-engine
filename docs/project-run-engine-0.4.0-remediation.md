# `0.4.0` release-review remediation record

Closes the findings of the independent `0.4.0` release-readiness review (verdict
`READY_WITH_REQUIRED_ACTIONS`; no BLOCKER or HIGH findings). Scope is exactly the findings below: no
version bump, no publication, no tag, no merge, and no change to the deferred backlog (heartbeat, database
store, distributed locking, event-stream history, host integrations).

- Reviewed baseline: branch `claude/eloquent-archimedes-a7dhnf`, HEAD `8193910`, package `0.3.0`, clean tree.
- This record lives in `docs/` (the repository has no `docs/agent-orchestration/`).

| ID | Severity | Action | Status | Where |
|----|----------|--------|--------|-------|
| F1 | MEDIUM | Correct the push-`start` revision documentation. **Docs only; runtime unchanged.** | DONE | `ARCHITECTURE.md` §4.17.2 ("What is *not* revision-protected"), `CONSUMER-GUIDE.md` §11; behaviour pinned by `tests/state-store-contract.test.ts` ("initial push start is unconditional") |
| F2 | MEDIUM | Restore TypeScript compatibility for subclasses overriding `save(): Promise<void>`. `FileExecutionStateStore.save` is declared `Promise<void \| ExecutionSaveReceipt>` (it still always resolves the receipt; the engine consumes it through the `ExecutionStateStore` interface, unchanged). | DONE | `src/project/state-store.ts`; consumer-compile tests in `tests/public-api-surface.test.ts` + `tests/fixtures/consumer-types/` |
| F3 | LOW | Public export-surface test (root, `/domain`, `/project`, `/host`; runtime and declarations). | DONE | `tests/public-api-surface.test.ts` |
| F4 | LOW | Document that, when the store cannot be re-read after a failed write, `state` is a placeholder and not a confirmed durable state. | DONE | `ARCHITECTURE.md` §4.17.1, `CONSUMER-GUIDE.md` §6, doc comments in `src/host/types.ts` and `src/host/step-types.ts` |
| F5 | LOW | Document that push agent execution around a lost write is at-least-once. | DONE | `ARCHITECTURE.md` §4.17.1, `CONSUMER-GUIDE.md` §11 |
| F6 | LOW | Reconcile the advisory `FAILED` marker semantics with the host status documentation. | DONE | `ARCHITECTURE.md` §4.17.1, `CONSUMER-GUIDE.md` §11, `ProjectRunHostStatus` / `terminal` comments in `src/host/types.ts` |
| F7 | LOW | Stale comment, Phase 5 status wording, ENG-002 heading, tool-schema response semantics. | DONE | `src/host/project-run-step.ts`; `docs/phase-reports.md`; `docs/backlog.md`; `PROJECT_ENGINE_RUN_TOOL_SCHEMA.response_semantics` (`failure_code_field`, `failure_codes`, `failure_code_semantics`) |

## Notes

- **F1 decision.** Guarding the initial push `start` with `expectedRevision: 0` would make a reused
  `executionId` a `CHECKPOINT_CONFLICT`. That changes behaviour that `0.3.0` shipped, so it was not done; the
  documentation now states the real contract. It remains available as a future, deliberate change.
- **F2 decision.** Widening the declared type removes the TypeScript break instead of documenting it. Callers
  of the concrete class that want the revision narrow it (`if (receipt)`), as documented.
- **Release note.** The `READY_FOR_PR` crash-recovery bug fix is recorded in the `0.4.0` release notes in
  `docs/phase-reports.md` (the repository has no changelog file).
- **Left unchanged on purpose** (observations, not remediated): duplicate human-answer audit records after a
  later failed write, `created_at` being rewritten on save, write-guard cost, and every deferred backlog item.

## Verification

`npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, `npm pack --dry-run`, the package-boundary
test, and mutation checks of the new tests (reverting the F2 declaration, dropping a root re-export, dropping the
schema's failure codes, leaking an internal helper through `/project`, and guarding the initial push start) are
reported in the remediation hand-off; all of the mutants were killed.
