import type { AnswerReply, Check, Policy, Verdict } from "../shared/schema.ts";
import { gateChecks, maxFixRounds } from "../shared/schema.ts";

/**
 * Pure next-step decisions (guardrails of docs/completion-supervisor.md §8): state and results in,
 * the next step out, no side effects. The gate performs what they return.
 */

export interface CheckRecord {
  check: Check;
  verdict: Verdict["verdict"] | null;
  reason?: Verdict["inconclusive_reason"];
}

export type CheckDecision =
  | { kind: "next_check"; step: number }
  | { kind: "passed" }
  | { kind: "inconclusive" }
  | { kind: "needs_human"; check: Check; reason: "blocked_permission" | "ambiguous_request" }
  | { kind: "failed" } // report mode
  | { kind: "rounds_used_up" }
  | { kind: "fix" };

/** A denied permission explains an INCONCLUSIVE verdict that names no reason. */
export function normalizeVerdict(verdict: Verdict, permissionDenied: boolean): Verdict {
  return verdict.verdict === "INCONCLUSIVE" && !verdict.inconclusive_reason && permissionDenied
    ? { ...verdict, inconclusive_reason: "blocked_permission" }
    : verdict;
}

/**
 * What follows one check's verdict. `records` are the current round's results, this one included.
 * Checks run in order until one fails; INCONCLUSIVE does not stop the next check.
 */
export function decideCheck(input: {
  policy: Policy;
  verdict: Verdict;
  step: number;
  round: number;
  records: readonly CheckRecord[];
}): CheckDecision {
  const { policy, verdict, step, round, records } = input;
  const reason = verdict.inconclusive_reason;
  // on_inconclusive "fail" covers gaps the agent can close itself (tests, other evidence); a blocked
  // permission, an ambiguous request or a missing environment are not the agent's to fix.
  const failing =
    verdict.verdict === "FAIL" ||
    (verdict.verdict === "INCONCLUSIVE" && policy.on_inconclusive === "fail" && (reason === null || reason === "no_test_infra" || reason === "other"));
  if (failing) {
    if (maxFixRounds(policy) === 0) return { kind: "failed" };
    if (round - 1 >= maxFixRounds(policy)) return { kind: "rounds_used_up" };
    return { kind: "fix" };
  }
  if (step + 1 < gateChecks(policy).length) return { kind: "next_check", step: step + 1 };
  const needsYou = records.find((record) => record.reason === "blocked_permission" || record.reason === "ambiguous_request");
  if (needsYou) return { kind: "needs_human", check: needsYou.check, reason: needsYou.reason as "blocked_permission" | "ambiguous_request" };
  return records.some((record) => record.verdict === "INCONCLUSIVE") ? { kind: "inconclusive" } : { kind: "passed" };
}

export type AnswerDecision =
  | { kind: "done" }
  | { kind: "refused" }
  | { kind: "escalate"; question: string; reason: string }
  | { kind: "send"; question: string; text: string; lastQuestion: string | null };

/**
 * What follows an answerer's reply. `risk` is the plugin's own check of the answer (permissions.answerRisk);
 * `similar` compares the question with the last answered one.
 */
export function decideAnswer(input: {
  reply: AnswerReply;
  fallbackQuestion: string;
  lastQuestion: string | null;
  risk: (text: string) => string | null;
  similar: (a: string, b: string) => boolean;
}): AnswerDecision {
  const { reply, lastQuestion } = input;
  if (reply.state === "done") return { kind: "done" };
  if (reply.state === "refused") return { kind: "refused" };
  const question = reply.question.trim() || input.fallbackQuestion;
  if (reply.state === "awaiting_user" && reply.decision === "escalate") {
    return { kind: "escalate", question, reason: reply.reason || "the answerer handed this to you" };
  }
  const text = reply.state === "incomplete" ? "Continue." : reply.answer.trim();
  if (!text) return { kind: "escalate", question, reason: "the answerer gave no answer" };
  const risk = input.risk(`${question}\n${text}`);
  if (risk) return { kind: "escalate", question, reason: `not answered automatically: ${risk}` };
  if (reply.state === "awaiting_user" && lastQuestion && input.similar(question, lastQuestion)) {
    return { kind: "escalate", question, reason: "the agent asked the same question again after an automatic answer" };
  }
  return { kind: "send", question, text, lastQuestion: reply.state === "awaiting_user" ? question : lastQuestion };
}
