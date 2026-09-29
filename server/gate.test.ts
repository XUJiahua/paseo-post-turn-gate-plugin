import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { CardData } from "../shared/schema.ts";
import { createGate, type Gate, type Paseo } from "./gate.ts";
import { Ledger } from "./ledger.ts";
import { parseVerdict } from "./prompts.ts";
import { resolveReviewer } from "./reviewer.ts";

// ---------- fixtures ----------

interface FakeAgent {
  id: string;
  provider: string;
  model: string | null;
  currentModeId: string | null;
  thinkingOptionId: string | null;
  features: Array<{ type: "toggle"; id: string; label: string; value: boolean }>;
  labels: Record<string, string>;
  status: string;
  workspaceId: string;
  title: string | null;
  pendingPermissions: unknown[];
  lastError?: string;
}

type Item = { type: string; text?: string; messageId?: string };

function createFakePaseo() {
  const agents = new Map<string, FakeAgent>();
  const timelines = new Map<string, Item[]>();
  const created: Array<Record<string, any>> = [];
  const sent: Array<{ agentId: string; text: string; messageId?: string }> = [];
  const archived: string[] = [];
  const cards = new Map<string, CardData>();
  let failCreate = false;
  const profiles: Array<Record<string, unknown>> = [];
  const api = {
    config: { get: async () => ({ requestId: "r", config: { agentProfiles: profiles } }) },
    agents: {
      ref: (id: string) => ({
        refresh: async () => (agents.has(id) ? { agent: agents.get(id), project: null } : null),
        send: async (text: string, options?: { messageId?: string }) => {
          sent.push({ agentId: id, text, messageId: options?.messageId });
        },
        archive: async () => {
          archived.push(id);
          return { archivedAt: new Date().toISOString() };
        },
        timeline: {
          append: async (item: { id: string; data: CardData }) => {
            cards.set(item.id, item.data);
            return { seq: 0, epoch: "e" };
          },
          refetch: async () => ({ entries: (timelines.get(id) ?? []).map((item) => ({ item })) }),
        },
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        agents: {
          create: async (options: Record<string, any>) => {
            created.push({ workspaceId, ...options });
            if (failCreate) throw new Error("provider unavailable");
            agents.set(options.agentId, {
              ...agents.get(options.parent)!,
              id: options.agentId,
              labels: { ...options.labels, "paseo.parent-agent-id": options.parent },
              status: "running",
              title: options.title,
            });
            return { id: options.agentId };
          },
        },
      }),
    },
  };
  return {
    paseo: api as unknown as Paseo,
    agents,
    timelines,
    created,
    sent,
    archived,
    cards,
    profiles,
    setFailCreate: (value: boolean) => {
      failCreate = value;
    },
  };
}

const SOURCE = "source-agent";

function sourceAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    id: SOURCE,
    provider: "kiro",
    model: "claude-opus-4.8",
    currentModeId: "kiro_default",
    thinkingOptionId: null,
    features: [{ type: "toggle", id: "auto_accept", label: "Auto accept", value: false }],
    labels: {},
    status: "idle",
    workspaceId: "ws-1",
    title: "root task",
    pendingPermissions: [],
    ...overrides,
  };
}

const PASS = JSON.stringify({ verdict: "PASS", summary: "looks good", findings: [] });
const FAIL = JSON.stringify({
  verdict: "FAIL",
  summary: "bug found",
  findings: [
    { severity: "HIGH", title: "Off by one", evidence: "a.txt:1", suggested_fix: "use <=" },
    { severity: "LOW", title: "Naming", evidence: "a.txt:2", suggested_fix: "rename" },
  ],
});

let repo: string;
let ledgerFile: string;
let ledger: Ledger;
let fake: ReturnType<typeof createFakePaseo>;
let gate: Gate;
let clock: number;

function git(...args: string[]) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" });
}

function writePolicy(policy: unknown) {
  mkdirSync(path.join(repo, ".paseo"), { recursive: true });
  writeFileSync(
    path.join(repo, ".paseo/post-turn-gate.json"),
    typeof policy === "string" ? policy : JSON.stringify(policy),
  );
}

function hookAgent(id: string, parentAgentId: string | null = null) {
  return { id, workspaceId: "ws-1", parentAgentId, provider: "kiro", cwd: repo, title: null };
}

