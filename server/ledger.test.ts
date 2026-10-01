import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Ledger } from "./ledger.ts";

const chainFields = {
  agent_id: "a",
  chain_id: "c1",
  workspace_id: "ws",
  repo_root: "/repo",
  policy_json: "{}",
  policy_hash: "h",
  base_tree: "base",
  request_text: "do X",
};

test("revisions and unacknowledged dispatches survive ledger reopen and task pruning", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ptg-delivery-"));
  const file = path.join(dir, "ledger.sqlite");
  try {
    const first = new Ledger(file);
    assert.equal(first.invalidate("a"), 1);
    first.recordDispatch("a", "chain", "msg", "Continue", 10);
    first.close();
    const next = new Ledger(file);
    assert.equal(next.revision("a"), 1);
    assert.equal(next.unresolvedDispatches("a")[0].state, "pending");
    assert.throws(() => next.recordDispatch("a", "chain", "msg", "Continue", 20));
    next.updateDispatch("msg", "unknown", 21);
    next.pruneTask("a");
    assert.equal(next.invalidate("a"), 2);
    next.supersedeDispatches("a", 22);
    assert.deepEqual(next.unresolvedDispatches("a"), []);
    next.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a task's carry, chain and turn snapshot share one row and end independently", () => {
  const ledger = new Ledger(":memory:");
  ledger.setCarry({ agent_id: "a", repo_root: "/repo", base_tree: "base", request_text: "do X" }, 10);
  ledger.setTurnSnapshot("a", '{"turn":1}', 11);
  // A chain started from the carried turn keeps the task scope.
  ledger.createChain(chainFields, 12);
  ledger.updateChain("a", { answers: 1 }, 13);
  ledger.deleteCarry("a");
  assert.equal(ledger.carry("a"), null);
  assert.equal(ledger.chain("a")?.base_tree, "base");
  assert.equal(ledger.chain("a")?.answers, 1);
  assert.equal(ledger.chain("a")?.created_at, 12);
  assert.equal(ledger.chainById("c1")?.agent_id, "a");
  // Stopping the agent: a carry is recorded, then the chain ends; the carry survives it.
  ledger.setCarry({ agent_id: "a", repo_root: "/repo", base_tree: "base", request_text: "do X\n\nFollow-up" }, 14);
  ledger.deleteChain("a");
  assert.equal(ledger.chain("a"), null);
  assert.equal(ledger.carry("a")?.request_text, "do X\n\nFollow-up");
  // An existing carry keeps its baseline and request.
  ledger.setCarry({ agent_id: "a", repo_root: "/repo", base_tree: "newer", request_text: "other" }, 15);
  assert.deepEqual(
    { ...ledger.carry("a")! },
    { agent_id: "a", repo_root: "/repo", base_tree: "base", request_text: "do X\n\nFollow-up", created_at: 15 },
  );
  // The row goes away once nothing is left in it.
  ledger.deleteCarry("a");
  assert.equal(ledger.turnSnapshot("a")?.snapshot_json, '{"turn":1}');
  ledger.deleteTurnSnapshot("a");
  assert.equal(ledger.turnSnapshot("a"), null);
  assert.deepEqual(ledger.chains(), []);
  ledger.close();
});

test("task scope, decision state and pending dispatch survive reopening the ledger", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ptg-ledger-"));
  const file = path.join(dir, "ledger.sqlite");
  try {
    const ledger = new Ledger(file);
    const task = ledger.beginTask("a", 10);
    ledger.createChain(chainFields, 11);
    ledger.updateChain("a", { answers: 2, retries: 1, passed_tree: "passed", round_json: '{"seq":2,"phase":"merging"}', answer_child_id: "child", answer_dispatch_json: '{"agentId":"child"}' }, 12);
    ledger.setTurnSnapshot("a", '{"turnId":"next"}', 13);
    ledger.setTaskConcurrent("a", ["other"], 14);
    ledger.close();
    const reopened = new Ledger(file);
    assert.equal(reopened.taskId("a"), task);
    assert.equal(reopened.chain("a")?.answers, 2);
    assert.equal(reopened.chain("a")?.passed_tree, "passed");
    assert.equal(reopened.chain("a")?.answer_dispatch_json, '{"agentId":"child"}');
    assert.equal(reopened.turnSnapshot("a")?.snapshot_json, '{"turnId":"next"}');
    assert.deepEqual(reopened.taskConcurrent("a"), ["other"]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
