---
name: "project-engine-run"
description: "Drives a Project Run agent-orchestrated feature-delivery workflow using the CURRENT Claude Code session to perform each role's work — no nested Claude session is ever spawned. Use when the user asks to run, continue, or check the status of the project's delivery workflow for a named feature (e.g. '/project-engine-run \"004-campaigns-and-lead-attribution\"')."
compatibility: "Requires @incito-labs/project-run-engine installed in the target repository, with .project-run/config.json already initialized (see `project-run init`)."
metadata:
  author: "project-run-engine"
  source: "templates/host-integrations/claude-code/project-engine-run/SKILL.md"
---

## What this skill does

This skill drives the workflow using the **pull-based step API**
(`project-run engine next-step` / `submit-step`), not the push-based `start`/`resume`.
The difference matters:

- **Push-mode** (`engine start`/`resume`) runs the entire Coordinator loop inside one
  CLI process call, which internally needs a real `AgentRuntimeAdapter` to perform
  every dispatched role's work — something a single Bash-tool invocation from this
  same session structurally cannot provide (the subprocess can't pause mid-call and
  ask *you* to reason about something and hand the answer back).
- **Pull-mode** (`next-step`/`submit-step`) asks the engine for exactly one piece of
  work at a time, hands it to **you** (the live Claude Code session already in this
  conversation) to perform using your own tools, and takes the result back via a
  second, separate CLI call. **No adapter is ever needed or accepted in this mode —
  you are the agent runtime for this execution.**

**This skill never spawns a nested Claude session, never shells out to `claude -p`,
and never calls any Claude/Anthropic API.** Every piece of role-specific work below is
performed by continuing to use your own Read/Edit/Bash/Grep tools in this same
conversation — exactly as you would for any other task the user asked you to do.

## User Input

```text
$ARGUMENTS
```

Extract the feature name from `$ARGUMENTS` (e.g. `/project-engine-run
"004-campaigns-and-lead-attribution"` → feature `004-campaigns-and-lead-attribution`).
If no feature is given, ask the user which feature to run, or omit `feature` from the
payload below to let the engine auto-discover it from the current git branch.

## Outline

1. **Determine the repository root.** Use the current working directory, or ask the
   user if ambiguous. Pass it via `--dir <repo-root>` on every command below.

2. **Ask the engine what to do first.**

   ```bash
   project-run engine next-step --json '{"feature":"<feature-name>"}' --dir <repo-root>
   ```

   This prints exactly one JSON line — a `ProjectRunStepResponse`. The CLI's own exit
   code is 0 unless the `--json` payload itself was malformed; the actual workflow
   state lives in the parsed JSON's `status` field. **Record `executionId`** from the
   response — every subsequent call in this run needs it.

3. **Branch on `response.status`, and loop steps 3–5 until a terminal status:**

   - **`"AGENT_ACTION_REQUIRED"`**: `response.request` is an `AgentDispatchRequest`
     describing exactly one role's work (`role`, `state`, `context`, `skills`,
     `expected_output`). **Perform that work yourself, right now, in this
     conversation**, using your own tools:
     - `response.request.role` tells you which responsibility this is
       (`SPECIFICATION`, `ARCHITECTURE`, `IMPLEMENTATION`, `INDEPENDENT_REVIEW`,
       `REMEDIATION`, `CONVERGENCE`).
     - `response.request.skills`/`required_skills` name the Spec-Kit skill(s) this
       role should follow (e.g. `speckit-specify`, `speckit-plan`,
       `speckit-implement`) — these are the same skills under `.agents/skills/` or
       `.project-run/skills/` in the target repository; read and follow the matching
       `SKILL.md` for the work itself.
     - Do the actual work: write/update the spec, plan, tasks, implementation, review
       findings, remediation, or convergence assessment the role calls for, using
       Read/Edit/Bash/Grep as you normally would.
     - Build the result honestly. `status` is `"PASS"` only if you actually completed
       the work and it actually passed; `"FINDINGS"` if you found actionable issues
       (as structured findings, not prose); `"FAIL"` if you could not complete it;
       `"BLOCKED"` if you need a human decision to proceed (see `"HUMAN_INTERVENTION_
       REQUIRED"` below — this is initiated by *you* reporting `BLOCKED`, not by this
       skill itself). **Never report `"PASS"` because it would be convenient — the
       engine does not independently verify your word for most states, so an honest
       `FAIL`/`FINDINGS` here is what keeps the workflow trustworthy.**
     - Report it back:
       ```bash
       project-run engine submit-step --json '{"executionId":"<executionId>","stepId":"<response.stepId>","result":{"execution_id":"<executionId>","agent":"<role>","state":"<state>","status":"<PASS|FINDINGS|FAIL|BLOCKED>","evidence":[...],"findings":[...]}}' --dir <repo-root>
       ```
     - The response to THIS call is itself a fresh `ProjectRunStepResponse` — go back
       to the top of step 3 with it.

   - **`"HUMAN_INTERVENTION_REQUIRED"`**: go to step 4.
   - **`"BLOCKED_MISSING_SKILLS"`**: tell the user which skills are missing
     (`response.missingSkills`) and that `project-run init` or manually installing
     those skills is required before this can proceed. Do not retry automatically.
   - **`"FAILED"`**: if `response.terminal` is `true`, the execution itself cannot
     continue — report `response.failureReason` to the user plainly. If `false`, only
     the last call was rejected (e.g. a stale `stepId`) — report the reason and, if it
     was your own mistake (wrong `stepId`/`executionId`), call `next-step` again with
     the same `executionId` to recover the correct pending action rather than giving up.
   - **`"COMPLETED"`**: report success. `response.result.state` is `"READY_FOR_PR"`.