async function sourceTurn(options: {
  agentId?: string;
  parentAgentId?: string | null;
  messageId?: string;
  change?: () => void;
  outcome?: { kind: "completed" } | { kind: "canceled"; reason: string };
}) {
  const agent = hookAgent(options.agentId ?? SOURCE, options.parentAgentId ?? null);
  gate.onTurnStarted({ agent, turnId: "t" }, fake.paseo);
  await gate.idle();
  options.change?.();
  gate.onTurnEnded(
    {
      agent,
      turnId: "t",
      outcome: options.outcome ?? { kind: "completed" },
      timeline: [
        { type: "user_message", text: "Implement feature X", messageId: options.messageId ?? "msg-1" },
        { type: "assistant_message", text: "Done." },
      ] as never,
    },
    fake.paseo,
  );
  await gate.idle();
}

async function childTurn(childId: string, reply: string, change?: () => void) {
  change?.();
  const agent = hookAgent(childId, SOURCE);
  gate.onTurnEnded(
    {
      agent,
      turnId: "c",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "prompt", messageId: "ptg:x:1" },
        // Providers may split one reply across chunks.
        { type: "assistant_message", text: reply.slice(0, 10) },
        { type: "assistant_message", text: reply.slice(10) },
      ] as never,
    },
    fake.paseo,
  );
  await gate.idle();
}

const onlyRun = () => {
  const runs = [...fake.cards.entries()].filter(([id]) => !id.startsWith("post-turn-gate:config:"));
  assert.equal(runs.length, 1, "expected exactly one run card");
  return runs[0][1];
};

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "ptg-test-"));
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "init");
  ledgerFile = path.join(repo, "..", `${path.basename(repo)}.sqlite`);
  ledger = new Ledger(ledgerFile);
  fake = createFakePaseo();
  fake.agents.set(SOURCE, sourceAgent());
  clock = 1_000;
  gate = createGate({ ledger, now: () => clock, reviewTimeoutMs: 1_000, log: () => {} });
});

afterEach(() => {
  ledger.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(ledgerFile, { force: true });
  rmSync(`${ledgerFile}-wal`, { force: true });
  rmSync(`${ledgerFile}-shm`, { force: true });
});

const edit = () => writeFileSync(path.join(repo, "a.txt"), "two\n");

// ---------- tests ----------

describe("trigger", () => {
  test("no policy file: nothing happens", async () => {
    await sourceTurn({ change: edit });
    assert.equal(fake.created.length, 0);
  });

  test("action none, unchanged workspace, or non-completed turns do not dispatch", async () => {
    writePolicy({ version: 1, action: "none" });
    await sourceTurn({ change: edit, messageId: "a" });
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ messageId: "b" }); // policy rewritten before turn_started, but no change during the turn
    await sourceTurn({ change: () => writeFileSync(path.join(repo, "a.txt"), "three\n"), messageId: "c", outcome: { kind: "canceled", reason: "x" } });
    assert.equal(fake.created.length, 0);
  });

  test("invalid policy shows a config error card and starts nothing", async () => {
    writePolicy({ version: 1, action: "review", review: { on_fail: "retry" } });
    await sourceTurn({ change: edit });
    assert.equal(fake.created.length, 0);
    const card = fake.cards.get(`post-turn-gate:config:${SOURCE}`);
    assert.equal(card?.status, "ERROR");
    assert.match(card?.error ?? "", /review\.on_fail/);
  });

  test("the policy is frozen at turn start", async () => {
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ change: () => { edit(); writePolicy({ version: 1, action: "none" }); } });
    assert.equal(fake.created.length, 1);
  });

  test("sub-agents need the target label; managed agents never trigger", async () => {
    writePolicy({ version: 1, action: "review" });
    fake.agents.set("sub", sourceAgent({ id: "sub" }));
    await sourceTurn({ agentId: "sub", parentAgentId: SOURCE, change: edit, messageId: "s1" });
    assert.equal(fake.created.length, 0);

    fake.agents.set("sub", sourceAgent({ id: "sub", labels: { "post-turn-gate.target": "true" } }));
    await sourceTurn({ agentId: "sub", parentAgentId: SOURCE, change: () => writeFileSync(path.join(repo, "b.txt"), "b"), messageId: "s2" });
    assert.equal(fake.created.length, 1);

    fake.agents.set("other", sourceAgent({ id: "other", labels: { "post-turn-gate.managed": "true" } }));
    await sourceTurn({ agentId: "other", change: () => writeFileSync(path.join(repo, "c.txt"), "c"), messageId: "o1" });
    assert.equal(fake.created.length, 1);
  });

  test("root_only ignores labelled sub-agents", async () => {
    writePolicy({ version: 1, action: "review", trigger: "root_only" });
    fake.agents.set("sub", sourceAgent({ id: "sub", labels: { "post-turn-gate.target": "true" } }));
    await sourceTurn({ agentId: "sub", parentAgentId: SOURCE, change: edit });
    assert.equal(fake.created.length, 0);
  });

  test("the same source turn creates one run", async () => {
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ change: edit, messageId: "same" });
    await sourceTurn({ change: () => writeFileSync(path.join(repo, "a.txt"), "again\n"), messageId: "same" });
    assert.equal(fake.created.length, 1);
  });
});

