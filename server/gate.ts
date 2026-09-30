import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type {
  CardData,
  Category,
  OnOutcome,
  OutcomeCard,
  PermissionCard,
  Policy,
  RunStatus,
  Verdict,
} from "../shared/schema.ts";
import {
  ANSWER_JSON_SCHEMA,
  CARD_KIND,
  CARD_VERSION,
  DEFAULT_RETRY_MESSAGE,
  OUTCOME_CARD_KIND,
  OUTCOME_CARD_VERSION,
  POLICY_PATH,
  TERMINAL_STATUSES,
  VERDICT_JSON_SCHEMA,
  INSTRUCTIONS_LIMIT,
  ROLE_OF,
  ROLE_PROFILE,
  defaultInstructionsFile,
  gateChecks,
  maxFixRounds,
  onDispute,
  policySchema,
} from "../shared/schema.ts";
import { diffStat, snapshotTree, toplevel } from "./git.ts";
import type { Chain, Ledger, RoundRecord, Run } from "./ledger.ts";
import { SUGGESTIONS, classify, currentTurnItems, replyText, similarity } from "./outcome.ts";
import {
  ANSWER_PREFIX,
  buildAnswerPrompt,
  buildFixPrompt,
  buildGatePrompt,
  buildNudgePrompt,
  latestAssistantText,
  parseAnswer,
  parseVerdict,
} from "./prompts.ts";
import { answerRisk, decideAutoApproval } from "./permissions.ts";
import { resolveRole } from "./reviewer.ts";

export type Paseo = PluginHookContext["paseo"];
type TurnStarted = PluginLifecycleEvents["agent.turn_started"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
type PermissionRequested = PluginLifecycleEvents["agent.permission_requested"];
type PermissionResolved = PluginLifecycleEvents["agent.permission_resolved"];
type TimelineItem = TurnEnded["timeline"][number];
type UserItem = Extract<TimelineItem, { type: "user_message" }>;
type AgentSnapshot = NonNullable<
  Awaited<ReturnType<ReturnType<Paseo["agents"]["ref"]>["refresh"]>>
>["agent"];

export const MANAGED_LABEL = "post-turn-gate.managed";
export const TARGET_LABEL = "post-turn-gate.target";
const FIX_PREFIX = "ptg:";
const REQUEST_TEXT_LIMIT = 8000;

interface LoadedPolicy {
  repoRoot: string;
  policy: Policy | null; // null: policy file is invalid
  policyJson: string;
  policyHash: string;
  error: string | null;
  baseTree: string | null;
  /** The policy's trigger, read leniently from an invalid policy too: its error card only goes to gated agents. */
  trigger: Policy["trigger"];
}

/** Policy and baseline frozen when a turn starts; chainId is set when the turn continues a task chain. */
interface Pending extends LoadedPolicy {
  turnId: string | null;
  chainId: string | null;
  /** Request of a superseded run whose changes this turn now also covers. */
  carriedRequest?: string;
}

/** Everything needed to gate the work of one task (a turn, or a chain of turns). */
interface Task {
  agentId: string;
  workspaceId: string;
  repoRoot: string;
  policy: Policy;
  policyJson: string;
  policyHash: string;
  baseTree: string;
  requestText: string;
  turnKey: string;
  /** Other agents whose turns overlapped this task in the same repository. */
  concurrent: readonly string[];
  /** The task did work (tool calls, or earlier turns of its chain), even if the tree did not change. */
  worked?: boolean;
  /** Round a new gate run starts at: fix rounds a fix turn used before it asked a question carry over. */
  startRound?: number;
}

/** A checker's permission requests that were denied, and whether it was asked for a verdict afterwards. */
interface Blocked {
  child: string;
  titles: string[];
  nudged: boolean;
}

// Failed turns are reported (or retried) whether or not they changed files: the user may not be watching.
const FAILURES: ReadonlySet<Category> = new Set(["crashed", "network", "rate_limited", "quota_exhausted", "context_exhausted", "error"]);
// Minutes a checker gets to reply with a verdict after it was told a permission was denied.
const NUDGE_MINUTES = 5;

type AnswerConfig = Extract<OnOutcome["awaiting_user"], { answer: unknown }>["answer"];

export interface GateOptions {
  ledger: Ledger;
  now?: () => number;
  /** Length of one policy minute in ms (tests shrink it); timeouts come from agents.<role>.timeout_minutes. */
  minuteMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export interface Gate {
  onTurnStarted(event: TurnStarted, paseo: Paseo): void;
  onTurnEnded(event: TurnEnded, paseo: Paseo): void;
  onPermission(event: PermissionRequested | PermissionResolved, paseo: Paseo): void;
  /** Stops auto-answering for a task chain (card button). */
  stopAnswering(chainId: string, paseo: Paseo): Promise<boolean>;
  /** Clears retry timers. */
  close(): void;
  /** Advances unfinished runs from ledger state (startup recovery and timeouts). */
  reconcile(paseo: Paseo): void;
  /** Resolves when all queued work has finished (tests). */
  idle(): Promise<void>;
}

const isTerminal = (status: RunStatus) => TERMINAL_STATUSES.includes(status);

function lastUserMessage(timeline: readonly TimelineItem[]): UserItem | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.type === "user_message") return item;
  }
  return null;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Shortens request text from the middle: the head holds the original request, the tail the latest
 * follow-ups and answers, which carry the newest constraints.
 */
