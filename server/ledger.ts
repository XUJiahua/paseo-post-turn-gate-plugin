import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunStatus, Verdict } from "../shared/schema.ts";
import { TERMINAL_STATUSES } from "../shared/schema.ts";

export interface RoundRecord {
  round: number;
  check: "review" | "verify";
  childAgentId: string;
  verdict: Verdict["verdict"] | null;
  summary: string | null;
  reason?: Verdict["inconclusive_reason"];
}

export interface Run {
  run_id: string;
  source_agent_id: string;
  source_turn_key: string;
  workspace_id: string;
  repo_root: string;
  policy_hash: string;
  policy_json: string;
  request_text: string;
  base_tree: string;
  end_tree: string;
  status: RunStatus;
  round: number;
  step: number; // index into the policy's checks for the current round
  child_agent_id: string | null;
  dispatch_json: string | null; // exact create payload, replayed on recovery
  deadline_at: number | null;
  verdict: string | null;
  result_json: string | null;
  reviewer_changes: string | null;
  /** JSON array of other agents whose turns overlapped this task in the same repository. */
  concurrent_agents: string | null;
  /** JSON {title, nudged}: the current checker's denied permission request, and whether it was nudged for a verdict. */
  blocked_json: string | null;
  /** The agent's reply when a fix round changed nothing and disputed the findings. */
  dispute: string | null;
  rounds_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** A task that spans several turns (answered questions, retries); see docs/turn-outcomes.md §4. */
export interface Chain {
  agent_id: string;
  chain_id: string;
  workspace_id: string;
  repo_root: string;
  policy_json: string;
  policy_hash: string;
  base_tree: string;
  request_text: string;
  retries: number;
  answers: number;
  last_question: string | null;
  stop_answering: number;
  next_retry_at: number | null;
  retry_message: string | null;
  answer_child_id: string | null;
  answer_dispatch_json: string | null;
  answer_deadline_at: number | null;
  card_json: string | null;
  /** Outcome cards of the chain are numbered: each new event gets a card at the current timeline position. */
  card_seq: number;
  /** Fix rounds a gate run of this chain already used (a fix turn that asked a question continues as a chain). */
  rounds_used: number;
  /** A scheduled answerer start (answer.delay_seconds), with the reply and signal it will be given. */
  answer_at: number | null;
  answer_reply: string | null;
  answer_signal: string | null;
  created_at: number;
  updated_at: number;
}

/** Unchecked changes of a superseded run, handed to the source agent's next gated turn. */
export interface Carry {
  agent_id: string;
  repo_root: string;
  base_tree: string;
  request_text: string;
  /** Fix rounds the task already used, so a carried task does not start with a fresh budget. */
  rounds_used: number;
  /** Tree a check already failed or disputed; a later turn ending on the same tree is not checked again. */
  checked_tree: string | null;
  created_at: number;
}

const CHAIN_COLUMNS = [
  "workspace_id",
  "repo_root",
  "policy_json",
  "policy_hash",
  "base_tree",
  "request_text",
  "retries",
  "answers",
  "last_question",
  "stop_answering",
  "next_retry_at",
  "retry_message",
  "answer_child_id",
  "answer_dispatch_json",
  "answer_deadline_at",
  "card_json",
  "card_seq",
  "rounds_used",
  "answer_at",
  "answer_reply",
  "answer_signal",
] as const;

/** Automation state of a chain, cleared when a chain starts or ends. */
const CHAIN_RESET = {
  retries: 0,
  answers: 0,
  last_question: null,
  stop_answering: 0,
  next_retry_at: null,
  retry_message: null,
  answer_child_id: null,
  answer_dispatch_json: null,
  answer_deadline_at: null,
  card_json: null,
  card_seq: 0,
  answer_at: null,
  answer_reply: null,
  answer_signal: null,
} as const;

/**
 * A source agent's task row: the task's scope (repo, baseline, request, fix rounds used), shared by its carry and
 * its chain; `carried_at` marks unchecked changes waiting for the next turn; `chain_id` a running chain.
 */
interface TaskRow extends Omit<Chain, "chain_id" | "workspace_id" | "repo_root" | "policy_json" | "policy_hash" | "base_tree" | "request_text"> {
  chain_id: string | null;
  chain_created_at: number | null;
  workspace_id: string | null;
  repo_root: string | null;
  policy_json: string | null;
  policy_hash: string | null;
  base_tree: string | null;
  request_text: string | null;
  checked_tree: string | null;
  carried_at: number | null;
  turn_json: string | null;
  turn_at: number | null;
}

export type NewRun = Pick<
  Run,
  | "run_id"
  | "source_agent_id"
  | "source_turn_key"
  | "workspace_id"
  | "repo_root"
  | "policy_hash"
  | "policy_json"
  | "request_text"
  | "base_tree"
  | "end_tree"
  | "concurrent_agents"
>;

const COLUMNS = [
  "run_id",
  "source_agent_id",
  "source_turn_key",
  "workspace_id",
  "repo_root",
  "policy_hash",
  "policy_json",
  "request_text",
  "base_tree",
  "end_tree",
  "status",
  "round",
  "step",
  "child_agent_id",
  "dispatch_json",
  "deadline_at",
  "verdict",
  "result_json",
  "reviewer_changes",
  "concurrent_agents",
  "blocked_json",
  "dispute",
  "rounds_json",
  "error",
  "created_at",
  "updated_at",
] as const;

export function defaultLedgerPath(): string {
  const home = process.env.PASEO_HOME ?? path.join(process.env.HOME ?? ".", ".paseo");
  return path.join(home, "plugin-data", "post-turn-gate", "ledger.sqlite");
}

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS gate_runs (
        run_id TEXT PRIMARY KEY,
        source_agent_id TEXT NOT NULL,
        source_turn_key TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        request_text TEXT NOT NULL,
        base_tree TEXT NOT NULL,
        end_tree TEXT NOT NULL,
        status TEXT NOT NULL,
        round INTEGER NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        child_agent_id TEXT,
        dispatch_json TEXT,
        deadline_at INTEGER,
        verdict TEXT,
        result_json TEXT,
        reviewer_changes TEXT,
        concurrent_agents TEXT,
        blocked_json TEXT,
        dispute TEXT,
        rounds_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gate_runs_child ON gate_runs(child_agent_id);
      CREATE INDEX IF NOT EXISTS gate_runs_source_status ON gate_runs(source_agent_id, status);
      -- One row per source agent for the task it is working on: the running turn's frozen snapshot, unchecked
      -- changes handed to its next turn (carry), and the automation of a task chain (answers, retries).
      -- Replaces the chains, carries and turn_snapshots tables of earlier releases.
      CREATE TABLE IF NOT EXISTS tasks (
        agent_id TEXT PRIMARY KEY,
        repo_root TEXT,
        workspace_id TEXT,
        base_tree TEXT,
        request_text TEXT,
        rounds_used INTEGER NOT NULL DEFAULT 0,
        checked_tree TEXT,
        carried_at INTEGER,
        chain_id TEXT UNIQUE,
        chain_created_at INTEGER,
        policy_json TEXT,
        policy_hash TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        answers INTEGER NOT NULL DEFAULT 0,
        last_question TEXT,
        stop_answering INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        retry_message TEXT,
        answer_child_id TEXT,
        answer_dispatch_json TEXT,
        answer_deadline_at INTEGER,
        card_json TEXT,
        card_seq INTEGER NOT NULL DEFAULT 0,
        answer_at INTEGER,
        answer_reply TEXT,
        answer_signal TEXT,
        turn_json TEXT,
        turn_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chain_children (
        child_agent_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        chain_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gate_children (
        child_agent_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        round INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config_errors (
        agent_id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        error TEXT NOT NULL
      );
    `);
    // Ledgers created by older releases lack newer columns.
    const migrate = (table: string, added: Record<string, string>) => {
      const existing = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      for (const [column, type] of Object.entries(added)) {
        if (!existing.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    };
    migrate("gate_runs", {
      step: "INTEGER NOT NULL DEFAULT 0",
      concurrent_agents: "TEXT",
      blocked_json: "TEXT",
      dispute: "TEXT",
    });
    this.importOldTables();
  }

  /** Records a reviewer/verifier agent id before it is created, so its events are never mistaken for a source. */
  addChild(childAgentId: string, runId: string, round: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO gate_children (child_agent_id, run_id, round) VALUES (?, ?, ?)")
      .run(childAgentId, runId, round);
  }

  /** The run that owns this child agent, with the round it served; null for non-gate agents. */
  child(childAgentId: string): { run: Run; round: number } | null {
    const row = this.db
      .prepare("SELECT run_id, round FROM gate_children WHERE child_agent_id = ?")
      .get(childAgentId) as { run_id: string; round: number } | undefined;
    if (!row) return null;
    const run = this.get(row.run_id);
    return run ? { run, round: row.round } : null;
  }

  /** Inserts a DISPATCHING run starting at `round`; false when this source turn already has one. */
  claim(run: NewRun, now: number, round = 1): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO gate_runs
          (run_id, source_agent_id, source_turn_key, workspace_id, repo_root, policy_hash, policy_json,
           request_text, base_tree, end_tree, concurrent_agents, status, round, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISPATCHING', ?, ?, ?)`,
      )
      .run(
        run.run_id,
        run.source_agent_id,
        run.source_turn_key,
        run.workspace_id,
        run.repo_root,
        run.policy_hash,
        run.policy_json,
        run.request_text,
        run.base_tree,
        run.end_tree,
        run.concurrent_agents,
        round,
        now,
        now,
      );
    return result.changes === 1;
  }

  update(runId: string, patch: Partial<Omit<Run, "run_id">>, now: number): Run {
    const entries = Object.entries({ ...patch, updated_at: now }).filter(([key]) =>
      (COLUMNS as readonly string[]).includes(key),
    );
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => (value === undefined ? null : value)) as Array<
      string | number | null
    >;
    this.db.prepare(`UPDATE gate_runs SET ${assignments} WHERE run_id = ?`).run(...values, runId);
    const updated = this.get(runId);
    if (!updated) throw new Error(`gate run ${runId} not found`);
    return updated;
  }

  get(runId: string): Run | null {
    return (this.db.prepare("SELECT * FROM gate_runs WHERE run_id = ?").get(runId) as Run | undefined) ?? null;
  }

  active(): Run[] {
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM gate_runs WHERE status NOT IN (${placeholders}) ORDER BY created_at`)
      .all(...TERMINAL_STATUSES) as unknown as Run[];
  }

  activeForSource(sourceAgentId: string): Run[] {
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT * FROM gate_runs WHERE source_agent_id = ? AND status NOT IN (${placeholders}) ORDER BY created_at`,
      )
      .all(sourceAgentId, ...TERMINAL_STATUSES) as unknown as Run[];
  }

