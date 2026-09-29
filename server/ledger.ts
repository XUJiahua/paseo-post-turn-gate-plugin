import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunStatus, Verdict } from "../shared/schema.ts";
import { TERMINAL_STATUSES } from "../shared/schema.ts";

export interface RoundRecord {
  round: number;
  childAgentId: string;
  verdict: Verdict["verdict"] | null;
  summary: string | null;
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
  child_agent_id: string | null;
  dispatch_json: string | null; // exact create payload, replayed on recovery
  deadline_at: number | null;
  verdict: string | null;
  result_json: string | null;
  reviewer_changes: string | null;
  rounds_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
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
  "child_agent_id",
  "dispatch_json",
  "deadline_at",
  "verdict",
  "result_json",
  "reviewer_changes",
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
        child_agent_id TEXT,
        dispatch_json TEXT,
        deadline_at INTEGER,
        verdict TEXT,
        result_json TEXT,
        reviewer_changes TEXT,
        rounds_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gate_runs_child ON gate_runs(child_agent_id);
      CREATE INDEX IF NOT EXISTS gate_runs_source_status ON gate_runs(source_agent_id, status);
      CREATE TABLE IF NOT EXISTS gate_children (
        child_agent_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        round INTEGER NOT NULL
      );
    `);
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

  /** Inserts a DISPATCHING run; false when this source turn already has one. */
  claim(run: NewRun, now: number): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO gate_runs
          (run_id, source_agent_id, source_turn_key, workspace_id, repo_root, policy_hash, policy_json,
           request_text, base_tree, end_tree, status, round, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISPATCHING', 1, ?, ?)`,
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

  close(): void {
    this.db.close();
  }
}
