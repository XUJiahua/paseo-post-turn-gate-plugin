import assert from "node:assert/strict";
import { test } from "node:test";
import type { Verdict } from "../shared/schema.ts";
import { policySchema } from "../shared/schema.ts";
import { decideCheck, normalizeVerdict } from "./decisions.ts";

const policy = (extra: Record<string, unknown> = {}) =>
  policySchema.parse({ version: 3, ...extra });
const verdict = (v: Verdict["verdict"], reason: Verdict["inconclusive_reason"] = null): Verdict => ({
  verdict: v,
  summary: "",
  findings: [],
  inconclusive_reason: reason,
});

test("decideCheck: order, independent failure evidence and human boundaries", () => {
  const p = policy();
  const pass = verdict("PASS");
  assert.deepEqual(decideCheck({ policy: p, verdict: pass, step: 0, records: [] }), { kind: "next_check", step: 1 });
  const records = [{ check: "verify" as const, verdict: "PASS" as const }, { check: "review" as const, verdict: "PASS" as const }];
  assert.deepEqual(decideCheck({ policy: p, verdict: pass, step: 1, records }), { kind: "passed" });
  // INCONCLUSIVE does not stop the next check, and makes the round INCONCLUSIVE.
  const inc = verdict("INCONCLUSIVE", "no_test_infra");
  assert.deepEqual(decideCheck({ policy: p, verdict: inc, step: 0, records: [] }), { kind: "next_check", step: 1 });
  assert.deepEqual(
    decideCheck({ policy: p, verdict: pass, step: 1, records: [{ check: "verify", verdict: "INCONCLUSIVE", reason: "no_test_infra" }, records[1]] }),
    { kind: "inconclusive" },
  );
  assert.deepEqual(
    decideCheck({ policy: p, verdict: pass, step: 1, records: [{ check: "verify", verdict: "INCONCLUSIVE", reason: "ambiguous_request" }, records[1]] }),
    { kind: "needs_human", check: "verify", reason: "ambiguous_request" },
  );
  // A FAIL stops this run; only the decider writes the follow-up.
  assert.deepEqual(decideCheck({ policy: p, verdict: verdict("FAIL"), step: 0, records: [] }), { kind: "failed" });
});

test("normalizeVerdict: a denied permission explains an unexplained INCONCLUSIVE", () => {
  assert.equal(normalizeVerdict(verdict("INCONCLUSIVE"), true).inconclusive_reason, "blocked_permission");
  assert.equal(normalizeVerdict(verdict("INCONCLUSIVE"), false).inconclusive_reason, null);
  assert.equal(normalizeVerdict(verdict("INCONCLUSIVE", "other"), true).inconclusive_reason, "other");
});