  // ---------- tasks: chains, carries and turn snapshots share one row per agent ----------

  private row(agentId: string): TaskRow | null {
    return (this.db.prepare("SELECT * FROM tasks WHERE agent_id = ?").get(agentId) as TaskRow | undefined) ?? null;
  }

  /** Inserts the agent's row if it has none, then applies `patch`. */
  private upsert(agentId: string, patch: Partial<Omit<TaskRow, "agent_id" | "created_at" | "updated_at">>, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO tasks (agent_id, created_at, updated_at) VALUES (?, ?, ?)").run(agentId, now, now);
    const entries = Object.entries(patch);
    const assignments = [...entries.map(([key]) => `${key} = ?`), "updated_at = ?"].join(", ");
    const values = entries.map(([, value]) => (value === undefined ? null : value)) as Array<string | number | null>;
    this.db.prepare(`UPDATE tasks SET ${assignments} WHERE agent_id = ?`).run(...values, now, agentId);
  }

  /** Drops a row that no longer holds a turn snapshot, a carry or a chain. */
  private prune(agentId: string): void {
    this.db
      .prepare("DELETE FROM tasks WHERE agent_id = ? AND turn_json IS NULL AND carried_at IS NULL AND chain_id IS NULL")
      .run(agentId);
  }

  private static asChain(row: TaskRow | undefined | null): Chain | null {
    if (!row?.chain_id) return null;
    return {
      ...(row as unknown as Omit<Chain, "chain_id" | "created_at">),
      chain_id: row.chain_id,
      created_at: row.chain_created_at ?? row.created_at,
    };
  }