describe("dispatch and report", () => {
  test("reviewer inherits the source config, runs in its workspace, and FAIL is reported", async () => {
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ change: edit });

    assert.equal(fake.created.length, 1);
    const create = fake.created[0];
    assert.equal(create.workspaceId, "ws-1");
    assert.equal(create.parent, SOURCE);
    assert.deepEqual(create.config, {
      provider: "kiro/claude-opus-4.8",
      modeId: "kiro_default",
      featureValues: { auto_accept: false },
    });
    assert.equal(create.labels["post-turn-gate.managed"], "true");
    assert.equal(create.labels["post-turn-gate.role"], "reviewer");
    assert.equal(create.idempotencyKey, create.clientMessageId);
    assert.ok(create.outputSchema);
    assert.match(create.prompt, /Implement feature X/);
    assert.match(create.prompt, /git -C .* diff [0-9a-f]{40} [0-9a-f]{40}/);
    assert.equal(onlyRun().status, "REVIEWING");

    await childTurn(create.agentId, FAIL);
    const card = onlyRun();
    assert.equal(card.status, "FAILED");
    assert.equal(card.findings.length, 1, "only blocking findings are shown");
    assert.equal(card.otherFindings, 1);
    assert.equal(card.reviewerChanges, null);
    assert.deepEqual(fake.archived, [create.agentId]);
    assert.equal(fake.sent.length, 0, "report mode never sends to the source");
  });

  test("PASS and verify role", async () => {
    writePolicy({ version: 1, action: "verify" });
    await sourceTurn({ change: edit });
    assert.equal(fake.created[0].labels["post-turn-gate.role"], "verifier");
    assert.match(fake.created[0].prompt, /VERIFIER/);
    await childTurn(fake.created[0].agentId, PASS);
    assert.equal(onlyRun().status, "PASSED");
  });

  test("an unparseable reply is an ERROR, never a PASS", async () => {
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ change: edit });
    await childTurn(fake.created[0].agentId, "Looks fine to me!");
    assert.equal(onlyRun().status, "ERROR");
    assert.match(onlyRun().error ?? "", /verdict/);
  });

  test("workspace edits by the reviewer are reported but do not change the verdict", async () => {
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ change: edit });
    await childTurn(fake.created[0].agentId, PASS, () => writeFileSync(path.join(repo, "note.txt"), "x\n"));
    const card = onlyRun();
    assert.equal(card.status, "PASSED");
    assert.match(card.reviewerChanges ?? "", /note\.txt/);
  });

  test("a failed create is an ERROR", async () => {
    writePolicy({ version: 1, action: "review" });
    fake.setFailCreate(true);
    await sourceTurn({ change: edit });
    assert.equal(onlyRun().status, "ERROR");
    assert.match(onlyRun().error ?? "", /provider unavailable/);
  });

  test("permission waits are shown on the card", async () => {
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ change: edit });
    const childId = fake.created[0].agentId;
    const request = {
      id: "req-1",
      name: "execute",
      kind: "tool",
      title: "Running: git diff --stat",
      detail: { type: "shell", command: "git diff --stat" },
      actions: [
        { id: "allow_once", label: "Yes", behavior: "allow" },
        { id: "allow_always", label: "Always", behavior: "allow" },
        { id: "reject_once", label: "No", behavior: "deny" },
      ],
    };
    gate.onPermission({ agent: hookAgent(childId, SOURCE), request } as never, fake.paseo);
    await gate.idle();
    assert.equal(onlyRun().waiting, true);
    assert.deepEqual(onlyRun().permission, {
      agentId: childId,
      requestId: "req-1",
      kind: "tool",
      title: "Running: git diff --stat",
      detail: "git diff --stat",
      actions: request.actions,
    });
    gate.onPermission({ agent: hookAgent(childId, SOURCE), requestId: "other", resolution: {} } as never, fake.paseo);
    await gate.idle();
    assert.equal(onlyRun().waiting, true, "resolving a different request keeps the prompt");
    gate.onPermission({ agent: hookAgent(childId, SOURCE), requestId: "req-1", resolution: {} } as never, fake.paseo);
    await gate.idle();
    assert.equal(onlyRun().waiting, false);
    assert.equal(onlyRun().permission, null);
  });

  test("a user message during review supersedes the run and stops the reviewer", async () => {
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ change: edit });
    const childId = fake.created[0].agentId;
    gate.onTurnStarted({ agent: hookAgent(SOURCE), turnId: "t2" }, fake.paseo);
    await gate.idle();
    assert.equal(onlyRun().status, "SUPERSEDED");
    assert.deepEqual(fake.archived, [childId]);
    await childTurn(childId, FAIL); // late reply is ignored
    assert.equal(onlyRun().status, "SUPERSEDED");
  });
});

