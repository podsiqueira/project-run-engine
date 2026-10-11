// packages/project-run-engine/src/decision/human-answer-validation.ts
//
// Pure validation of the `humanAnswers` a host supplies on resume. Deliberately NOT part of
// the package barrel: it is an internal step of `reconstructResumeContext`.
//
// Scope: audit-trail quality and host feedback. It is NOT what keeps the workflow safe — an
// answer never clears a finding or advances the run; the responsible agent is always
// re-dispatched and only its fresh accepted result moves the workflow on. So this never
// decides whether a resume may proceed on the merits of an answer, only whether what is about
// to be written to the audit trail is well-formed.
//
// Contract:
//   - every `questionId` must be one of the questions the execution's current suspension asked
//     (`human_intervention.questions`). A checkpoint that carries no questions (written before
//     they were persisted) cannot be checked, so ids are not checked there;
//   - `answer` must be a string with non-whitespace content, and is recorded trimmed;
//   - inside ONE call, identical answers for a question collapse to one and different answers
//     for the same question conflict (the call is rejected);
//   - ACROSS calls nothing is deduplicated: each call appends (a later answer is a correction,
//     and the audit trail keeps both; the latest answer per question is the effective one);
//   - one invalid entry rejects the whole call, so nothing is ever partially recorded;
//   - answering fewer questions than were asked is NOT validated here (a deliberate non-goal);
//   - diagnostics are bounded: a reflected `questionId` is clipped and stripped of control
//     characters, the list of valid ids and the list of problems are capped, and answer TEXT is
//     never echoed. There is deliberately no maximum length for an id itself: ids come from the
//     findings an agent reports (a "stable identity" with no length contract), so a limit would
//     reject ids the engine itself asked about. An id that is not a question of the suspension is
//     already rejected as UNKNOWN_QUESTION_ID, whatever its length.

import type { HumanAnswer, HumanQuestion } from "./human-intervention.js";

/** Longest `questionId` shown in a diagnostic; longer ones are clipped (and reported with their length). */
export const MAX_REFLECTED_ID_LENGTH = 64;
/** How many valid question ids a diagnostic lists before summarising the rest. */
const MAX_LISTED_IDS = 8;
/** How many problems a `failureReason` lists before summarising the rest. */
const MAX_LISTED_ISSUES = 20;

/** A host-supplied (or agent-derived) id as it may appear in a message: control characters neutralised, length bounded. */
function show(id: string): string {
  const printable = id.replace(/[\u0000-\u001f\u007f]/g, "?");
  return printable.length <= MAX_REFLECTED_ID_LENGTH
    ? printable
    : `${printable.slice(0, MAX_REFLECTED_ID_LENGTH)}...(${printable.length} chars)`;
}

export type HumanAnswerIssueCode =
  | "MALFORMED_ANSWER"
  | "UNKNOWN_QUESTION_ID"
  | "EMPTY_ANSWER"
  | "CONFLICTING_ANSWERS";

export interface HumanAnswerIssue {
  code: HumanAnswerIssueCode;
  questionId?: string;
  detail: string;
}

export type HumanAnswerValidation =
  | { ok: true; answers: HumanAnswer[] }
  | { ok: false; issues: HumanAnswerIssue[] };

export function validateHumanAnswers(
  submitted: readonly unknown[],
  questions: readonly HumanQuestion[] | undefined,
): HumanAnswerValidation {
  const knownIds = questions && questions.length > 0 ? new Set(questions.map((q) => q.id)) : undefined;
  const issues: HumanAnswerIssue[] = [];
  const accepted: HumanAnswer[] = [];
  const acceptedById = new Map<string, string>();
  const conflicted = new Set<string>();

  submitted.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      issues.push({ code: "MALFORMED_ANSWER", detail: `entry ${index} is not an object` });
      return;
    }
    const { questionId, answer } = entry as { questionId?: unknown; answer?: unknown };
    if (typeof questionId !== "string" || questionId.trim() === "") {
      issues.push({ code: "MALFORMED_ANSWER", detail: `entry ${index} has no questionId` });
      return;
    }
    if (typeof answer !== "string") {
      issues.push({ code: "MALFORMED_ANSWER", questionId, detail: `the answer to '${show(questionId)}' is not a string` });
      return;
    }
    if (knownIds && !knownIds.has(questionId)) {
      issues.push({
        code: "UNKNOWN_QUESTION_ID",
        questionId,
        detail: `'${show(questionId)}' is not a question of the current suspension (valid ids: ${listIds([...knownIds])})`,
      });
      return;
    }
    const trimmed = answer.trim();
    if (trimmed === "") {
      issues.push({ code: "EMPTY_ANSWER", questionId, detail: `the answer to '${show(questionId)}' is empty` });
      return;
    }

    const previous = acceptedById.get(questionId);
    if (previous !== undefined) {
      if (previous !== trimmed && !conflicted.has(questionId)) {
        conflicted.add(questionId);
        issues.push({
          code: "CONFLICTING_ANSWERS",
          questionId,
          detail: `'${show(questionId)}' is answered more than once in this call with different answers`,
        });
      }
      return; // identical repeat inside one call collapses to the first
    }
    acceptedById.set(questionId, trimmed);
    accepted.push({ ...(entry as HumanAnswer), answer: trimmed });
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, answers: accepted };
}

function listIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED_IDS).map(show).join(", ");
  return ids.length > MAX_LISTED_IDS ? `${shown}, and ${ids.length - MAX_LISTED_IDS} more` : shown;
}

/** The `failureReason` for a rejected call; starts with its failure code, like the lock/checkpoint codes. */
export function describeInvalidHumanAnswers(executionId: string, issues: readonly HumanAnswerIssue[]): string {
  return (
    `INVALID_HUMAN_ANSWERS: The humanAnswers supplied for execution '${executionId}' were rejected and nothing was recorded; ` +
    `the execution is unchanged and still waiting for answers. Fix the following and call again: ` +
    issues.slice(0, MAX_LISTED_ISSUES).map((i) => `${i.code}: ${i.detail}`).join("; ") +
    (issues.length > MAX_LISTED_ISSUES ? `; and ${issues.length - MAX_LISTED_ISSUES} more problems` : "") +
    "."
  );
}