  chain(agentId: string): Chain | null {
    return Ledger.asChain(this.row(agentId));
  }

  chainById(chainId: string): Chain | null {
    return Ledger.asChain(this.db.prepare("SELECT * FROM tasks WHERE chain_id = ?").get(chainId) as TaskRow | undefined);
  }

  chains(): Chain[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE chain_id IS NOT NULL ORDER BY chain_created_at").all() as unknown as TaskRow[]).map(
      (row) => Ledger.asChain(row)!,
    );
  }

  /** Starts a chain on the agent's task; a previous chain's automation state is reset. */
  createChain(
    chain: Pick<Chain, "agent_id" | "chain_id" | "workspace_id" | "repo_root" | "policy_json" | "policy_hash" | "base_tree" | "request_text">,
    now: number,
  ): Chain {
    const { agent_id, ...fields } = chain;
    this.upsert(agent_id, { ...fields, ...CHAIN_RESET, rounds_used: 0, chain_created_at: now }, now);
    return this.chain(agent_id)!;
  }

  updateChain(agentId: string, patch: Partial<Pick<Chain, (typeof CHAIN_COLUMNS)[number]>>, now: number): Chain | null {
    if (!this.chain(agentId)) return null;
    const entries = Object.entries(patch).filter(([key]) => (CHAIN_COLUMNS as readonly string[]).includes(key));
    this.upsert(agentId, Object.fromEntries(entries), now);
    return this.chain(agentId);
  }

  /** Ends the agent's chain; a carry or turn snapshot on the same task stays. */
  deleteChain(agentId: string): void {
    if (!this.chain(agentId)) return;
    this.upsert(agentId, { chain_id: null, chain_created_at: null, policy_json: null, policy_hash: null, ...CHAIN_RESET }, Date.now());
    this.prune(agentId);
  }

  addChainChild(childAgentId: string, agentId: string, chainId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO chain_children (child_agent_id, agent_id, chain_id) VALUES (?, ?, ?)")
      .run(childAgentId, agentId, chainId);
  }

  /** Answerer agents: the source agent and chain they serve (the chain may already be gone). */
  chainChild(childAgentId: string): { agentId: string; chainId: string } | null {
    const row = this.db
      .prepare("SELECT agent_id, chain_id FROM chain_children WHERE child_agent_id = ?")
      .get(childAgentId) as { agent_id: string; chain_id: string } | undefined;
    return row ? { agentId: row.agent_id, chainId: row.chain_id } : null;
  }

  // ---------- config error cards ----------

  /** The config error card last shown to an agent, so it can be marked fixed once the policy is valid. */
  configError(agentId: string): { card_id: string; error: string } | null {
    return (this.db.prepare("SELECT card_id, error FROM config_errors WHERE agent_id = ?").get(agentId) as
      | { card_id: string; error: string }
      | undefined) ?? null;
  }

  setConfigError(agentId: string, cardId: string, error: string): void {
    this.db.prepare("INSERT OR REPLACE INTO config_errors (agent_id, card_id, error) VALUES (?, ?, ?)").run(agentId, cardId, error);
  }

  deleteConfigError(agentId: string): void {
    this.db.prepare("DELETE FROM config_errors WHERE agent_id = ?").run(agentId);
  }

  // ---------- carries ----------

  /**
   * Records the unchecked changes of a run for the agent's next gated turn. An existing carry keeps its
   * baseline and request (it is older, so they already cover the new run's changes); rounds, checked tree and
   * age follow the newest run.
   */
  setCarry(carry: Omit<Carry, "created_at">, now: number): void {
    const existing = this.carry(carry.agent_id);
    this.upsert(
      carry.agent_id,
      existing
        ? { rounds_used: Math.max(existing.rounds_used, carry.rounds_used), checked_tree: carry.checked_tree, carried_at: now }
        : {
            repo_root: carry.repo_root,
            base_tree: carry.base_tree,
            request_text: carry.request_text,
            rounds_used: carry.rounds_used,
            checked_tree: carry.checked_tree,
            carried_at: now,
          },
      now,
    );
  }

  carry(agentId: string): Carry | null {
    const row = this.row(agentId);
    if (row?.carried_at == null || !row.repo_root || row.base_tree === null || row.request_text === null) return null;
    return {
      agent_id: agentId,
      repo_root: row.repo_root,
      base_tree: row.base_tree,
      request_text: row.request_text,
      rounds_used: row.rounds_used,
      checked_tree: row.checked_tree,
      created_at: row.carried_at,
    };
  }

  /** The carry was handed on; a chain of the same task keeps the shared baseline and request. */
  deleteCarry(agentId: string): void {
    if (!this.carry(agentId)) return;
    this.upsert(agentId, { carried_at: null, checked_tree: null }, Date.now());
    this.prune(agentId);
  }

  // ---------- turn snapshots ----------

  /** The policy and baseline frozen at a running turn's start, so a plugin restart mid-turn still gates it. */
  setTurnSnapshot(agentId: string, snapshotJson: string, now: number): void {
    this.upsert(agentId, { turn_json: snapshotJson, turn_at: now }, now);
  }

  turnSnapshot(agentId: string): { snapshot_json: string; created_at: number } | null {
    const row = this.row(agentId);
    return row?.turn_json ? { snapshot_json: row.turn_json, created_at: row.turn_at ?? row.created_at } : null;
  }

  deleteTurnSnapshot(agentId: string): void {
    const row = this.row(agentId);
    if (!row?.turn_json) return;
    this.upsert(agentId, { turn_json: null, turn_at: null }, Date.now());
    this.prune(agentId);
  }

  /** Moves rows of the chains, carries and turn_snapshots tables of earlier releases into tasks. */
  private importOldTables(): void {
    const tables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name),
    );
    this.db.exec("BEGIN");
    try {
      if (tables.has("chains")) {
        for (const chain of this.db.prepare("SELECT * FROM chains").all() as unknown as Chain[]) {
          const { agent_id, created_at, updated_at: _updated, ...fields } = chain;
          const known = Object.fromEntries(Object.entries(fields).filter(([key]) => key === "chain_id" || (CHAIN_COLUMNS as readonly string[]).includes(key)));
          this.upsert(agent_id, { ...known, chain_created_at: created_at }, created_at);
        }
        this.db.exec("DROP TABLE chains");
      }
      if (tables.has("carries")) {
        for (const carry of this.db.prepare("SELECT * FROM carries").all() as unknown as Carry[]) {
          this.setCarry({ ...carry, rounds_used: carry.rounds_used ?? 0, checked_tree: carry.checked_tree ?? null }, carry.created_at);
        }
        this.db.exec("DROP TABLE carries");
      }
      if (tables.has("turn_snapshots")) {
        const rows = this.db.prepare("SELECT * FROM turn_snapshots").all() as Array<{ agent_id: string; snapshot_json: string; created_at: number }>;
        for (const row of rows) this.setTurnSnapshot(row.agent_id, row.snapshot_json, row.created_at);
        this.db.exec("DROP TABLE turn_snapshots");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