describe("fix loop", () => {
  async function fixTurn(round: number, change: () => void) {
    const runId = fake.sent.at(-1)!.messageId!.split(":")[1];
    await sourceTurn({ messageId: `ptg:${runId}:fix:${round}`, change });
  }

  test("FAIL sends findings back, re-reviews against the original base, and PASS ends it", async () => {
    writePolicy({ version: 1, action: "review", review: { on_fail: "fix", max_fix_rounds: 2 } });
    await sourceTurn({ change: edit });
    await childTurn(fake.created[0].agentId, FAIL);

    assert.equal(onlyRun().status, "FIXING");
    assert.equal(fake.sent.length, 1);
    assert.match(fake.sent[0].messageId!, /^ptg:.+:fix:1$/);
    assert.match(fake.sent[0].text, /Off by one/);

    await fixTurn(1, () => writeFileSync(path.join(repo, "a.txt"), "fixed\n"));
    assert.equal(fake.created.length, 2, "fix turn triggers a second review, not a new run");
    const baseOf = (prompt: string) => /diff ([0-9a-f]{40}) ([0-9a-f]{40})/.exec(prompt)!;
    assert.equal(baseOf(fake.created[1].prompt)[1], baseOf(fake.created[0].prompt)[1], "same base tree");
    assert.notEqual(baseOf(fake.created[1].prompt)[2], baseOf(fake.created[0].prompt)[2], "new end tree");
    assert.equal(onlyRun().round, 2);

    await childTurn(fake.created[1].agentId, PASS);
    assert.equal(onlyRun().status, "PASSED");
    assert.deepEqual(fake.archived, [fake.created[0].agentId, fake.created[1].agentId]);
  });

  test("the round limit ends in NEEDS_HUMAN", async () => {
    writePolicy({ version: 1, action: "review", review: { on_fail: "fix", max_fix_rounds: 1 } });
    await sourceTurn({ change: edit });
    await childTurn(fake.created[0].agentId, FAIL);
    await fixTurn(1, () => writeFileSync(path.join(repo, "a.txt"), "fixed\n"));
    await childTurn(fake.created[1].agentId, FAIL);
    assert.equal(onlyRun().status, "NEEDS_HUMAN");
    assert.equal(fake.sent.length, 1);
  });

  test("a busy source is never interrupted", async () => {
    writePolicy({ version: 1, action: "review", review: { on_fail: "fix", max_fix_rounds: 2 } });
    await sourceTurn({ change: edit });
    fake.agents.set(SOURCE, sourceAgent({ status: "running" }));
    await childTurn(fake.created[0].agentId, FAIL);
    assert.equal(onlyRun().status, "SUPERSEDED");
    assert.equal(fake.sent.length, 0);
  });

  test("a canceled fix turn supersedes the run", async () => {
    writePolicy({ version: 1, action: "review", review: { on_fail: "fix", max_fix_rounds: 2 } });
    await sourceTurn({ change: edit });
    await childTurn(fake.created[0].agentId, FAIL);
    const runId = fake.sent[0].messageId!.split(":")[1];
    await sourceTurn({ messageId: `ptg:${runId}:fix:1`, outcome: { kind: "canceled", reason: "user" } });
    assert.equal(onlyRun().status, "SUPERSEDED");
  });
});

