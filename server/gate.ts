import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { CardData, Policy, RunStatus, Verdict } from "../shared/schema.ts";
import {
  CARD_KIND,
  CARD_VERSION,
  POLICY_PATH,
  TERMINAL_STATUSES,
  VERDICT_JSON_SCHEMA,
  policySchema,
} from "../shared/schema.ts";
import { diffStat, snapshotTree, toplevel } from "./git.ts";
import type { Ledger, RoundRecord, Run } from "./ledger.ts";
import { buildFixPrompt, buildGatePrompt, latestAssistantText, parseVerdict } from "./prompts.ts";

export type Paseo = PluginHookContext["paseo"];
type TurnStarted = PluginLifecycleEvents["agent.turn_started"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type PermissionRequested = PluginLifecycleEvents["agent.permission_requested"];
type PermissionResolved = PluginLifecycleEvents["agent.permission_resolved"];
type TimelineItem = TurnEnded["timeline"][number];
type AgentSnapshot = NonNullable<
  Awaited<ReturnType<ReturnType<Paseo["agents"]["ref"]>["refresh"]>>
>["agent"];

export const MANAGED_LABEL = "post-turn-gate.managed";
export const TARGET_LABEL = "post-turn-gate.target";
const FIX_PREFIX = "ptg:";
const REQUEST_TEXT_LIMIT = 8000;

interface Pending {
  repoRoot: string;
  policy: Policy | null; // null: policy file is invalid
  policyJson: string;
  policyHash: string;
  error: string | null;
  baseTree: string | null;
}

export interface GateOptions {
  ledger: Ledger;
  now?: () => number;
  reviewTimeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export interface Gate {
  onTurnStarted(event: TurnStarted, paseo: Paseo): void;
  onTurnEnded(event: TurnEnded, paseo: Paseo): void;
  onPermission(event: PermissionRequested | PermissionResolved, paseo: Paseo, waiting: boolean): void;
  /** Advances unfinished runs from ledger state (startup recovery and timeouts). */
  reconcile(paseo: Paseo): void;
  /** Resolves when all queued work has finished (tests). */
  idle(): Promise<void>;
}

const isTerminal = (status: RunStatus) => TERMINAL_STATUSES.includes(status);

function lastUserMessage(timeline: readonly TimelineItem[]) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.type === "user_message") return item;
  }
  return null;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function createGate(options: GateOptions): Gate {
  const { ledger } = options;
  const now = options.now ?? Date.now;
  const reviewTimeoutMs = options.reviewTimeoutMs ?? 30 * 60 * 1000;
  const log = options.log ?? ((message, detail) => console.log(`[post-turn-gate] ${message}`, detail ?? ""));
  const pending = new Map<string, Pending>();
  const waiting = new Set<string>(); // run ids whose current child waits on a permission answer

  // ponytail: one global queue serializes all gate work; a slow agent create delays other agents' events.
  // Upgrade path: per-source-agent queues if this ever becomes a bottleneck.
  let tail: Promise<void> = Promise.resolve();
  function enqueue(label: string, work: () => Promise<void>): void {
    tail = tail.then(work).catch((error) => log(`${label} failed`, error instanceof Error ? error.stack : error));
  }

  // ---------- timeline card ----------

  function cardData(run: Run): CardData {
    const policy = JSON.parse(run.policy_json) as Policy;
    const verdict = run.result_json ? (JSON.parse(run.result_json) as Verdict) : null;
    const blocking = (verdict?.findings ?? []).filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
    const shown = blocking.slice(0, 10).map((f) => ({
      severity: f.severity,
      title: truncate(f.title, 300),
      evidence: truncate(f.evidence, 1000),
      suggested_fix: truncate(f.suggested_fix, 1000),
    }));
    const dispatch = run.dispatch_json ? (JSON.parse(run.dispatch_json) as { title?: string }) : null;
    return {
      status: run.status,
      action: policy.action === "none" ? null : policy.action,
      round: run.round,
      maxFixRounds: policy.review.on_fail === "fix" ? policy.review.max_fix_rounds : 0,
      waiting: waiting.has(run.run_id),
      summary: verdict ? truncate(verdict.summary, 2000) : null,
      findings: shown,
      otherFindings: (verdict?.findings.length ?? 0) - shown.length,
      childAgentId: run.child_agent_id,
      childTitle: dispatch?.title ?? null,
      reviewerChanges: run.reviewer_changes ? truncate(run.reviewer_changes, 2000) : null,
      error: run.error ? truncate(run.error, 2000) : null,
    };
  }

  async function publishCard(paseo: Paseo, run: Run): Promise<void> {
    await paseo.agents.ref(run.source_agent_id).timeline.append({
      type: "plugin",
      id: `post-turn-gate:${run.run_id}`,
      kind: CARD_KIND,
      version: CARD_VERSION,
      data: cardData(run),
    });
  }

  async function publishConfigError(paseo: Paseo, agentId: string, error: string): Promise<void> {
    const data: CardData = {
      status: "ERROR",
      action: null,
      round: 0,
      maxFixRounds: 0,
      waiting: false,
      summary: null,
      findings: [],
      otherFindings: 0,
      childAgentId: null,
      childTitle: null,
      reviewerChanges: null,
      error: truncate(`${POLICY_PATH}: ${error}`, 2000),
    };
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: `post-turn-gate:config:${agentId}`,
      kind: CARD_KIND,
      version: CARD_VERSION,
      data,
    });
  }

  async function transition(paseo: Paseo, run: Run, patch: Partial<Run>): Promise<Run> {
    const next = ledger.update(run.run_id, patch, now());
    if (isTerminal(next.status)) waiting.delete(next.run_id);
    await publishCard(paseo, next).catch((error) => log("card update failed", error));
    return next;
  }

  async function archiveChild(paseo: Paseo, childAgentId: string | null): Promise<void> {
    if (!childAgentId) return;
    await paseo.agents
      .ref(childAgentId)
      .archive()
      .catch((error) => log("archive child failed", error));
  }

  async function fail(paseo: Paseo, run: Run, error: string, patch: Partial<Run> = {}): Promise<void> {
    const next = await transition(paseo, run, { ...patch, status: "ERROR", error });
    await archiveChild(paseo, next.child_agent_id);
  }

  // ---------- policy ----------

  async function loadPending(cwd: string): Promise<Pending | null> {
    const repoRoot = await toplevel(cwd);
    if (!repoRoot) return null;
    let raw: string;
    try {
      raw = await readFile(path.join(repoRoot, POLICY_PATH), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const base = { repoRoot, policyHash: createHash("sha256").update(raw).digest("hex") };
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return { ...base, policy: null, policyJson: raw, error: `invalid JSON: ${(error as Error).message}`, baseTree: null };
    }
    const parsed = policySchema.safeParse(json);
    if (!parsed.success) {
      const error = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      return { ...base, policy: null, policyJson: raw, error, baseTree: null };
    }
    const policy = parsed.data;
    const baseTree = policy.action === "none" ? null : await snapshotTree(repoRoot);
    return { ...base, policy, policyJson: JSON.stringify(policy), error: null, baseTree };
  }

  function triggers(policy: Policy, agent: AgentSnapshot, isRoot: boolean): boolean {
    if (agent.labels[MANAGED_LABEL] === "true") return false;
    if (policy.trigger === "all") return true;
    if (policy.trigger === "root_only") return isRoot;
    return isRoot || agent.labels[TARGET_LABEL] === "true";
  }

  async function refreshAgent(paseo: Paseo, agentId: string): Promise<AgentSnapshot | null> {
    return (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
  }

  // ---------- dispatch ----------

  async function dispatch(paseo: Paseo, run: Run): Promise<void> {
    const policy = JSON.parse(run.policy_json) as Policy;
    if (policy.action === "none") return;
    const source = await refreshAgent(paseo, run.source_agent_id);
    if (!source) return fail(paseo, run, "source agent no longer exists");
    if (!source.model) return fail(paseo, run, "source agent has no resolved model to inherit");
    const childAgentId = randomUUID();
    const key = `${FIX_PREFIX}${run.run_id}:${run.round}`;
    const payload = {
      agentId: childAgentId,
      idempotencyKey: key,
      parent: run.source_agent_id,
      config: {
        provider: `${source.provider}/${source.model}`,
        ...(source.currentModeId ? { modeId: source.currentModeId } : {}),
        ...(source.thinkingOptionId ? { thinkingOptionId: source.thinkingOptionId } : {}),
        featureValues: Object.fromEntries((source.features ?? []).map((feature) => [feature.id, feature.value])),
      },
      title: `Gate ${policy.action} #${run.round} · ${source.title ?? run.source_agent_id.slice(0, 8)}`,
      prompt: buildGatePrompt({
        action: policy.action,
        requestText: run.request_text,
        repoRoot: run.repo_root,
        baseTree: run.base_tree,
        endTree: run.end_tree,
      }),
      clientMessageId: key,
      outputSchema: VERDICT_JSON_SCHEMA,
      labels: {
        [MANAGED_LABEL]: "true",
        "post-turn-gate.role": policy.action === "verify" ? "verifier" : "reviewer",
        "post-turn-gate.run-id": run.run_id,
      },
    };
    ledger.addChild(childAgentId, run.run_id, run.round);
    const claimed = await transition(paseo, run, {
      status: "DISPATCHING",
      child_agent_id: childAgentId,
      dispatch_json: JSON.stringify({ workspaceId: run.workspace_id, ...payload }),
      deadline_at: now() + reviewTimeoutMs,
      reviewer_changes: null,
    });
    await createChild(paseo, claimed);
  }

  /** Creates (or idempotently re-creates) the child recorded in dispatch_json. */
  async function createChild(paseo: Paseo, run: Run): Promise<void> {
    const { workspaceId, ...payload } = JSON.parse(run.dispatch_json ?? "{}");
    try {
      await paseo.workspaces.ref(workspaceId).agents.create(payload);
    } catch (error) {
      // The create may have happened before the failure; keep waiting on the child if it exists.
      const existing = await refreshAgent(paseo, payload.agentId).catch(() => null);
      if (!existing) return fail(paseo, run, `failed to start ${payload.title}: ${(error as Error).message}`);
    }
    await transition(paseo, run, { status: "REVIEWING" });
  }

  // ---------- results ----------

  async function finalizeReview(
    paseo: Paseo,
    run: Run,
    round: number,
    outcome: TurnEnded["outcome"],
    timeline: readonly TimelineItem[],
  ): Promise<void> {
    if (isTerminal(run.status) || run.status !== "REVIEWING" || run.round !== round) return;
    const childAgentId = run.child_agent_id;
    if (outcome.kind !== "completed") {
      const reason = outcome.kind === "failed" ? outcome.error.message : outcome.reason;
      return fail(paseo, run, `reviewer turn ${outcome.kind}: ${reason}`);
    }
    const afterTree = await snapshotTree(run.repo_root);
    const reviewerChanges = afterTree === run.end_tree ? null : await diffStat(run.repo_root, run.end_tree, afterTree);
    const verdict = parseVerdict(latestAssistantText(timeline));
    if (!verdict) {
      return fail(paseo, run, "reviewer reply is not a valid verdict JSON", { reviewer_changes: reviewerChanges });
    }
    const rounds = JSON.parse(run.rounds_json) as RoundRecord[];
    rounds.push({ round, childAgentId: childAgentId ?? "", verdict: verdict.verdict, summary: verdict.summary });
    const policy = JSON.parse(run.policy_json) as Policy;
    const base = {
      verdict: verdict.verdict,
      result_json: JSON.stringify(verdict),
      reviewer_changes: reviewerChanges,
      rounds_json: JSON.stringify(rounds),
    };
    await archiveChild(paseo, childAgentId);
    if (verdict.verdict === "PASS") {
      await transition(paseo, run, { ...base, status: "PASSED" });
    } else if (verdict.verdict === "INCONCLUSIVE") {
      await transition(paseo, run, { ...base, status: "INCONCLUSIVE" });
    } else if (policy.review.on_fail === "report") {
      await transition(paseo, run, { ...base, status: "FAILED" });
    } else if (round - 1 >= policy.review.max_fix_rounds) {
      await transition(paseo, run, { ...base, status: "NEEDS_HUMAN" });
    } else {
      await sendFix(paseo, ledger.update(run.run_id, base, now()), verdict, policy);
    }
  }

  async function sendFix(paseo: Paseo, run: Run, verdict: Verdict, policy: Policy): Promise<void> {
    const source = await refreshAgent(paseo, run.source_agent_id);
    if (!source || source.status !== "idle") {
      await transition(paseo, run, { status: "SUPERSEDED" });
      return;
    }
    const fixing = await transition(paseo, run, { status: "FIXING", deadline_at: now() + reviewTimeoutMs });
    await paseo.agents.ref(run.source_agent_id).send(buildFixPrompt(verdict, run.round, policy.review.max_fix_rounds), {
      messageId: fixMessageId(fixing),
    });
  }

  const fixMessageId = (run: Run) => `${FIX_PREFIX}${run.run_id}:fix:${run.round}`;

  async function onFixTurnEnded(paseo: Paseo, run: Run, outcome: TurnEnded["outcome"]): Promise<void> {
    if (run.status !== "FIXING") return;
    if (outcome.kind !== "completed") {
      await transition(paseo, run, { status: "SUPERSEDED" });
      return;
    }
    const endTree = await snapshotTree(run.repo_root);
    const next = ledger.update(run.run_id, { end_tree: endTree, round: run.round + 1 }, now());
    await dispatch(paseo, next);
  }

  // ---------- event handlers ----------

  async function handleTurnStarted(event: TurnStarted, paseo: Paseo): Promise<void> {
    const agentId = event.agent.id;
    if (ledger.child(agentId)) return;
    // The user spoke while a review was running: the review is stale.
    for (const run of ledger.activeForSource(agentId)) {
      if (run.status === "REVIEWING" || run.status === "DISPATCHING") {
        const next = await transition(paseo, run, { status: "SUPERSEDED" });
        await archiveChild(paseo, next.child_agent_id);
      }
    }
    pending.delete(agentId);
    const loaded = await loadPending(event.agent.cwd);
    if (loaded) pending.set(agentId, loaded);
  }

  async function handleTurnEnded(event: TurnEnded, paseo: Paseo): Promise<void> {
    const agentId = event.agent.id;
    const owned = ledger.child(agentId);
    if (owned) return finalizeReview(paseo, owned.run, owned.round, event.outcome, event.timeline);

    const lastUser = lastUserMessage(event.timeline);
    const messageId = lastUser?.messageId ?? lastUser?.clientMessageId ?? null;
    const fix = messageId?.startsWith(FIX_PREFIX) ? /^ptg:(.+):fix:(\d+)$/.exec(messageId) : null;
    if (fix) {
      const run = ledger.get(fix[1]);
      pending.delete(agentId);
      if (run && run.source_agent_id === agentId && run.round === Number(fix[2])) {
        return onFixTurnEnded(paseo, run, event.outcome);
      }
      return;
    }

    const snapshot = pending.get(agentId);
    pending.delete(agentId);
    if (!snapshot || event.outcome.kind !== "completed") return;
    if (snapshot.error) return publishConfigError(paseo, agentId, snapshot.error);
    const policy = snapshot.policy;
    if (!policy || policy.action === "none" || !snapshot.baseTree) return;

    const source = await refreshAgent(paseo, agentId);
    if (!source || !triggers(policy, source, event.agent.parentAgentId === null)) return;
    const workspaceId = source.workspaceId ?? event.agent.workspaceId;
    if (!workspaceId) return;
    const endTree = await snapshotTree(snapshot.repoRoot);
    if (endTree === snapshot.baseTree) return;

    const run = {
      run_id: randomUUID(),
      source_agent_id: agentId,
      source_turn_key: `${agentId}:${messageId ?? `turn:${event.turnId}:${event.timeline.length}`}`,
      workspace_id: workspaceId,
      repo_root: snapshot.repoRoot,
      policy_hash: snapshot.policyHash,
      policy_json: snapshot.policyJson,
      request_text: truncate(lastUser?.text ?? "", REQUEST_TEXT_LIMIT),
      base_tree: snapshot.baseTree,
      end_tree: endTree,
    };
    if (!ledger.claim(run, now())) return;
    await dispatch(paseo, ledger.get(run.run_id)!);
  }

  async function handlePermission(agentId: string, paseo: Paseo, isWaiting: boolean): Promise<void> {
    const owned = ledger.child(agentId);
    if (!owned || owned.run.child_agent_id !== agentId || isTerminal(owned.run.status)) return;
    if (isWaiting) waiting.add(owned.run.run_id);
    else waiting.delete(owned.run.run_id);
    await publishCard(paseo, owned.run);
  }

  // ---------- recovery ----------

  async function reconcileRun(paseo: Paseo, run: Run): Promise<void> {
    if (run.status === "DISPATCHING") {
      if (run.dispatch_json) return createChild(paseo, run);
      return dispatch(paseo, run);
    }
    const watched = run.status === "REVIEWING" ? run.child_agent_id : run.source_agent_id;
    if (!watched) return fail(paseo, run, "run has no agent to watch");
    const agent = await refreshAgent(paseo, watched);
    if (!agent) return fail(paseo, run, `agent ${watched} no longer exists`);
    if (agent.status === "running" || agent.status === "initializing") {
      if (agent.pendingPermissions.length > 0) {
        ledger.update(run.run_id, { deadline_at: now() + reviewTimeoutMs }, now());
      } else if (run.deadline_at !== null && now() > run.deadline_at) {
        return fail(paseo, run, `timed out after ${Math.round(reviewTimeoutMs / 60000)} minutes`);
      }
      return;
    }
    // ponytail: only the last 500 items are searched; a fix turn longer than that would look unsent
    // and be re-sent (the daemon dedupes by messageId). Upgrade path: page backwards with the cursor.
    const page = await paseo.agents.ref(watched).timeline.refetch({ direction: "tail", limit: 500, projection: "canonical" });
    const items = page.entries.map((entry) => entry.item) as TimelineItem[];
    if (run.status === "REVIEWING") {
      if (agent.status === "error") return fail(paseo, run, `reviewer failed: ${agent.lastError ?? "unknown error"}`);
      return finalizeReview(paseo, run, run.round, { kind: "completed" }, items);
    }
    // FIXING: find our fix message; anything the user sent after it supersedes the run.
    const expected = fixMessageId(run);
    const index = items.findIndex((item) => item.type === "user_message" && item.messageId === expected);
    if (index === -1) {
      // The send never landed (crash between ledger write and send): send again, deduplicated by messageId.
      const verdict = JSON.parse(run.result_json ?? "null") as Verdict | null;
      if (!verdict) return fail(paseo, run, "fix round lost its findings");
      const policy = JSON.parse(run.policy_json) as Policy;
      await paseo.agents.ref(run.source_agent_id).send(buildFixPrompt(verdict, run.round, policy.review.max_fix_rounds), {
        messageId: expected,
      });
      return;
    }
    const later = items.slice(index + 1);
    if (later.some((item) => item.type === "user_message")) {
      await transition(paseo, run, { status: "SUPERSEDED" });
      return;
    }
    return onFixTurnEnded(paseo, run, { kind: "completed" });
  }

  return {
    onTurnStarted: (event, paseo) => enqueue("turn_started", () => handleTurnStarted(event, paseo)),
    onTurnEnded: (event, paseo) => enqueue("turn_ended", () => handleTurnEnded(event, paseo)),
    onPermission: (event, paseo, isWaiting) =>
      enqueue("permission", () => handlePermission(event.agent.id, paseo, isWaiting)),
    reconcile: (paseo) =>
      enqueue("reconcile", async () => {
        for (const run of ledger.active()) {
          const fresh = ledger.get(run.run_id);
          if (!fresh || isTerminal(fresh.status)) continue;
          await reconcileRun(paseo, fresh).catch((error) => log(`reconcile ${run.run_id} failed`, error));
        }
      }),
    idle: async () => {
      let current: Promise<void>;
      do {
        current = tail;
        await current;
      } while (current !== tail);
    },
  };
}
