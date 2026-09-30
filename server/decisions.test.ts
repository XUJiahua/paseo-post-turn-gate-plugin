import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnswerReply, Verdict } from "../shared/schema.ts";
import { policySchema } from "../shared/schema.ts";
import { decideAnswer, decideCheck, normalizeVerdict } from "./decisions.ts";

const policy = (extra: Record<string, unknown> = {}) =>
  policySchema.parse({ version: 2, on_outcome: { done: ["verify", "review"] }, ...extra });
const verdict = (v: Verdict["verdict"], reason: Verdict["inconclusive_reason"] = null): Verdict => ({
  verdict: v,
  summary: "",
  findings: [],
  inconclusive_reason: reason,
});

test("decideCheck: order, failure handling and round budget", () => {
  const p = policy();
  const pass = verdict("PASS");
  assert.deepEqual(decideCheck({ policy: p, verdict: pass, step: 0, round: 1, records: [] }), { kind: "next_check", step: 1 });
  const records = [{ check: "verify" as const, verdict: "PASS" as const }, { check: "review" as const, verdict: "PASS" as const }];
  assert.deepEqual(decideCheck({ policy: p, verdict: pass, step: 1, round: 1, records }), { kind: "passed" });
  // INCONCLUSIVE does not stop the next check, and makes the round INCONCLUSIVE.
  const inc = verdict("INCONCLUSIVE", "no_test_infra");
  assert.deepEqual(decideCheck({ policy: p, verdict: inc, step: 0, round: 1, records: [] }), { kind: "next_check", step: 1 });
  assert.deepEqual(
    decideCheck({ policy: p, verdict: pass, step: 1, round: 1, records: [{ check: "verify", verdict: "INCONCLUSIVE", reason: "no_test_infra" }, records[1]] }),
    { kind: "inconclusive" },
  );
  assert.deepEqual(
    decideCheck({ policy: p, verdict: pass, step: 1, round: 1, records: [{ check: "verify", verdict: "INCONCLUSIVE", reason: "ambiguous_request" }, records[1]] }),
    { kind: "needs_human", check: "verify", reason: "ambiguous_request" },
  );
  // FAIL: fix while rounds are left (default 2), then used up; report mode never fixes.
  const fail = verdict("FAIL");
  assert.deepEqual(decideCheck({ policy: p, verdict: fail, step: 0, round: 1, records: [] }), { kind: "fix" });
  assert.deepEqual(decideCheck({ policy: p, verdict: fail, step: 1, round: 3, records: [] }), { kind: "rounds_used_up" });
  assert.deepEqual(decideCheck({ policy: policy({ on_fail: "report" }), verdict: fail, step: 0, round: 1, records: [] }), { kind: "failed" });
  // on_inconclusive fail: only gaps the agent can close count as FAIL.
  const strict = policy({ on_inconclusive: "fail" });
  assert.equal(decideCheck({ policy: strict, verdict: inc, step: 0, round: 1, records: [] }).kind, "fix");
  assert.equal(decideCheck({ policy: strict, verdict: verdict("INCONCLUSIVE", "env_missing"), step: 0, round: 1, records: [] }).kind, "next_check");
});

test("normalizeVerdict: a denied permission explains an unexplained INCONCLUSIVE", () => {
  assert.equal(normalizeVerdict(verdict("INCONCLUSIVE"), true).inconclusive_reason, "blocked_permission");
  assert.equal(normalizeVerdict(verdict("INCONCLUSIVE"), false).inconclusive_reason, null);
  assert.equal(normalizeVerdict(verdict("INCONCLUSIVE", "other"), true).inconclusive_reason, "other");
});

test("decideAnswer: send, escalate, and the plugin's own checks", () => {
  const reply = (patch: Partial<AnswerReply>): AnswerReply => ({ state: "awaiting_user", question: "A or B?", decision: "answer", answer: "A", reason: "", ...patch });
  const base = { fallbackQuestion: "card question", lastQuestion: null, risk: () => null, similar: () => false };
  assert.deepEqual(decideAnswer({ ...base, reply: reply({}) }), { kind: "send", question: "A or B?", text: "A", lastQuestion: "A or B?" });
  assert.deepEqual(decideAnswer({ ...base, reply: reply({ state: "incomplete", question: "" }) }), {
    kind: "send",
    question: "card question",
    text: "Continue.",
    lastQuestion: null,
  });
  assert.equal(decideAnswer({ ...base, reply: reply({ state: "done" }) }).kind, "done");
  assert.equal(decideAnswer({ ...base, reply: reply({ state: "refused" }) }).kind, "refused");
  assert.equal(decideAnswer({ ...base, reply: reply({ decision: "escalate" }) }).kind, "escalate");
  assert.equal(decideAnswer({ ...base, reply: reply({ answer: " " }) }).kind, "escalate");
  assert.equal(decideAnswer({ ...base, risk: () => "push", reply: reply({}) }).kind, "escalate");
  assert.equal(decideAnswer({ ...base, lastQuestion: "A or B?", similar: () => true, reply: reply({}) }).kind, "escalate");
});