describe("recovery", () => {
  test("a crashed dispatch replays the recorded create; an idle reviewer is finalized from its timeline", async () => {
    writePolicy({ version: 1, action: "review" });
    fake.setFailCreate(true);
    await sourceTurn({ change: edit });
    // Simulate "create failed ambiguously and the plugin died": put the run back to DISPATCHING.
    const runId = fake.created[0].labels["post-turn-gate.run-id"];
    ledger.update(runId, { status: "DISPATCHING", error: null }, clock);
    fake.setFailCreate(false);

    const restarted = createGate({ ledger, now: () => clock, reviewTimeoutMs: 1_000, log: () => {} });
    restarted.reconcile(fake.paseo);
    await restarted.idle();
    assert.equal(fake.created.length, 2);
    assert.equal(fake.created[1].agentId, fake.created[0].agentId, "same child id");
    assert.equal(fake.created[1].idempotencyKey, fake.created[0].idempotencyKey, "same idempotency key");
    assert.equal(onlyRun().status, "REVIEWING");

    const childId = fake.created[1].agentId;
    fake.agents.get(childId)!.status = "idle";
    fake.timelines.set(childId, [
      { type: "user_message", text: "prompt" },
      { type: "assistant_message", text: PASS },
    ]);
    restarted.reconcile(fake.paseo);
    await restarted.idle();
    assert.equal(onlyRun().status, "PASSED");
  });

  test("a running reviewer times out, unless it is waiting for permission", async () => {
    writePolicy({ version: 1, action: "review" });
    await sourceTurn({ change: edit });
    const child = fake.agents.get(fake.created[0].agentId)!;
    child.pendingPermissions = [{}];
    clock += 5_000;
    gate.reconcile(fake.paseo);
    await gate.idle();
    assert.equal(onlyRun().status, "REVIEWING", "permission wait extends the deadline");

    child.pendingPermissions = [];
    clock += 5_000;
    gate.reconcile(fake.paseo);
    await gate.idle();
    assert.equal(onlyRun().status, "ERROR");
    assert.match(onlyRun().error ?? "", /timed out/);
  });

  test("a FIXING run whose fix message never landed is re-sent with the same messageId", async () => {
    writePolicy({ version: 1, action: "review", review: { on_fail: "fix", max_fix_rounds: 2 } });
    await sourceTurn({ change: edit });
    await childTurn(fake.created[0].agentId, FAIL);
    fake.timelines.set(SOURCE, [{ type: "user_message", text: "Implement feature X", messageId: "msg-1" }]);
    gate.reconcile(fake.paseo);
    await gate.idle();
    assert.equal(fake.sent.length, 2);
    assert.equal(fake.sent[1].messageId, fake.sent[0].messageId);

    // Now the fix turn finished while the plugin was away.
    fake.timelines.set(SOURCE, [
      { type: "user_message", text: "fix", messageId: fake.sent[0].messageId },
      { type: "assistant_message", text: "fixed" },
    ]);
    writeFileSync(path.join(repo, "a.txt"), "fixed\n");
    gate.reconcile(fake.paseo);
    await gate.idle();
    assert.equal(fake.created.length, 2);
    assert.equal(onlyRun().round, 2);
  });
});

describe("parseVerdict", () => {
  test("accepts raw JSON, fenced JSON, and JSON surrounded by prose; rejects everything else", () => {
    assert.equal(parseVerdict(PASS)?.verdict, "PASS");
    assert.equal(parseVerdict("Here you go:\n```json\n" + FAIL + "\n```")?.verdict, "FAIL");
    assert.equal(parseVerdict("Result: " + PASS + " — done")?.verdict, "PASS");
    assert.equal(parseVerdict('{"verdict":"MAYBE","summary":"","findings":[]}'), null);
    assert.equal(parseVerdict("PASS"), null);
    assert.equal(parseVerdict(""), null);
  });
});

