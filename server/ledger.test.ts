import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("a task's carry, chain and turn snapshot share one row and end independently", () => {
  const ledger = new Ledger(":memory:");
  ledger.setCarry({ agent_id: "a", repo_root: "/repo", base_tree: "base", request_text: "do X", rounds_used: 1, checked_tree: "t1" }, 10);
  ledger.setTurnSnapshot("a", '{"turn":1}', 11);
  // A chain started from the carried turn keeps the task scope; its rounds are set by the caller.
  ledger.createChain(chainFields, 12);
  ledger.updateChain("a", { rounds_used: 1, answers: 1 }, 13);
  ledger.deleteCarry("a");
  assert.equal(ledger.carry("a"), null);
  assert.equal(ledger.chain("a")?.base_tree, "base");
  assert.equal(ledger.chain("a")?.rounds_used, 1);
  assert.equal(ledger.chain("a")?.created_at, 12);
  assert.equal(ledger.chainById("c1")?.agent_id, "a");
  // Stopping the agent: a carry is recorded, then the chain ends; the carry survives it.
  ledger.setCarry({ agent_id: "a", repo_root: "/repo", base_tree: "base", request_text: "do X\n\nFollow-up", rounds_used: 1, checked_tree: null }, 14);
  ledger.deleteChain("a");
  assert.equal(ledger.chain("a"), null);
  assert.equal(ledger.carry("a")?.request_text, "do X\n\nFollow-up");
  // An existing carry keeps its baseline and request; rounds only grow.
  ledger.setCarry({ agent_id: "a", repo_root: "/repo", base_tree: "newer", request_text: "other", rounds_used: 0, checked_tree: "t2" }, 15);
  assert.deepEqual(
    { ...ledger.carry("a")! },
    { agent_id: "a", repo_root: "/repo", base_tree: "base", request_text: "do X\n\nFollow-up", rounds_used: 1, checked_tree: "t2", created_at: 15 },
  );
  // The row goes away once nothing is left in it.
  ledger.deleteCarry("a");
  assert.equal(ledger.turnSnapshot("a")?.snapshot_json, '{"turn":1}');
  ledger.deleteTurnSnapshot("a");
  assert.equal(ledger.turnSnapshot("a"), null);
  assert.deepEqual(ledger.chains(), []);
  ledger.close();
});

test("chains, carries and turn snapshots of an older ledger are moved into tasks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ptg-ledger-"));
  const file = path.join(dir, "ledger.sqlite");
  try {
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE chains (agent_id TEXT PRIMARY KEY, chain_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
        repo_root TEXT NOT NULL, policy_json TEXT NOT NULL, policy_hash TEXT NOT NULL, base_tree TEXT NOT NULL,
        request_text TEXT NOT NULL, retries INTEGER NOT NULL DEFAULT 0, answers INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO chains VALUES ('a', 'c1', 'ws', '/repo', '{}', 'h', 'base-a', 'req a', 1, 2, 100, 101);
      CREATE TABLE carries (agent_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, base_tree TEXT NOT NULL,
        request_text TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO carries VALUES ('b', '/repo', 'base-b', 'req b', 200);
      CREATE TABLE turn_snapshots (agent_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO turn_snapshots VALUES ('b', '{"t":1}', 300);
    `);
    old.close();
    const ledger = new Ledger(file);
    const chain = ledger.chain("a")!;
    assert.deepEqual([chain.chain_id, chain.base_tree, chain.retries, chain.answers, chain.created_at], ["c1", "base-a", 1, 2, 100]);
    assert.deepEqual([ledger.carry("b")?.base_tree, ledger.carry("b")?.rounds_used, ledger.carry("b")?.created_at], ["base-b", 0, 200]);
    assert.equal(ledger.turnSnapshot("b")?.snapshot_json, '{"t":1}');
    ledger.close();
    // The old tables are gone, so opening the ledger again imports nothing twice.
    const again = new Ledger(file);
    assert.equal(again.chains().length, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