export function clipRequest(text: string, limit = REQUEST_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 4);
  const marker = `\n\n[… ${text.length - limit} characters omitted …]\n\n`;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (limit - head))}`;
}

const EARLIER_MESSAGES = 5;

/**
 * The first request of a task, with the user's earlier messages in the conversation as context: a
 * request like "also add X" means nothing to a checker that only sees the last message.
 */
function firstRequestText(timeline: readonly TimelineItem[], lastUser: UserItem | null): string {
  const text = lastUser?.text ?? "";
  const earlier = timeline
    .filter((item): item is UserItem => item.type === "user_message" && item !== lastUser)
    .filter((item) => !(item.messageId ?? item.clientMessageId ?? "").startsWith(FIX_PREFIX)) // the plugin's own messages
    .slice(-EARLIER_MESSAGES)
    .map((item) => `- ${truncate(item.text, 1000)}`);
  if (earlier.length === 0) return text;
  return `Earlier messages from the user in this conversation (context only):\n${earlier.join("\n")}\n\nRequest:\n${text}`;
}

export function createGate(options: GateOptions): Gate {
  const { ledger } = options;
  const now = options.now ?? Date.now;
  const minuteMs = options.minuteMs ?? 60 * 1000;
  /** The check the run is on (review/verify); runs always have at least one. */
  const checkOf = (run: Run) => gateChecks(JSON.parse(run.policy_json) as Policy)[run.step] ?? "review";
  const specOf = (run: Run) => (JSON.parse(run.policy_json) as Policy).agents[ROLE_OF[checkOf(run)]];
  const timeoutOf = (run: Run) => specOf(run).timeout_minutes * minuteMs;
  const log = options.log ?? ((message, detail) => console.log(`[post-turn-gate] ${message}`, detail ?? ""));
  // Unfinished runs and chains store the policy frozen at their first turn; retire any in an older format.
  for (const run of ledger.active()) {
    if (!policySchema.safeParse(JSON.parse(run.policy_json)).success) {
      log(`retiring run ${run.run_id}: stored policy is in an old format`);
      ledger.update(run.run_id, { status: "ERROR", error: "stored policy is in an old format (plugin upgraded mid-run)" }, now());
    }
  }
  for (const chain of ledger.chains()) {
    if (!policySchema.safeParse(JSON.parse(chain.policy_json)).success) {
      log(`dropping chain ${chain.chain_id}: stored policy is in an old format`);
      ledger.deleteChain(chain.agent_id);
    }
  }
  const pending = new Map<string, Pending>();
  // Pending permission of each run's current child, shown on the card so it can be answered there.
  const waiting = new Map<string, PermissionCard>();
  const autoApproved = new Map<string, number>(); // run id → requests approved without a human
  // ponytail: in memory; after a restart a shown request's wait starts again. Upgrade path: a ledger column.
  const escalatedAt = new Map<string, number>(); // `${agentId}:${requestId}` → when it was put on a card
  const deniedAnswerers = new Set<string>(); // answerer ids whose request was denied after the wait

  // Agents with a running turn per repository, and the other agents whose turns overlapped theirs. A tree
  // snapshot covers the whole working tree, so overlapping agents' changes end up in each other's diffs.
  // ponytail: in memory only; turns that were already running when the plugin started are not seen, and a
  // turn whose turn_ended never arrives counts as running for ACTIVITY_TTL_MS. Upgrade path: one worktree per agent.
  const ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;
  interface Activity { repoRoot: string; owner: string; turnId: string | null; startedAt: number; others: Set<string> }
  const activity = new Map<string, Activity>();
  /** Overlapping agents of a task that spans turns (a chain, or a superseded run's carry). */
  const taskConcurrent = new Map<string, Set<string>>();

  /** owner: the source agent itself, or the source agent a gate child works for (never paired with each other). */
  function startActivity(agentId: string, owner: string, repoRoot: string, turnId: string | null): void {
    const entry = activity.get(agentId) ?? { repoRoot, owner, turnId, startedAt: now(), others: new Set<string>() };
    Object.assign(entry, { repoRoot, owner, turnId });
    for (const [id, other] of activity) {
      if (now() - other.startedAt > ACTIVITY_TTL_MS) activity.delete(id);
      else if (id !== agentId && other.repoRoot === repoRoot && other.owner !== owner) {
        entry.others.add(id);
        other.others.add(agentId);
      }
    }
    activity.set(agentId, entry);
  }

  function endActivity(agentId: string, turnId: string | null): string[] {
    const entry = activity.get(agentId);
    if (!entry) return [];
    // A replaced turn's late turn_ended must not end the newer turn's tracking.
    if (!turnId || !entry.turnId || entry.turnId === turnId) activity.delete(agentId);
    return [...entry.others];
  }

  const concurrentOf = (run: Run): string[] => (run.concurrent_agents ? (JSON.parse(run.concurrent_agents) as string[]) : []);
  const encodeConcurrent = (ids: Iterable<string>): string | null => {
    const list = [...new Set(ids)];
    return list.length > 0 ? JSON.stringify(list) : null;
  };
  const shortIds = (ids: readonly string[]) => ids.map((id) => id.slice(0, 8)).join(", ");

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
    const dispatch = run.dispatch_json ? (JSON.parse(run.dispatch_json) as { title?: string; note?: string }) : null;
    const records = (JSON.parse(run.rounds_json) as RoundRecord[]).filter((record) => record.round === run.round);
    const checks = gateChecks(policy).map((check, index) => {
      const record = records.find((entry) => entry.check === check);
      if (record?.verdict) {
        return { check, state: record.verdict, summary: record.summary ? truncate(record.summary, 1000) : null, reason: record.reason ?? null };
      }
      const state = isTerminal(run.status) ? ("skipped" as const) : index === run.step ? ("running" as const) : ("pending" as const);
      return { check, state, summary: null, reason: null };
    });
    const denied = blockedOf(run).flatMap((entry) => entry.titles);
    return {
      status: run.status,
      action: checkOf(run),
      checks,
      note: dispatch?.note ? truncate(dispatch.note, 500) : null,
      round: run.round,
      maxFixRounds: maxFixRounds(policy),
      waiting: waiting.has(run.run_id),
      permission: waiting.get(run.run_id) ?? null,
      autoApproved: autoApproved.get(run.run_id) ?? 0,
      summary: verdict ? truncate(verdict.summary, 2000) : null,
      findings: shown,
      otherFindings: (verdict?.findings.length ?? 0) - shown.length,
      childAgentId: run.child_agent_id,
      childTitle: dispatch?.title ?? null,
      reviewerChanges: run.reviewer_changes ? truncate(run.reviewer_changes, 2000) : null,
      error: run.error ? truncate(run.error, 2000) : null,
      denied: denied.length > 0 ? truncate(denied.join("; "), 600) : null,
      dispute: run.dispute ? truncate(run.dispute, 1500) : null,
      fixed: false,
    };
  }

  const blockedOf = (run: Run): Blocked[] => (run.blocked_json ? (JSON.parse(run.blocked_json) as Blocked[]) : []);

  /** Records a denied permission request of a run's checker (denied by you on the card, or after the wait). */
  function recordDenied(run: Run, child: string, title: string): Run {
    const entries = blockedOf(run);
    const entry = entries.find((candidate) => candidate.child === child);
    if (entry?.titles.includes(title)) return run;
    if (entry) entry.titles.push(title);
    else entries.push({ child, titles: [title], nudged: false });
    return ledger.update(run.run_id, { blocked_json: JSON.stringify(entries) }, now());
  }

  async function publishCard(paseo: Paseo, run: Run): Promise<void> {
    await paseo.agents.ref(run.source_agent_id).timeline.append({
      type: "plugin",
      // Keep updates for one round in place, but start each retry round at the current timeline position.
      // Reusing only run_id makes Paseo update round 1's old card while round 2 appears card-less.
      id: `post-turn-gate:${run.run_id}:round:${run.round}`,
      kind: CARD_KIND,
      version: CARD_VERSION,
      data: cardData(run),
    });
  }

  /**
   * One card per agent and policy version: the same broken policy updates its card in place, a new one gets a
   * card at the current position, and the card is marked fixed once the agent's policy is valid again.
   */
  async function publishConfigError(paseo: Paseo, agentId: string, error: string, policyHash: string, fixed = false): Promise<void> {
    const id = fixed ? ledger.configError(agentId)?.card_id : `post-turn-gate:config:${agentId}:${policyHash.slice(0, 12)}`;
    if (!id) return;
    const data: CardData = {
      status: "ERROR",
      action: null,
      round: 0,
      maxFixRounds: 0,
      waiting: false,
      permission: null,
      autoApproved: 0,
      summary: null,
      findings: [],
      otherFindings: 0,
      childAgentId: null,
      childTitle: null,
      reviewerChanges: null,
      error: truncate(`${POLICY_PATH}: ${error}`, 2000),
      checks: [],
      note: fixed ? "Fixed: the policy is valid again." : null,
      denied: null,
      dispute: null,
      fixed,
    };
    if (fixed) ledger.deleteConfigError(agentId);
    else ledger.setConfigError(agentId, id, error);
    await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind: CARD_KIND, version: CARD_VERSION, data });
  }

  async function clearConfigError(paseo: Paseo, agentId: string): Promise<void> {
    const shown = ledger.configError(agentId);
    if (shown) await publishConfigError(paseo, agentId, shown.error, "", true).catch((error) => log("config card update failed", error));
  }

  async function transition(paseo: Paseo, run: Run, patch: Partial<Run>): Promise<Run> {
    const next = ledger.update(run.run_id, patch, now());
    if (isTerminal(next.status)) {
      waiting.delete(next.run_id);
      autoApproved.delete(next.run_id);
    }
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

  // A superseded run's changes were never passed, so the agent's next gated turn starts from the run's
  // baseline and request instead of taking a fresh one (which would already contain them). The carry lives
  // on the ledger until a finished turn has handled it, so a restart mid-way does not drop it.
  function applyCarry(agentId: string): void {
    const carry = ledger.carry(agentId);
    const target = pending.get(agentId);
    if (!carry || !target?.policy || target.repoRoot !== carry.repo_root) return;
    target.baseTree = carry.base_tree;
    target.carriedRequest = carry.request_text;
  }

  async function supersede(paseo: Paseo, run: Run): Promise<Run> {
    const next = await transition(paseo, run, { status: "SUPERSEDED" });
    carryOver(run);
    return next;
  }

  /** Hands a run's unchecked changes to the source agent's next gated turn (see applyCarry). */
  function carryOver(run: Run): void {
    ledger.setCarry({ agent_id: run.source_agent_id, repo_root: run.repo_root, base_tree: run.base_tree, request_text: run.request_text }, now());
    const carried = taskConcurrent.get(run.source_agent_id) ?? new Set<string>();
    for (const id of concurrentOf(run)) carried.add(id);
    if (carried.size > 0) taskConcurrent.set(run.source_agent_id, carried);
    // A turn that already started (its pending snapshot exists) takes the carry now, otherwise the next one does.
    applyCarry(run.source_agent_id);
  }

  // ---------- policy ----------

  async function loadPending(cwd: string): Promise<LoadedPolicy | null> {
    const repoRoot = await toplevel(cwd);
    if (!repoRoot) return null;
    let raw: string;
    try {
      raw = await readFile(path.join(repoRoot, POLICY_PATH), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    // Always taken: on_outcome (answers, retries) works even when `done` does not gate, and an invalid policy's
    // card is only shown for a turn that changed files.
    const baseTree = await snapshotTree(repoRoot);
    const base = { repoRoot, policyHash: createHash("sha256").update(raw).digest("hex"), baseTree };
    const invalid = (error: string, json: unknown) => {
      const trigger = policySchema.shape.trigger.safeParse((json as { trigger?: unknown } | null)?.trigger);
      return { ...base, policy: null, policyJson: raw, error, trigger: trigger.success ? trigger.data : ("root_and_opt_in" as const) };
    };
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return invalid(`invalid JSON: ${(error as Error).message}`, null);
    }
    const parsed = policySchema.safeParse(json);
    if (!parsed.success) {
      return invalid(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "), json);
    }
    const policy = parsed.data;
    const rulesError = await loadRules(repoRoot, policy);
    if (rulesError) return invalid(rulesError, json);
    return { ...base, policy, policyJson: JSON.stringify(policy), error: null, trigger: policy.trigger };
  }

  /**
   * Reads each role's instructions_file into its instructions, so the rules are frozen with the policy at
   * turn start (the agent may edit them during the turn). Returns an error message for a bad file.
   */
  async function loadRules(repoRoot: string, policy: Policy): Promise<string | null> {
    for (const role of ["reviewer", "verifier", "answerer"] as const) {
      const spec = policy.agents[role];
      if (!spec.instructions_file) continue;
      const field = `agents.${role}.instructions_file`;
      const file = path.resolve(repoRoot, spec.instructions_file);
      if (file !== repoRoot && !file.startsWith(`${repoRoot}${path.sep}`)) return `${field}: must be inside the repository`;
      let text: string;
      try {
        // HTML comments are guidance for the person editing the file (npm run init writes them), not rules.
        text = (await readFile(file, "utf8")).replace(/<!--[\s\S]*?-->/g, "").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && spec.instructions_file === defaultInstructionsFile(role)) continue;
        return `${field}: cannot read ${spec.instructions_file}: ${(error as Error).message}`;
      }
      const combined = [text, spec.instructions?.trim()].filter(Boolean).join("\n\n");
      if (combined.length > INSTRUCTIONS_LIMIT) return `${field}: rules are longer than ${INSTRUCTIONS_LIMIT} characters`;
      spec.instructions = combined || undefined;
    }
    return null;
  }

  function triggers(trigger: Policy["trigger"], agent: AgentSnapshot, isRoot: boolean): boolean {
    if (agent.labels[MANAGED_LABEL] === "true") return false;
    if (trigger === "all") return true;
    if (trigger === "root_only") return isRoot;
    return isRoot || agent.labels[TARGET_LABEL] === "true";
  }

  async function refreshAgent(paseo: Paseo, agentId: string): Promise<AgentSnapshot | null> {
    return (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
  }

  function inheritedConfig(source: AgentSnapshot) {
    return {
      provider: source.provider,
      ...(source.model ? { model: source.model } : {}),
      ...(source.currentModeId ? { modeId: source.currentModeId } : {}),
      ...(source.thinkingOptionId ? { thinkingOptionId: source.thinkingOptionId } : {}),
      featureValues: Object.fromEntries((source.features ?? []).map((feature) => [feature.id, feature.value])),
    };
  }

  // ---------- dispatch ----------

  async function dispatch(paseo: Paseo, run: Run): Promise<void> {
    const policy = JSON.parse(run.policy_json) as Policy;
    if (gateChecks(policy).length === 0) return;
    const action = checkOf(run);
    const role = ROLE_OF[action];
    const spec = policy.agents[role];
    const source = await refreshAgent(paseo, run.source_agent_id);
    if (!source) return fail(paseo, run, "source agent no longer exists");
    const profiles = spec.profile ? (await paseo.config.get()).config.agentProfiles ?? [] : [];
    const resolved = resolveRole(inheritedConfig(source), spec, ROLE_PROFILE[role], profiles);
    if (!resolved.ok) return fail(paseo, run, `agents.${role}: ${resolved.error}`);
    const { model, ...launch } = resolved.config;
    const childAgentId = randomUUID();
    const key = `${FIX_PREFIX}${run.run_id}:${run.round}:${run.step}`;
    const payload = {
      agentId: childAgentId,
      idempotencyKey: key,
      parent: run.source_agent_id,
      config: { ...launch, provider: `${launch.provider}/${model}` },
      title: `Gate ${action} #${run.round} · ${source.title ?? run.source_agent_id.slice(0, 8)}`,
      prompt: buildGatePrompt({
        action,
        requestText: run.request_text,
        repoRoot: run.repo_root,
        baseTree: run.base_tree,
        endTree: run.end_tree,
        instructions: spec.instructions,
        concurrentAgents: concurrentOf(run),
        dispute: run.dispute,
      }),
      clientMessageId: key,
      outputSchema: VERDICT_JSON_SCHEMA,
      labels: {
        [MANAGED_LABEL]: "true",
        "post-turn-gate.role": role,
        "post-turn-gate.run-id": run.run_id,
      },
    };
    ledger.addChild(childAgentId, run.run_id, run.round);
    const concurrent = concurrentOf(run);
    const note = [
      resolved.note,
      concurrent.length > 0
        ? `Other agents worked in this repository at the same time (${shortIds(concurrent)}); the checked diff may include their changes.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    const claimed = await transition(paseo, run, {
      status: "DISPATCHING",
      child_agent_id: childAgentId,
      dispatch_json: JSON.stringify({ workspaceId: run.workspace_id, ...(note ? { note } : {}), ...payload }),
      deadline_at: now() + timeoutOf(run),
      reviewer_changes: null,
      // Denied requests are shown for the whole round; a new round starts clean.
      ...(run.step === 0 ? { blocked_json: null } : {}),
    });
    await createChild(paseo, claimed);
  }

  /** Creates (or idempotently re-creates) the child recorded in dispatch_json. */
  async function createChild(paseo: Paseo, run: Run): Promise<void> {
    const { workspaceId, note: _note, ...payload } = JSON.parse(run.dispatch_json ?? "{}");
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
    childAgentId: string,
    outcome: TurnEnded["outcome"],
    timeline: readonly TimelineItem[],
    concurrent: readonly string[] = [],
  ): Promise<void> {
    // Only the run's current child counts; earlier rounds' or checks' children are stale.
    if (run.status !== "REVIEWING" || run.child_agent_id !== childAgentId) return;
    const round = run.round;
    const check = checkOf(run);
    const blocked = blockedOf(run).find((entry) => entry.child === childAgentId);
    // A denied request often ends the checker's turn without a verdict (kiro ends the turn on a denial).
    // Ask once for a verdict from the evidence it has, instead of waiting for the timeout.
    const nudge = async () => {
      const entries = blockedOf(run).map((entry) => (entry.child === childAgentId ? { ...entry, nudged: true } : entry));
      const next = ledger.update(
        run.run_id,
        { blocked_json: JSON.stringify(entries), deadline_at: Math.max(run.deadline_at ?? 0, now() + NUDGE_MINUTES * minuteMs) },
        now(),
      );
      await publishCard(paseo, next).catch((error) => log("card update failed", error));
      await paseo.agents.ref(childAgentId).send(buildNudgePrompt(blocked!.titles.join("; ")), {
        messageId: `${FIX_PREFIX}nudge:${run.run_id}:${round}:${run.step}`,
      });
    };
    if (outcome.kind !== "completed") {
      if (blocked && !blocked.nudged) return nudge();
      const reason = outcome.kind === "failed" ? outcome.error.message : outcome.reason;
      return fail(paseo, run, `reviewer turn ${outcome.kind}: ${reason}`);
    }
    const afterTree = await snapshotTree(run.repo_root);
    const reviewerChanges = afterTree === run.end_tree ? null : await diffStat(run.repo_root, run.end_tree, afterTree);
    if (reviewerChanges) {
      // A checker that edits the tree is no longer independent (it may have "fixed" what it then passed), and
      // the edits would count as the source agent's work in the next round. Nothing is reverted: the user
      // decides, and the agent's next turn checks the whole task again from the original baseline.
      const who = concurrent.length > 0 ? `the ${check} agent or another agent (${shortIds(concurrent)})` : `the ${check} agent`;
      await transition(paseo, run, {
        status: "NEEDS_HUMAN",
        reviewer_changes: reviewerChanges,
        error:
          `The working tree changed while ${who} ran, so its verdict was discarded. Nothing was reverted. ` +
          "Keep or revert the changes below yourself, then send the agent a message: its next turn checks the whole task again.",
      });
      carryOver(run);
      return archiveChild(paseo, childAgentId);
    }
    let verdict = parseVerdict(latestAssistantText(timeline));
    if (!verdict && blocked && !blocked.nudged) return nudge();
    if (!verdict) {
      return fail(paseo, run, "reviewer reply is not a valid verdict JSON", { reviewer_changes: reviewerChanges });
    }
    if (verdict.verdict === "INCONCLUSIVE" && !verdict.inconclusive_reason && blocked) {
      verdict = { ...verdict, inconclusive_reason: "blocked_permission" };
    }
    const reason = verdict.inconclusive_reason;
    const rounds = JSON.parse(run.rounds_json) as RoundRecord[];
    rounds.push({ round, check, childAgentId, verdict: verdict.verdict, summary: verdict.summary, reason });
    const policy = JSON.parse(run.policy_json) as Policy;
    const base = {
      verdict: verdict.verdict,
      result_json: JSON.stringify(verdict),
      reviewer_changes: reviewerChanges,
      rounds_json: JSON.stringify(rounds),
    };
    // on_inconclusive "fail" covers gaps the agent can close itself (tests, other evidence); a blocked
    // permission, an ambiguous request or a missing environment are not the agent's to fix.
    const failing =
      verdict.verdict === "FAIL" ||
      (verdict.verdict === "INCONCLUSIVE" && policy.on_inconclusive === "fail" && (reason === null || reason === "no_test_infra" || reason === "other"));
    if (!failing) {
      // Checks run in order until one fails; INCONCLUSIVE does not block the next check.
      const next = run.step + 1;
      if (next < gateChecks(policy).length) {
        // DISPATCHING without a payload: after a crash here, reconcile dispatches the next check instead of
        // re-reading the finished child's verdict and advancing twice.
        const advanced = { ...base, step: next, status: "DISPATCHING" as const, dispatch_json: null, child_agent_id: null, deadline_at: null };
        const dispatching = await transition(paseo, run, advanced);
        await archiveChild(paseo, childAgentId);
        return dispatch(paseo, dispatching);
      }
      const current = rounds.filter((record) => record.round === round);
      const needsYou = current.find((record) => record.reason === "blocked_permission" || record.reason === "ambiguous_request");
      if (needsYou) {
        const what = needsYou.check === "verify" ? "verifier" : "reviewer";
        const error =
          needsYou.reason === "blocked_permission"
            ? `The ${what} could not finish: a permission request it needed was denied or not answered. Allow it next time, or tell the agent how to proceed; its next turn checks the whole task again.`
            : `The ${what} could not tell what the request requires. Clarify it in the chat; the agent's next turn checks the whole task again.`;
        await transition(paseo, run, { ...base, status: "NEEDS_HUMAN", error });
        // Unverified changes stay unaccepted: the agent's next turn checks the whole task again.
        carryOver(run);
      } else {
        const inconclusive = current.some((record) => record.verdict === "INCONCLUSIVE");
        await transition(paseo, run, { ...base, status: inconclusive ? "INCONCLUSIVE" : "PASSED" });
      }
    } else if (maxFixRounds(policy) === 0) {
      await transition(paseo, run, { ...base, status: "FAILED" });
    } else if (round - 1 >= maxFixRounds(policy)) {
      await transition(paseo, run, { ...base, status: "NEEDS_HUMAN" });
      // The failing changes stay unaccepted: the agent's next turn checks the whole task again.
      carryOver(run);
    } else {
      try {
        await sendFix(paseo, ledger.update(run.run_id, base, now()), verdict, policy);
      } finally {
        await archiveChild(paseo, childAgentId);
      }
      return;
    }
    await archiveChild(paseo, childAgentId);
  }

  async function sendFix(paseo: Paseo, run: Run, verdict: Verdict, policy: Policy): Promise<void> {
    // No deadline: the source agent does the fix, and a role's timeout_minutes does not bound its work.
    // A slow fix still ends in a turn_ended that re-checks it; timing it out would leave the fix unchecked.
    const fixing = await transition(paseo, run, { status: "FIXING", deadline_at: null });
    const source = await refreshAgent(paseo, run.source_agent_id);
    if (!source || source.status !== "idle") {
      await supersede(paseo, fixing);
      return;
    }
    await paseo.agents.ref(run.source_agent_id).send(buildFixPrompt(verdict, run.round, maxFixRounds(policy), concurrentOf(run)), {
      messageId: fixMessageId(fixing),
    });
  }

  const fixMessageId = (run: Run) => `${FIX_PREFIX}${run.run_id}:fix:${run.round}`;

  async function onFixTurnEnded(
    paseo: Paseo,
    run: Run,
    outcome: TurnEnded["outcome"],
    concurrent: readonly string[],
    timeline: readonly TimelineItem[],
  ): Promise<void> {
    if (run.status !== "FIXING") return;
    if (concurrent.length > 0) {
      run = ledger.update(run.run_id, { concurrent_agents: encodeConcurrent([...concurrentOf(run), ...concurrent]) }, now());
    }
    if (outcome.kind !== "completed") {
      await supersede(paseo, run);
      return;
    }
    const endTree = await snapshotTree(run.repo_root);
    if (endTree === run.end_tree) return onFixWithoutChanges(paseo, run, timeline);
    // A fix can break a check that passed earlier, so the next round starts from the first check.
    // Leaves FIXING in the same write, so a crash here cannot count the fix turn twice on recovery.
    const next = ledger.update(
      run.run_id,
      { end_tree: endTree, round: run.round + 1, step: 0, status: "DISPATCHING", dispatch_json: null, child_agent_id: null, dispute: null },
      now(),
    );
    await dispatch(paseo, next);
  }

  /**
   * The agent changed nothing in its fix turn: checking the same tree again would only use up a round.
   * A question goes to the answerer (or you); any other reply disputes the findings (on_fail.fix.on_dispute).
   */
  async function onFixWithoutChanges(paseo: Paseo, run: Run, timeline: readonly TimelineItem[]): Promise<void> {
    const policy = JSON.parse(run.policy_json) as Policy;
    const items = currentTurnItems(timeline);
    const reply = replyText(items).trim();
    const { category, detail } = classify({ outcome: { kind: "completed" }, turnItems: items, statusAtEnd: null });
    if (category === "awaiting_user" && detail !== "refused" && policy.on_outcome.awaiting_user !== "as_done") {
      await transition(paseo, run, { status: "SUPERSEDED", error: "The agent asked a question instead of fixing; the task continues from the answer." });
      // The task continues as a chain from the run's baseline; its next gate run keeps counting fix rounds.
      const chain = ensureChain({
        agentId: run.source_agent_id,
        workspaceId: run.workspace_id,
        repoRoot: run.repo_root,
        policy,
        policyJson: run.policy_json,
        policyHash: run.policy_hash,
        baseTree: run.base_tree,
        requestText: run.request_text,
        turnKey: `${run.run_id}:fix:${run.round}`,
        concurrent: concurrentOf(run),
      });
      const current = ledger.updateChain(chain.agent_id, { rounds_used: run.round }, now()) ?? chain;
      return handleAwaitingUser(paseo, current, reply, detail);
    }
    if (onDispute(policy) === "rereview") {
      const next = ledger.update(
        run.run_id,
        { round: run.round + 1, step: 0, status: "DISPATCHING", dispatch_json: null, child_agent_id: null, dispute: truncate(reply || "(no reply)", 4000) },
        now(),
      );
      return dispatch(paseo, next);
    }
    await transition(paseo, run, {
      status: "NEEDS_HUMAN",
      dispute: truncate(reply || "(no reply)", 4000),
      error:
        `The agent changed nothing in fix round ${run.round} and replied instead (below). Decide who is right, ` +
        "then send the agent a message: its next turn checks the whole task again.",
    });
    carryOver(run);
  }

  // ---------- task chains, answers and retries (docs/turn-outcomes.md) ----------

  const CHAIN_TTL_MS = 24 * 60 * 60 * 1000;
  // Errs towards escalating: a false match hands the question to the user, a miss can loop.
  const SAME_QUESTION = 0.5;
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const sendable = (status: string | undefined) => status === "idle" || status === "error";

  function liveChain(agentId: string): Chain | null {
    const chain = ledger.chain(agentId);
    if (chain && now() - chain.created_at > CHAIN_TTL_MS) {
      ledger.deleteChain(agentId);
      return null;
    }
    return chain;
  }

  function answerConfig(policy: Policy): AnswerConfig | null {
    const action = policy.on_outcome.awaiting_user;
    return typeof action === "object" ? action.answer : null;
  }

  function chainCard(chain: Chain): OutcomeCard {
    if (chain.card_json) return JSON.parse(chain.card_json) as OutcomeCard;
    return {
      chainId: chain.chain_id,
      category: "done",
      state: "notice",
      message: null,
      suggestion: null,
      question: null,
      answer: null,
      attempt: 0,
      maxAttempts: 0,
      nextRetryAt: null,
      childAgentId: null,
      canStopAnswering: false,
      permission: null,
    };
  }

  async function publishChainCard(paseo: Paseo, chain: Chain, patch: Partial<OutcomeCard>): Promise<Chain> {
    const card: OutcomeCard = { ...chainCard(chain), ...patch, chainId: chain.chain_id };
    const next = ledger.updateChain(chain.agent_id, { card_json: JSON.stringify(card) }, now()) ?? chain;
    await paseo.agents
      .ref(chain.agent_id)
      .timeline.append({
        type: "plugin",
        // Numbered: each new event of the task gets a card where the user is looking (see newCard).
        id: `post-turn-gate:outcome:${chain.chain_id}:${chain.card_seq}`,
        kind: OUTCOME_CARD_KIND,
        version: OUTCOME_CARD_VERSION,
        data: card,
      })
      .catch((error) => log("outcome card update failed", error));
    return next;
  }

  /**
   * Starts a new outcome card for a new event of the task (a new question, failure or retry), so it appears at
   * the current timeline position instead of updating a card far above. The previous card is closed first.
   */
  async function newCard(paseo: Paseo, chain: Chain): Promise<Chain> {
    if (!chain.card_json) return chain;
    const open = ["answer_scheduled", "answering", "retry_scheduled", "retrying"].includes(chainCard(chain).state);
    const closed = await publishChainCard(paseo, chain, {
      canStopAnswering: false,
      permission: null,
      nextRetryAt: null,
      ...(open ? { state: "resolved" as const, message: "Continued in a newer card below." } : {}),
    });
    return ledger.updateChain(chain.agent_id, { card_seq: closed.card_seq + 1, card_json: null }, now()) ?? closed;
  }

  /** Drops a scheduled retry or answer, or a running answerer; the chain itself stays. */
  async function cancelChainWork(paseo: Paseo, chain: Chain): Promise<Chain> {
    if (chain.answer_child_id) await archiveChild(paseo, chain.answer_child_id);
    return (
      ledger.updateChain(
        chain.agent_id,
        {
          next_retry_at: null,
          answer_child_id: null,
          answer_dispatch_json: null,
          answer_deadline_at: null,
          answer_at: null,
          answer_reply: null,
          answer_signal: null,
        },
        now(),
      ) ?? chain
    );
  }

  async function endChain(paseo: Paseo, agentId: string, final: { state: OutcomeCard["state"]; message: string } | null) {
    const chain = ledger.chain(agentId);
    if (!chain) return;
    const current = await cancelChainWork(paseo, chain);
    if (final && current.card_json) {
      await publishChainCard(paseo, current, {
        ...final,
        canStopAnswering: false,
        permission: null,
        nextRetryAt: null,
      });
    }
    ledger.deleteChain(agentId);
  }

  function ensureChain(task: Task): Chain {
    const existing = ledger.chain(task.agentId);
    if (existing) return ledger.updateChain(task.agentId, { request_text: task.requestText }, now()) ?? existing;
    return ledger.createChain(
      {
        agent_id: task.agentId,
        chain_id: randomUUID(),
        workspace_id: task.workspaceId,
        repo_root: task.repoRoot,
        policy_json: task.policyJson,
        policy_hash: task.policyHash,
        base_tree: task.baseTree,
        request_text: task.requestText,
      },
      now(),
    );
  }

  function taskFromChain(chain: Chain): Task {
    return {
      agentId: chain.agent_id,
      workspaceId: chain.workspace_id,
      repoRoot: chain.repo_root,
      policy: JSON.parse(chain.policy_json) as Policy,
      policyJson: chain.policy_json,
      policyHash: chain.policy_hash,
      baseTree: chain.base_tree,
      requestText: chain.request_text,
      turnKey: `${chain.agent_id}:chain:${chain.chain_id}:${chain.answers}:${chain.retries}`,
      concurrent: [...(taskConcurrent.get(chain.agent_id) ?? [])],
      startRound: chain.rounds_used + 1,
    };
  }

  function chainRequestText(prior: string | null, timeline: readonly TimelineItem[], lastUser: UserItem | null): string {
    const text = lastUser?.text ?? "";
    const id = lastUser?.messageId ?? lastUser?.clientMessageId ?? "";
    if (prior === null) return clipRequest(firstRequestText(timeline, lastUser));
    if (id.startsWith("ptg:retry:")) return prior;
    const label = id.startsWith("ptg:answer:") ? "Answered on the user's behalf" : "Follow-up from the user";
    return clipRequest(`${prior}\n\n${label}: ${text}`);
  }

  async function needsUser(paseo: Paseo, chain: Chain, question: string | undefined, reason: string): Promise<void> {
    const cfg = answerConfig(JSON.parse(chain.policy_json) as Policy);
    log(`needs user for ${chain.agent_id}: ${reason}`);
    await publishChainCard(paseo, chain, {
      category: "awaiting_user",
      state: "needs_user",
      ...(question !== undefined ? { question: truncate(question, 2000) } : {}),
      answer: null,
      message: truncate(reason, 1000),
      suggestion: SUGGESTIONS.awaiting_user,
      attempt: chain.answers,
      maxAttempts: cfg?.max ?? 0,
      canStopAnswering: false,
      permission: null,
      nextRetryAt: null,
    });
  }

  /** Starts a review/verify of the task's changes (no-op without checks or for an unchanged tree). */
  async function startGate(paseo: Paseo, task: Task, knownEndTree?: string): Promise<void> {
    const checks = gateChecks(task.policy);
    if (checks.length === 0) return;
    const endTree = knownEndTree ?? (await snapshotTree(task.repoRoot));
    if (endTree === task.baseTree) return log(`skip ${task.agentId}: working tree unchanged`);
    const run = {
      run_id: randomUUID(),
      source_agent_id: task.agentId,
      source_turn_key: task.turnKey,
      workspace_id: task.workspaceId,
      repo_root: task.repoRoot,
      policy_hash: task.policyHash,
      policy_json: task.policyJson,
      request_text: task.requestText,
      base_tree: task.baseTree,
      end_tree: endTree,
      concurrent_agents: encodeConcurrent(task.concurrent),
    };
    if (!ledger.claim(run, now(), task.startRound ?? 1)) return log(`skip ${task.agentId}: run already exists for this turn`);
    log(`gate ${run.run_id} for ${task.agentId}: ${checks.join(" → ")}`);
    await dispatch(paseo, ledger.get(run.run_id)!);
  }

  async function applyOutcome(
    paseo: Paseo,
    task: Task,
    category: Category,
    detail: string | null,
    reply: string,
  ): Promise<void> {
    const action = task.policy.on_outcome[category];
    if (category === "replaced") return; // its baseline was carried into the newer turn
    if (category === "user_canceled") {
      return endChain(paseo, task.agentId, { state: "stopped", message: "You stopped the agent." });
    }
    // A task that did nothing (a chat question, an explanation) is left alone: no checks, no answerer. One that
    // worked without changing files yet (it read code, then asks how to proceed) can still be answered, and a
    // failed turn is always reported: the user may not be watching.
    let endTree: string | undefined;
    if (!FAILURES.has(category)) {
      endTree = await snapshotTree(task.repoRoot);
      const unchanged = endTree === task.baseTree;
      const asDone = category === "done" || action === "as_done";
      if (unchanged && (asDone || !task.worked)) {
        log(`skip ${task.agentId}: working tree unchanged (${category})`);
        return endChain(paseo, task.agentId, { state: "resolved", message: "The task ended without changing files." });
      }
    }
    if (category === "done" || (category === "awaiting_user" && action === "as_done")) {
      if (gateChecks(task.policy).length > 0) await startGate(paseo, task, endTree);
      else if (task.policy.on_outcome.done === "notify") {
        const chain = await newCard(paseo, ensureChain(task));
        await publishChainCard(paseo, chain, { category: "done", state: "notice", message: "The agent finished its turn." });
        return endChain(paseo, task.agentId, null);
      }
      return endChain(paseo, task.agentId, { state: "resolved", message: "The task continued and finished." });
    }
    if (action === "ignore") {
      ensureChain(task);
      return;
    }
    const chain = await newCard(paseo, ensureChain(task));
    if (category === "awaiting_user") return handleAwaitingUser(paseo, chain, reply, detail);
    const base = {
      category,
      message: detail,
      suggestion: SUGGESTIONS[category],
      question: null,
      answer: null,
      childAgentId: null,
      canStopAnswering: false,
      permission: null,
    };
    if (typeof action === "object" && "retry" in action) {
      if (chain.retries < action.retry.max) return scheduleRetry(paseo, chain, base, action.retry);
      await publishChainCard(paseo, chain, {
        ...base,
        state: "notice",
        attempt: chain.retries,
        maxAttempts: action.retry.max,
        nextRetryAt: null,
        message: `${detail ?? category} (automatic retries used up)`,
      });
      return;
    }
    await publishChainCard(paseo, chain, { ...base, state: "notice", attempt: 0, maxAttempts: 0, nextRetryAt: null });
  }

  /** A stop that may wait for the user: answer it (after the grace period), or hand it to the user. */
  async function handleAwaitingUser(paseo: Paseo, chain: Chain, reply: string, signal: string | null): Promise<void> {
    const cfg = answerConfig(JSON.parse(chain.policy_json) as Policy);
    if (!cfg) return needsUser(paseo, chain, reply.slice(-600), "auto-answer is off for this repository");
    if (chain.stop_answering) return needsUser(paseo, chain, reply.slice(-600), "auto-answering was stopped for this task");
    if (chain.answers >= cfg.max) return needsUser(paseo, chain, reply.slice(-600), `auto-answer limit reached (${cfg.max})`);
    if (cfg.delay_seconds === 0) return dispatchAnswerer(paseo, chain, reply, cfg, signal);
    // The user is often still there: give them delay_seconds to reply before an agent answers for them.
    const at = now() + cfg.delay_seconds * 1000;
    const next = ledger.updateChain(chain.agent_id, { answer_at: at, answer_reply: reply, answer_signal: signal }, now())!;
    await publishChainCard(paseo, next, {
      category: "awaiting_user",
      state: "answer_scheduled",
      question: truncate(reply.slice(-600), 2000),
      answer: null,
      message: null,
      suggestion: SUGGESTIONS.awaiting_user,
      attempt: next.answers + 1,
      maxAttempts: cfg.max,
      nextRetryAt: at,
      childAgentId: null,
      canStopAnswering: true,
      permission: null,
    });
    wakeAt(paseo, at);
  }

  /** The reconcile loop also starts due work (after restarts); the timer only makes short delays exact. */
  function wakeAt(paseo: Paseo, at: number): void {
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      enqueue("scheduled work", () => startDueWork(paseo));
    }, Math.max(0, at - now()) + 100);
    timer.unref?.();
    retryTimers.add(timer);
  }

  async function startDueWork(paseo: Paseo): Promise<void> {
    for (const chain of ledger.chains()) {
      try {
        if (chain.next_retry_at !== null && chain.next_retry_at <= now()) await sendRetry(paseo, chain);
        else if (chain.answer_at !== null && chain.answer_at <= now()) await startScheduledAnswer(paseo, chain);
      } catch (error) {
        log(`scheduled work for ${chain.agent_id} failed`, error);
      }
    }
  }

  async function startScheduledAnswer(paseo: Paseo, chain: Chain): Promise<void> {
    const current = ledger.updateChain(chain.agent_id, { answer_at: null }, now()) ?? chain;
    const cfg = answerConfig(JSON.parse(current.policy_json) as Policy);
    const source = await refreshAgent(paseo, current.agent_id);
    if (!source) return ledger.deleteChain(current.agent_id);
    if (!cfg || !sendable(source.status)) {
      await publishChainCard(paseo, current, { state: "stopped", canStopAnswering: false, nextRetryAt: null, message: "The agent was busy again; the automatic answer was skipped." });
      return;
    }
    await dispatchAnswerer(paseo, current, current.answer_reply ?? "", cfg, current.answer_signal);
  }

  // ----- retries -----

  async function scheduleRetry(
    paseo: Paseo,
    chain: Chain,
    card: Partial<OutcomeCard>,
    cfg: { max: number; delay_seconds: number; message?: string },
  ): Promise<void> {
    const at = now() + cfg.delay_seconds * 1000;
    const next = ledger.updateChain(chain.agent_id, { next_retry_at: at, retry_message: cfg.message ?? DEFAULT_RETRY_MESSAGE }, now())!;
    await publishChainCard(paseo, next, { ...card, state: "retry_scheduled", attempt: next.retries + 1, maxAttempts: cfg.max, nextRetryAt: at });
    wakeAt(paseo, at);
  }

  async function sendRetry(paseo: Paseo, chain: Chain): Promise<void> {
    const source = await refreshAgent(paseo, chain.agent_id);
    if (!source) return ledger.deleteChain(chain.agent_id);
    if (!sendable(source.status)) {
      const current = ledger.updateChain(chain.agent_id, { next_retry_at: null }, now()) ?? chain;
      await publishChainCard(paseo, current, { state: "stopped", nextRetryAt: null, message: "The agent was busy again; automatic retry skipped." });
      return;
    }
    const attempt = chain.retries + 1;
    const current = ledger.updateChain(chain.agent_id, { retries: attempt, next_retry_at: null }, now())!;
    // Send first: publishing the card between the idle check and send() would widen the race (finalizeAnswer).
    await paseo.agents
      .ref(chain.agent_id)
      .send(chain.retry_message ?? DEFAULT_RETRY_MESSAGE, { messageId: `ptg:retry:${chain.chain_id}:${attempt}` });
    await publishChainCard(paseo, current, { state: "retrying", attempt, nextRetryAt: null });
  }

  // ----- answers -----

  async function dispatchAnswerer(
    paseo: Paseo,
    chain: Chain,
    reply: string,
    cfg: AnswerConfig,
    signal: string | null,
  ): Promise<void> {
    const policy = JSON.parse(chain.policy_json) as Policy;
    const source = await refreshAgent(paseo, chain.agent_id);
    if (!source) return;
    const spec = policy.agents.answerer;
    const profiles = spec.profile ? (await paseo.config.get()).config.agentProfiles ?? [] : [];
    const resolved = resolveRole(inheritedConfig(source), spec, ROLE_PROFILE.answerer, profiles);
    if (!resolved.ok) return needsUser(paseo, chain, reply.slice(-600), `cannot start the answerer: ${resolved.error}`);
    const { model, ...launch } = resolved.config;
    const endTree = await snapshotTree(chain.repo_root);
    const childAgentId = randomUUID();
    const attempt = chain.answers + 1;
    // One key per answerer child: `answers` only grows when an answer is sent, so an escalated or failed
    // call would reuse an attempt number with a new payload (agent_request_key_conflict). Replays reuse the payload.
    const key = `ptg:ask:${chain.chain_id}:${childAgentId}`;
    const payload = {
      agentId: childAgentId,
      idempotencyKey: key,
      parent: chain.agent_id,
      config: { ...launch, provider: `${launch.provider}/${model}` },
      title: `Gate answer #${attempt} · ${source.title ?? chain.agent_id.slice(0, 8)}`,
      prompt: buildAnswerPrompt({
        requestText: chain.request_text,
        repoRoot: chain.repo_root,
        baseTree: chain.base_tree,
        endTree,
        agentReply: truncate(reply, 6000),
        previousQuestion: chain.last_question,
        signal,
        instructions: spec.instructions,
      }),
      clientMessageId: key,
      outputSchema: ANSWER_JSON_SCHEMA,
      labels: {
        [MANAGED_LABEL]: "true",
        "post-turn-gate.role": "answerer",
        "post-turn-gate.chain-id": chain.chain_id,
      },
    };
    ledger.addChainChild(childAgentId, chain.agent_id, chain.chain_id);
    let current = ledger.updateChain(
      chain.agent_id,
      {
        answer_child_id: childAgentId,
        // endTree: the tree the answerer started on, to detect its edits (not part of the create payload).
        answer_dispatch_json: JSON.stringify({ workspaceId: chain.workspace_id, endTree, ...payload }),
        answer_deadline_at: now() + spec.timeout_minutes * minuteMs,
      },
      now(),
    )!;
    current = await publishChainCard(paseo, current, {
      category: "awaiting_user",
      state: "answering",
      question: truncate(reply.slice(-600), 2000),
      answer: null,
      message: resolved.note ?? null,
      suggestion: null,
      attempt,
      maxAttempts: cfg.max,
      nextRetryAt: null,
      childAgentId,
      canStopAnswering: true,
      permission: null,
    });
    await createAnswerer(paseo, current);
  }

  async function createAnswerer(paseo: Paseo, chain: Chain): Promise<void> {
    const { workspaceId, endTree: _endTree, ...payload } = JSON.parse(chain.answer_dispatch_json ?? "{}");
    try {
      await paseo.workspaces.ref(workspaceId).agents.create(payload);
    } catch (error) {
      const existing = await refreshAgent(paseo, payload.agentId).catch(() => null);
      if (existing) return;
      const current = await cancelChainWork(paseo, chain);
      return needsUser(paseo, current, undefined, `failed to start the answerer: ${(error as Error).message}`);
    }
  }

  async function finalizeAnswer(
    paseo: Paseo,
    childId: string,
    owner: { agentId: string; chainId: string },
    outcome: TurnEnded["outcome"],
    timeline: readonly TimelineItem[],
  ): Promise<void> {
    const chain = ledger.chain(owner.agentId);
    if (!chain || chain.chain_id !== owner.chainId || chain.answer_child_id !== childId) return; // stale
    const startTree = (JSON.parse(chain.answer_dispatch_json ?? "{}") as { endTree?: string }).endTree;
    let current = await cancelChainWork(paseo, chain);
    const denied = deniedAnswerers.delete(childId) ? "a permission request of the answerer was not answered in time and was denied; " : "";
    if (outcome.kind !== "completed") return needsUser(paseo, current, undefined, `${denied}the answerer turn ${outcome.kind}`);
    // Like a reviewer's (finalizeReview), an answerer's edits would pass as the source agent's work.
    const afterTree = startTree ? await snapshotTree(current.repo_root) : null;
    if (startTree && afterTree !== startTree) {
      const changes = await diffStat(current.repo_root, startTree, afterTree!);
      return needsUser(
        paseo,
        current,
        undefined,
        `the working tree changed while the answerer ran, so its answer was not sent. Nothing was reverted:\n${truncate(changes, 600)}`,
      );
    }
    const reply = parseAnswer(latestAssistantText(timeline));
    if (!reply) return needsUser(paseo, current, undefined, `${denied}the answerer reply is not valid JSON`);
    if (reply.state === "done") {
      await startGate(paseo, taskFromChain(current));
      return endChain(paseo, owner.agentId, { state: "resolved", message: "The agent had finished; nothing to answer." });
    }
    if (reply.state === "refused") {
      const policy = JSON.parse(current.policy_json) as Policy;
      if (policy.on_outcome.refused === "ignore") return endChain(paseo, owner.agentId, null);
      await publishChainCard(paseo, current, {
        category: "refused",
        state: "notice",
        question: null,
        answer: null,
        message: reply.reason ? truncate(reply.reason, 1000) : null,
        suggestion: SUGGESTIONS.refused,
        canStopAnswering: false,
        permission: null,
      });
      return;
    }
    const question = reply.question.trim() || chainCard(current).question || "";
    if (reply.state === "awaiting_user" && reply.decision === "escalate") {
      return needsUser(paseo, current, question, reply.reason || "the answerer handed this to you");
    }
    const text = reply.state === "incomplete" ? "Continue." : reply.answer.trim();
    if (!text) return needsUser(paseo, current, question, "the answerer gave no answer");
    const risk = answerRisk(`${question}\n${text}`);
    if (risk) return needsUser(paseo, current, question, `not answered automatically: ${risk}`);
    if (reply.state === "awaiting_user" && current.last_question && similarity(question, current.last_question) >= SAME_QUESTION) {
      return needsUser(paseo, current, question, "the agent asked the same question again after an automatic answer");
    }
    // Paseo has no "send only if idle": a user message between this refresh and send() would be canceled
    // by ours (design.md V5). Nothing awaits between the two, so the window is one round trip.
    const source = await refreshAgent(paseo, owner.agentId);
    if (!source || !sendable(source.status)) {
      await publishChainCard(paseo, current, { state: "stopped", canStopAnswering: false, message: "You replied first; the automatic answer was not sent." });
      return;
    }
    const attempt = current.answers + 1;
    current = ledger.updateChain(
      owner.agentId,
      { answers: attempt, last_question: reply.state === "awaiting_user" ? question : current.last_question },
      now(),
    )!;
    await paseo.agents.ref(owner.agentId).send(`${ANSWER_PREFIX}\n${text}`, {
      messageId: `ptg:answer:${current.chain_id}:${attempt}`,
    });
    const cfg = answerConfig(JSON.parse(current.policy_json) as Policy);
    await publishChainCard(paseo, current, {
      state: "answered",
      question: truncate(question, 2000),
      answer: truncate(text, 2000),
      message: reply.reason ? truncate(reply.reason, 1000) : null,
      attempt,
      maxAttempts: cfg?.max ?? attempt,
      childAgentId: childId,
      canStopAnswering: true,
      permission: null,
    });
    log(`answered for ${owner.agentId} (${attempt})`);
  }

  async function stopAnswering(chainId: string, paseo: Paseo): Promise<boolean> {
    const chain = ledger.chainById(chainId);
    if (!chain) return false;
    let current = ledger.updateChain(chain.agent_id, { stop_answering: 1 }, now())!;
    const wasAnswering = current.answer_child_id !== null || current.answer_at !== null;
    if (wasAnswering) current = await cancelChainWork(paseo, current);
    await publishChainCard(paseo, current, {
      canStopAnswering: false,
      permission: null,
      ...(wasAnswering ? { state: "stopped" as const } : {}),
      message: "Auto-answering stopped for this task; the agent's questions come to you.",
    });
    return true;
  }

  // ---------- event handlers ----------

  function takePending(agentId: string, turnId: string | null): { snapshot: Pending | null; stale: boolean } {
    const snapshot = pending.get(agentId);
    if (!snapshot) return { snapshot: null, stale: false };
    if (snapshot.turnId && turnId && snapshot.turnId !== turnId) return { snapshot: null, stale: true };
    pending.delete(agentId);
    return { snapshot, stale: false };
  }

  async function handleTurnStarted(event: TurnStarted, paseo: Paseo): Promise<void> {
    const agentId = event.agent.id;
    const owned = ledger.child(agentId);
    const answerer = owned ? null : ledger.chainChild(agentId);
    if (owned || answerer) {
      const repoRoot = owned ? owned.run.repo_root : ledger.chain(answerer!.agentId)?.repo_root;
      if (repoRoot) startActivity(agentId, owned ? owned.run.source_agent_id : answerer!.agentId, repoRoot, event.turnId);
      return;
    }
    // The user spoke while a review was running: the review is stale.
    for (const run of ledger.activeForSource(agentId)) {
      if (run.status === "REVIEWING" || run.status === "DISPATCHING") {
        const next = await supersede(paseo, run);
        await archiveChild(paseo, next.child_agent_id);
      }
    }
    await snapshotTurn(event, paseo);
    applyCarry(agentId);
    const snapshot = pending.get(agentId);
    if (snapshot) startActivity(agentId, agentId, snapshot.repoRoot, event.turnId);
  }

  async function snapshotTurn(event: TurnStarted, paseo: Paseo): Promise<void> {
    const agentId = event.agent.id;
    let chain = liveChain(agentId);
    // The plugin clears these before sending its own answer or retry, so this is always the user.
    if (chain && (chain.answer_child_id || chain.next_retry_at !== null || chain.answer_at !== null)) {
      chain = await cancelChainWork(paseo, chain);
      chain = await publishChainCard(paseo, chain, {
        state: "stopped",
        canStopAnswering: false,
        nextRetryAt: null,
        permission: null,
        message: "You replied first; the automatic step was canceled.",
      });
    }
    if (chain && chain.card_json) {
      const card = chainCard(chain);
      if (card.state === "needs_user" || (card.state === "notice" && card.category !== "done")) {
        chain = await publishChainCard(paseo, chain, {
          state: "resolved",
          canStopAnswering: false,
          permission: null,
          message: "You replied; the task continues from your answer.",
          suggestion: null,
        });
      }
    }
    if (chain) {
      pending.set(agentId, {
        repoRoot: chain.repo_root,
        policy: JSON.parse(chain.policy_json) as Policy,
        policyJson: chain.policy_json,
        policyHash: chain.policy_hash,
        error: null,
        baseTree: chain.base_tree,
        trigger: (JSON.parse(chain.policy_json) as Policy).trigger,
        turnId: event.turnId,
        chainId: chain.chain_id,
      });
      return;
    }
    const previous = pending.get(agentId);
    if (previous?.policy && previous.baseTree) {
      // An earlier turn has not ended yet (it is being replaced): keep its baseline so its changes stay in scope.
      // ponytail: a turn_ended that never arrives keeps the old baseline until the next finished turn.
      pending.set(agentId, { ...previous, turnId: event.turnId });
      return;
    }
    pending.delete(agentId);
    const loaded = await loadPending(event.agent.cwd);
    if (loaded) pending.set(agentId, { ...loaded, turnId: event.turnId, chainId: null });
  }

  async function handleTurnEnded(event: TurnEnded, paseo: Paseo): Promise<void> {
    const agentId = event.agent.id;
    const concurrent = endActivity(agentId, event.turnId);
    const owned = ledger.child(agentId);
    if (owned) return finalizeReview(paseo, owned.run, agentId, event.outcome, event.timeline, concurrent);
    const answerer = ledger.chainChild(agentId);
    if (answerer) return finalizeAnswer(paseo, agentId, answerer, event.outcome, event.timeline);

    const lastUser = lastUserMessage(event.timeline);
    const messageId = lastUser?.messageId ?? lastUser?.clientMessageId ?? null;
    const taken = takePending(agentId, event.turnId);
    const fix = messageId?.startsWith(FIX_PREFIX) ? /^ptg:(.+):fix:(\d+)$/.exec(messageId) : null;
    if (fix) {
      const run = ledger.get(fix[1]);
      if (run && run.source_agent_id === agentId && run.round === Number(fix[2])) {
        return onFixTurnEnded(paseo, run, event.outcome, concurrent, event.timeline);
      }
      return;
    }

    const skip = (reason: string) => log(`skip ${agentId}: ${reason}`);
    if (taken.stale) return skip("an older turn ended after a newer one started (replaced)");
    const snapshot = taken.snapshot;
    if (!snapshot) return skip("no policy snapshot from turn start (no policy file, not a git repo, or plugin started mid-turn)");
    if (!snapshot.baseTree) return skip("no baseline");

    const source = await refreshAgent(paseo, agentId);
    if (!source) return skip("agent not found");
    if (!triggers(snapshot.trigger, source, event.agent.parentAgentId === null)) return skip(`not a trigger target (${snapshot.trigger})`);
    const policy = snapshot.policy;
    if (!policy) {
      // Only a turn that would have been gated (it changed files) gets the error card.
      if ((await snapshotTree(snapshot.repoRoot)) === snapshot.baseTree) return skip("invalid policy; no changes to gate");
      return publishConfigError(paseo, agentId, snapshot.error ?? "invalid policy", snapshot.policyHash);
    }
    await clearConfigError(paseo, agentId);
    const workspaceId = source.workspaceId ?? event.agent.workspaceId;
    if (!workspaceId) return skip("agent has no workspace");

    const items = currentTurnItems(event.timeline);
    const { category, detail } = classify({ outcome: event.outcome, turnItems: items, statusAtEnd: source.status });
    log(`outcome ${agentId}: ${category}${detail ? ` (${detail.slice(0, 160)})` : ""}`);
    const chain = snapshot.chainId ? ledger.chain(agentId) : null;
    // Overlaps of earlier turns of the same task (chain or carry) plus this one.
    const taskOverlap = new Set([...(taskConcurrent.get(agentId) ?? []), ...concurrent]);
    const task: Task = {
      agentId,
      workspaceId,
      repoRoot: snapshot.repoRoot,
      policy,
      policyJson: snapshot.policyJson,
      policyHash: snapshot.policyHash,
      baseTree: snapshot.baseTree,
      requestText: chainRequestText(chain?.request_text ?? snapshot.carriedRequest ?? null, event.timeline, lastUser),
      turnKey: `${agentId}:${messageId ?? `turn:${event.turnId}:${event.timeline.length}`}`,
      concurrent: [...taskOverlap],
      // Worked: it used tools this turn, or earlier turns of the task did. A chain from a failure alone does not count.
      worked:
        items.some((item) => item.type === "tool_call") ||
        snapshot.carriedRequest !== undefined ||
        (chain !== null && (chain.answers > 0 || chain.retries > 0 || chain.rounds_used > 0)),
      startRound: (chain?.rounds_used ?? 0) + 1,
    };
    await applyOutcome(paseo, task, category, detail, replyText(items));
    // Handled: a run, a chain (both keep the carried baseline) or nothing left to check. A replaced turn's
    // snapshot, carry included, moves on to the newer turn, so the carry stays until that one ends.
    if (snapshot.carriedRequest !== undefined && category !== "replaced") ledger.deleteCarry(agentId);
    // The task goes on (a chain, a carry, or a replacing turn): keep its overlaps for the turn that finishes it.
    if (taskOverlap.size > 0 && (category === "replaced" || ledger.chain(agentId) || ledger.carry(agentId))) {
      taskConcurrent.set(agentId, taskOverlap);
    } else {
      taskConcurrent.delete(agentId);
    }
  }

  /** Auto-approves routine requests of a managed agent; returns the reason when a human must decide. */
  async function autoApprove(
    paseo: Paseo,
    agentId: string,
    request: PermissionRequested["request"],
    permissions: "auto" | "ask",
    repoRoot: string,
  ): Promise<{ approved: true } | { approved: false; reason: string | null }> {
    if (permissions === "ask") return { approved: false, reason: null };
    const decision = decideAutoApproval(request, repoRoot);
    if (!decision.approve) {
      log(`escalated to user for ${agentId}: ${decision.reason}`);
      return { approved: false, reason: decision.reason };
    }
    try {
      await paseo.agents.ref(agentId).respondToPermission({
        requestId: request.id,
        response: { behavior: "allow", ...(decision.actionId ? { selectedActionId: decision.actionId } : {}) },
      });
      log(`auto-approved for ${agentId}: ${request.title ?? request.name}`);
      return { approved: true };
    } catch (error) {
      log("auto-approve failed; asking the user", error instanceof Error ? error.message : error);
      return { approved: false, reason: null };
    }
  }

  async function handlePermission(event: PermissionRequested | PermissionResolved, paseo: Paseo): Promise<void> {
    const agentId = event.agent.id;
    const answerer = ledger.chainChild(agentId);
    if (answerer) {
      const chain = ledger.chain(answerer.agentId);
      if (!chain || chain.answer_child_id !== agentId) return;
      if ("request" in event) {
        await answererPermission(paseo, chain, agentId, event.request);
      } else if (chainCard(chain).permission?.requestId === event.requestId) {
        await publishChainCard(paseo, chain, { permission: null });
      }
      return;
    }
    const owned = ledger.child(agentId);
    if (!owned || owned.run.child_agent_id !== agentId || isTerminal(owned.run.status)) return;
    const runId = owned.run.run_id;
    if ("request" in event) return checkerPermission(paseo, owned.run, agentId, event.request);
    const shown = waiting.get(runId);
    if (shown?.requestId !== event.requestId) return;
    waiting.delete(runId);
    escalatedAt.delete(`${agentId}:${event.requestId}`);
    // A denial (yours on the card, or after the wait) is remembered: the checker is then asked for a verdict.
    const run = event.resolution.behavior === "deny" ? recordDenied(owned.run, agentId, shown.title) : owned.run;
    await publishCard(paseo, run);
  }

  /** A request shown on a card for longer than permission_wait_minutes; null while it may still wait. */
  function overdue(card: PermissionCard | null | undefined, waitMinutes: number): PermissionCard | null {
    if (!card) return null;
    const key = `${card.agentId}:${card.requestId}`;
    const since = escalatedAt.get(key);
    if (since === undefined) {
      escalatedAt.set(key, now()); // shown before a restart: its wait starts now
      return null;
    }
    return now() - since > waitMinutes * minuteMs ? card : null;
  }

  /** Denies a request nobody answered, so the agent finishes with what it has instead of timing out. */
  async function denyOverdue(paseo: Paseo, card: PermissionCard, waitMinutes: number): Promise<boolean> {
    const deny = card.actions.find((action) => action.behavior === "deny");
    try {
      await paseo.agents.ref(card.agentId).respondToPermission({
        requestId: card.requestId,
        response: {
          behavior: "deny",
          ...(deny?.id ? { selectedActionId: deny.id } : {}),
          message: `No answer within ${waitMinutes} minutes; denied automatically by the post-turn gate. Do not retry it.`,
        },
      });
    } catch (error) {
      log("auto-deny failed", error instanceof Error ? error.message : error);
      return false;
    }
    escalatedAt.delete(`${card.agentId}:${card.requestId}`);
    log(`auto-denied for ${card.agentId} after ${waitMinutes} minutes: ${card.title}`);
    return true;
  }

  async function answererPermission(paseo: Paseo, chain: Chain, agentId: string, request: PermissionRequested["request"]): Promise<void> {
    const permissions = (JSON.parse(chain.policy_json) as Policy).agents.answerer.permissions;
    const result = await autoApprove(paseo, agentId, request, permissions, chain.repo_root);
    if (result.approved) return;
    escalatedAt.set(`${agentId}:${request.id}`, escalatedAt.get(`${agentId}:${request.id}`) ?? now());
    await publishChainCard(paseo, chain, { permission: permissionCard(agentId, request, result.reason) });
  }

  async function checkerPermission(paseo: Paseo, run: Run, agentId: string, request: PermissionRequested["request"]): Promise<void> {
    const result = await autoApprove(paseo, agentId, request, specOf(run).permissions, run.repo_root);
    if (result.approved) {
      autoApproved.set(run.run_id, (autoApproved.get(run.run_id) ?? 0) + 1);
      return;
    }
    waiting.set(run.run_id, permissionCard(agentId, request, result.reason));
    escalatedAt.set(`${agentId}:${request.id}`, escalatedAt.get(`${agentId}:${request.id}`) ?? now());
    await publishCard(paseo, run);
  }

  /**
   * `waiting` lives in memory: after a restart (or a missed event) a child's open request would have no card
   * and no buttons, and the child would sit until its timeout. Rebuilds it from the agent's own state.
   */
  async function restorePermissions(paseo: Paseo, run: Run, agent: AgentSnapshot): Promise<void> {
    const shown = waiting.get(run.run_id);
    const open = agent.pendingPermissions;
    if (shown && open.some((request) => request.id === shown.requestId)) return;
    if (shown) waiting.delete(run.run_id);
    if (open.length > 0) return checkerPermission(paseo, run, agent.id, open[0]);
    if (shown) await publishCard(paseo, run);
  }

  function permissionCard(agentId: string, request: PermissionRequested["request"], reason: string | null): PermissionCard {
    const detail = request.detail as { command?: unknown; filePath?: unknown } | undefined;
    const text =
      typeof detail?.command === "string"
        ? detail.command
        : typeof detail?.filePath === "string"
          ? detail.filePath
          : (request.description ?? null);
    const actions = (request.actions ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      behavior: action.behavior,
    }));
    return {
      agentId,
      requestId: request.id,
      kind: request.kind,
      title: truncate(request.title ?? request.name, 300),
      detail: text ? truncate(text, 1000) : null,
      reason,
      actions: actions.length > 0
        ? actions
        : [
            { id: "", label: "Allow", behavior: "allow" },
            { id: "", label: "Deny", behavior: "deny" },
          ],
    };
  }

  // ---------- recovery ----------

  async function reconcileRun(paseo: Paseo, run: Run): Promise<void> {
    if (run.status === "DISPATCHING") {
      // A dispatch that keeps failing before its child exists (refresh or config errors) is retried here,
      // but not forever: without a payload there is no deadline yet, so count from the last state change.
      const deadline = run.deadline_at ?? run.updated_at + timeoutOf(run);
      if (now() > deadline) return fail(paseo, run, `could not start the ${checkOf(run)} agent within ${Math.round(timeoutOf(run) / 60000)} minutes`);
      if (run.dispatch_json) return createChild(paseo, run);
      return dispatch(paseo, run);
    }
    const watched = run.status === "REVIEWING" ? run.child_agent_id : run.source_agent_id;
    if (!watched) return fail(paseo, run, "run has no agent to watch");
    const agent = await refreshAgent(paseo, watched);
    if (!agent) return fail(paseo, run, `agent ${watched} no longer exists`);
    if (agent.status === "running" || agent.status === "initializing") {
      // A gate never waits forever: time spent waiting for a permission answer counts too.
      if (run.deadline_at !== null && now() > run.deadline_at) {
        const waitingOn = agent.pendingPermissions.length > 0 ? " (a permission request was not answered)" : "";
        return fail(paseo, run, `timed out after ${Math.round(timeoutOf(run) / 60000)} minutes${waitingOn}`);
      }
      if (run.status !== "REVIEWING") return;
      await restorePermissions(paseo, run, agent);
      const wait = specOf(run).permission_wait_minutes;
      const stale = overdue(waiting.get(run.run_id), wait);
      if (stale && (await denyOverdue(paseo, stale, wait))) {
        waiting.delete(run.run_id);
        await publishCard(paseo, recordDenied(run, stale.agentId, stale.title));
      }
      return;
    }
    // ponytail: only the last 500 items are searched; a fix turn longer than that would look unsent
    // and be re-sent (the daemon dedupes by messageId). Upgrade path: page backwards with the cursor.
    const page = await paseo.agents.ref(watched).timeline.refetch({ direction: "tail", limit: 500, projection: "canonical" });
    const items = page.entries.map((entry) => entry.item) as TimelineItem[];
    if (run.status === "REVIEWING") {
      if (agent.status === "error") return fail(paseo, run, `reviewer failed: ${agent.lastError ?? "unknown error"}`);
      return finalizeReview(paseo, run, watched, { kind: "completed" }, items);
    }
    // FIXING: find our fix message; anything the user sent after it supersedes the run.
    const expected = fixMessageId(run);
    const index = items.findIndex((item) => item.type === "user_message" && item.messageId === expected);
    if (index === -1) {
      // The send never landed (crash between ledger write and send): send again, deduplicated by messageId.
      const verdict = JSON.parse(run.result_json ?? "null") as Verdict | null;
      if (!verdict) return fail(paseo, run, "fix round lost its findings");
      const policy = JSON.parse(run.policy_json) as Policy;
      await paseo.agents.ref(run.source_agent_id).send(buildFixPrompt(verdict, run.round, maxFixRounds(policy), concurrentOf(run)), {
        messageId: expected,
      });
      return;
    }
    const later = items.slice(index + 1);
    if (later.some((item) => item.type === "user_message")) {
      await supersede(paseo, run);
      return;
    }
    return onFixTurnEnded(paseo, run, { kind: "completed" }, [], items);
  }

  async function reconcileChains(paseo: Paseo): Promise<void> {
    for (const chain of ledger.chains()) {
      try {
        if (now() - chain.created_at > CHAIN_TTL_MS) {
          await endChain(paseo, chain.agent_id, null);
        } else if (chain.next_retry_at !== null && chain.next_retry_at <= now()) {
          await sendRetry(paseo, chain);
        } else if (chain.answer_at !== null && chain.answer_at <= now()) {
          await startScheduledAnswer(paseo, chain);
        } else if (chain.answer_child_id) {
          await reconcileAnswerer(paseo, chain);
        }
      } catch (error) {
        log(`reconcile chain ${chain.chain_id} failed`, error);
      }
    }
  }

  async function reconcileAnswerer(paseo: Paseo, chain: Chain): Promise<void> {
    const childId = chain.answer_child_id!;
    const child = await refreshAgent(paseo, childId).catch(() => null);
    if (!child) return createAnswerer(paseo, chain); // the create never landed; replay it idempotently
    if (child.status === "running" || child.status === "initializing") {
      if (chain.answer_deadline_at !== null && now() > chain.answer_deadline_at) {
        return needsUser(paseo, await cancelChainWork(paseo, chain), undefined, "the answerer timed out");
      }
      // The card keeps its permission in the ledger, but a request that arrived while the plugin was down has none.
      const shown = chainCard(chain).permission;
      const open = child.pendingPermissions;
      if (open.length > 0 && !open.some((request) => request.id === shown?.requestId)) {
        await answererPermission(paseo, chain, childId, open[0]);
      } else if (open.length === 0 && shown) {
        await publishChainCard(paseo, chain, { permission: null });
      } else {
        const wait = (JSON.parse(chain.policy_json) as Policy).agents.answerer.permission_wait_minutes;
        const stale = overdue(shown, wait);
        if (stale && (await denyOverdue(paseo, stale, wait))) {
          deniedAnswerers.add(childId);
          await publishChainCard(paseo, chain, { permission: null });
        }
      }
      return;
    }
    const page = await paseo.agents.ref(childId).timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" });
    const items = page.entries.map((entry) => entry.item) as TimelineItem[];
    const outcome: TurnEnded["outcome"] =
      child.status === "error" ? { kind: "failed", error: { message: child.lastError ?? "answerer failed" } } : { kind: "completed" };
    return finalizeAnswer(paseo, childId, { agentId: chain.agent_id, chainId: chain.chain_id }, outcome, items);
  }

  return {
    onTurnStarted: (event, paseo) => enqueue("turn_started", () => handleTurnStarted(event, paseo)),
    onTurnEnded: (event, paseo) => enqueue("turn_ended", () => handleTurnEnded(event, paseo)),
    onPermission: (event, paseo) => enqueue("permission", () => handlePermission(event, paseo)),
    reconcile: (paseo) =>
      enqueue("reconcile", async () => {
        for (const run of ledger.active()) {
          const fresh = ledger.get(run.run_id);
          if (!fresh || isTerminal(fresh.status)) continue;
          await reconcileRun(paseo, fresh).catch((error) => log(`reconcile ${run.run_id} failed`, error));
        }
        await reconcileChains(paseo);
      }),
    stopAnswering: (chainId, paseo) =>
      new Promise((resolve) =>
        enqueue("stop answering", async () => {
          try {
            resolve(await stopAnswering(chainId, paseo));
          } catch (error) {
            resolve(false);
            throw error;
          }
        }),
      ),
    close: () => {
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    },
    idle: async () => {
      let current: Promise<void>;
      do {
        current = tail;
        await current;
      } while (current !== tail);
    },
  };
}
