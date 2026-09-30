import type { Check, Policy, Verdict } from "../shared/schema.ts";
import { gateChecks } from "../shared/schema.ts";

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
  | { kind: "failed" };

/** A denied permission explains an INCONCLUSIVE verdict that names no reason. */
export function normalizeVerdict(verdict: Verdict, permissionDenied: boolean): Verdict {
  return verdict.verdict === "INCONCLUSIVE" && !verdict.inconclusive_reason && permissionDenied
    ? { ...verdict, inconclusive_reason: "blocked_permission" }
    : verdict;
}

/**
 * What follows one check's verdict. `records` are the current round's results, this one included.
 * Checks run in order until one fails; INCONCLUSIVE does not stop the next check. A FAIL ends the run; the
 * decider writes what the agent should fix.
 */
export function decideCheck(input: { policy: Policy; verdict: Verdict; step: number; records: readonly CheckRecord[] }): CheckDecision {
  const { policy, verdict, step, records } = input;
  if (verdict.verdict === "FAIL") return { kind: "failed" };
  if (step + 1 < gateChecks(policy).length) return { kind: "next_check", step: step + 1 };
  const needsYou = records.find((record) => record.reason === "blocked_permission" || record.reason === "ambiguous_request");
  if (needsYou) return { kind: "needs_human", check: needsYou.check, reason: needsYou.reason as "blocked_permission" | "ambiguous_request" };
  return records.some((record) => record.verdict === "INCONCLUSIVE") ? { kind: "inconclusive" } : { kind: "passed" };
}