describe("reviewer config", () => {
  const source = {
    provider: "kiro",
    model: "claude-opus-4.8",
    modeId: "kiro_default",
    featureValues: { auto_accept: false },
  };
  const profiles = [
    { id: "p-review", name: "Review", provider: "codex", model: "gpt-5.5", modeId: "auto-review" },
    { id: "p-kiro", name: "Kiro planner", provider: "kiro", modeId: "kiro_planner" },
    { id: "dup-1", name: "Dup", provider: "kiro" },
    { id: "dup-2", name: "Dup", provider: "kiro" },
  ];

  test("inherits the source by default", () => {
    assert.deepEqual(resolveReviewer(source, {}, []), { ok: true, config: source, source: "source agent" });
  });

  test("a profile on another provider drops every inherited provider-specific field", () => {
    const resolved = resolveReviewer(source, { profile: "Review" }, profiles);
    assert.deepEqual(resolved, {
      ok: true,
      config: { provider: "codex", model: "gpt-5.5", modeId: "auto-review" },
      source: 'profile "Review"',
    });
  });

  test("a profile on the same provider keeps inherited fields it does not set", () => {
    const resolved = resolveReviewer(source, { profile: "p-kiro" }, profiles);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.config, { ...source, modeId: "kiro_planner" });
  });

  test("explicit fields win over the profile", () => {
    const resolved = resolveReviewer(source, { profile: "Review", model: "gpt-5.4-mini", thinking: "high" }, profiles);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.config, {
      provider: "codex",
      model: "gpt-5.4-mini",
      modeId: "auto-review",
      thinkingOptionId: "high",
    });
  });

  test("errors: unknown or ambiguous profile, provider switch without a model", () => {
    const missing = resolveReviewer(source, { profile: "nope" }, profiles);
    assert.ok(!missing.ok && /not found.*"Review" \(p-review\)/.test(missing.error));
    const dup = resolveReviewer(source, { profile: "Dup" }, profiles);
    assert.ok(!dup.ok && /ambiguous/.test(dup.error));
    const noModel = resolveReviewer(source, { provider: "claude" }, profiles);
    assert.ok(!noModel.ok && /set reviewer\.model/.test(noModel.error));
  });

  test("dispatch uses the profile, appends instructions, and a missing profile is an ERROR card", async () => {
    fake.profiles.push({ id: "p-review", name: "Review", provider: "codex", model: "gpt-5.5", modeId: "auto-review" });
    writePolicy({ version: 1, action: "review", reviewer: { profile: "Review", instructions: "Check the README too." } });
    await sourceTurn({ change: edit, messageId: "m1" });
    assert.deepEqual(fake.created[0].config, { provider: "codex/gpt-5.5", modeId: "auto-review" });
    assert.match(fake.created[0].prompt, /Check the README too\./);
    assert.match(fake.created[0].prompt, /Reply with ONLY one JSON object/, "contract stays after instructions");

    fake.profiles.length = 0;
    await sourceTurn({ change: () => writeFileSync(path.join(repo, "b.txt"), "b"), messageId: "m2" });
    assert.equal(fake.created.length, 1);
    const errorCard = [...fake.cards.values()].find((card) => card.status === "ERROR");
    assert.match(errorCard?.error ?? "", /agent profile "Review" not found/);
  });

  test("an unknown reviewer key is a config error", async () => {
    writePolicy({ version: 1, action: "review", reviewer: { profiel: "Review" } });
    await sourceTurn({ change: edit });
    assert.equal(fake.created.length, 0);
    assert.match(fake.cards.get(`post-turn-gate:config:${SOURCE}`)?.error ?? "", /profiel/);
  });

  test("timeout_minutes overrides the default deadline", async () => {
    writePolicy({ version: 1, action: "review", reviewer: { timeout_minutes: 60 } });
    await sourceTurn({ change: edit });
    clock += 5_000; // past the 1s test default, well inside 60 minutes
    gate.reconcile(fake.paseo);
    await gate.idle();
    assert.equal(onlyRun().status, "REVIEWING");
  });
});