4. **Present human intervention questions.** `response.humanIntervention.questions` is
   an array of `{ id, question, context?, required }`. Present each `question` to the
   user (include `context` if present — it explains *why* this matters), in the order
   given. Collect the user's answer for each required question.

   **Never invent an answer. Never assume the workflow can proceed without one. Never
   directly mark the underlying finding resolved yourself** — the engine always
   re-dispatches the responsible role (back to step 3's `AGENT_ACTION_REQUIRED`) to
   independently verify the fix; the human's answer informs what you do differently
   when that happens, it does not substitute for actually redoing the work.

5. **Resume with the collected answers.**

   ```bash
   project-run engine next-step --json '{"executionId":"<executionId>","humanAnswers":[{"questionId":"<id>","answer":"<text>"}]}' --dir <repo-root>
   ```

   The response is a fresh `ProjectRunStepResponse` — almost always
   `"AGENT_ACTION_REQUIRED"` for the role whose finding triggered the suspension (go
   back to step 3 and actually redo that work in light of the answer). It may also
   still be `"HUMAN_INTERVENTION_REQUIRED"` if the answer didn't actually resolve
   anything ambiguous enough for you to act on — in that case, ask the user to
   clarify further rather than guessing.

6. **To check on a previously started execution without advancing it** (e.g. the user
   asks "what's the status of that run?" in a later turn, possibly after this session
   or a process restarted):

   ```bash
   project-run engine next-step --json '{"executionId":"<executionId>"}' --dir <repo-root>
   ```

   Omitting `humanAnswers` performs a pure, non-mutating read — this is also exactly
   how you recover after losing track of an in-progress run: the engine, not this
   conversation's memory, is the source of truth for `executionId`, the pending
   action, and everything that happened so far.

## Trying this skill out (demo)

Pull-mode never needs a mock adapter — there is no adapter at all, since *you* perform
the work. A minimal dry run: ask for the first step, then submit a trivial honest
`PASS` for it, and observe the workflow advance to the next role.

```bash
project-run engine next-step --json '{"executionId":"demo-1","feature":"demo-feature"}' --dir <repo-root>
# -> AGENT_ACTION_REQUIRED, role "SPECIFICATION", state "SPECIFY"

project-run engine submit-step --json '{"executionId":"demo-1","stepId":"<stepId from above>","result":{"execution_id":"demo-1","agent":"SPECIFICATION","state":"SPECIFY","status":"PASS","evidence":[],"findings":[]}}' --dir <repo-root>
# -> AGENT_ACTION_REQUIRED, role "SPECIFICATION", state "CLARIFY"
```

## Done When

- [ ] The feature name was determined (from `$ARGUMENTS` or auto-discovery)
- [ ] `engine next-step` was invoked and its JSON response was parsed; `executionId`
      was recorded
- [ ] Every `AGENT_ACTION_REQUIRED` response's work was actually performed in this
      session (not fabricated) before calling `submit-step`
- [ ] Every `HUMAN_INTERVENTION_REQUIRED` response's questions were presented to the
      user and real answers were collected (never invented)
- [ ] `engine next-step` with `humanAnswers` was invoked to resume, and its response
      was handled identically to step 3
- [ ] The user was told the final outcome in plain language (`COMPLETED`,
      `BLOCKED_MISSING_SKILLS` with the missing skills, or `FAILED` with the reason)
