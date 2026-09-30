import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Repository policy: <git toplevel>/.paseo/post-turn-gate.json
export const POLICY_PATH = ".paseo/post-turn-gate.json";

export type Role = "reviewer" | "verifier" | "answerer";
export type Check = "review" | "verify";
export const ROLE_OF: Record<Check, Role> = { review: "reviewer", verify: "verifier" };
/** Optional profile ids created by `npm run profiles`. */
export const ROLE_PROFILE: Record<Role, string> = {
  reviewer: "post-turn-gate-reviewer",
  verifier: "post-turn-gate-verifier",
  answerer: "post-turn-gate-answerer",
};

/** Maximum length of a role's rules (file plus inline instructions). */
export const INSTRUCTIONS_LIMIT = 20000;
export const defaultInstructionsFile = (role: Role) => `.paseo/post-turn-gate/${role}.md`;

function agentSchema(role: Role, timeoutMinutes: number, instructionsFile = defaultInstructionsFile(role)) {
  return z
    .object({
      /**
       * Optional Paseo launch profile, matched by id first, then by exact name.
       * null: inherit the source agent; repository instructions are configured separately below.
       */
      profile: z.string().min(1).nullable().default(null),
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      mode: z.string().min(1).optional(),
      thinking: z.string().min(1).optional(),
      features: z.record(z.string(), z.unknown()).optional(),
      /**
       * Rules for this role kept in the repository, relative to the git root. The default path is optional
       * (a missing file means no rules); any other path must exist. null: no file.
       */
      instructions_file: z.string().min(1).nullable().default(instructionsFile),
      /** Appended to the built-in role prompt after the file's rules; cannot replace the reply contract. */
      instructions: z.string().max(INSTRUCTIONS_LIMIT).optional(),
      /** auto: approve routine tool use, escalate risky requests to the card; ask: every request goes to the user. */
      permissions: z.enum(["auto", "ask"]).default("auto"),
      timeout_minutes: z.number().int().min(1).max(240).default(timeoutMinutes),
      /**
       * How long a request shown on the card waits for your answer before it is denied automatically, so the
       * agent can finish with the evidence it has instead of running into timeout_minutes.
       */
      permission_wait_minutes: z.number().int().min(1).max(240).default(5),
    })
    .strict()
    .prefault({});
}
export type AgentSpec = z.output<ReturnType<typeof agentSchema>>;

export const agentsSchema = z
  .object({
    reviewer: agentSchema("reviewer", 30),
    verifier: agentSchema("verifier", 30),
    answerer: agentSchema("answerer", 10),
  })
  .strict()
  .prefault({});

// ---------- turn outcomes (docs/turn-outcomes.md) ----------

export const CATEGORIES = [
  "done",
  "awaiting_user",
  "refused",
  "user_canceled",
  "replaced",
  "crashed",
  "network",
  "rate_limited",
  "quota_exhausted",
  "context_exhausted",
  "error",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const DEFAULT_RETRY_MESSAGE = "Continue from where you left off.";

const retryActionSchema = z
  .object({
    retry: z
      .object({
        max: z.number().int().min(1).max(3),
        delay_seconds: z.number().int().min(5).max(3600),
        message: z.string().min(1).max(2000).optional(),
      })
      .strict(),
  })
  .strict();
const answerActionSchema = z
  .object({
    answer: z
      .object({
        max: z.number().int().min(1).max(10).default(3),
        /** Grace period before the answerer starts: a reply from you in that time cancels it. */
        delay_seconds: z.number().int().min(0).max(3600).default(60),
      })
      .strict(),
  })
  .strict();
const passive = z.enum(["notify", "ignore"]);
const retryable = z.union([passive, retryActionSchema]);

// Retry is only accepted where waiting can help; quota and context exhaustion never recover by retrying.
export const onOutcomeSchema = z
  .object({
    /** Checks a finished task gets, run in order until one fails; or a notice, or nothing. */
    done: z
      .union([
        z
          .array(z.enum(["review", "verify"]))
          .min(1)
          .refine((checks) => new Set(checks).size === checks.length, "each check may appear once"),
        z.enum(["notify", "ignore"]),
      ])
      .default(["review"]),
    /** as_done: treat the stop as finished and apply `done`. */
    awaiting_user: z.union([z.enum(["as_done", "notify", "ignore"]), answerActionSchema]).default({ answer: { max: 3, delay_seconds: 60 } }),
    refused: passive.default("notify"),
    user_canceled: passive.default("ignore"),
    replaced: passive.default("ignore"),
    crashed: retryable.default("notify"),
    network: retryable.default("notify"),
    rate_limited: retryable.default("notify"),
    quota_exhausted: passive.default("notify"),
    context_exhausted: passive.default("notify"),
    error: passive.default("notify"),
  })
  .strict();
export type OnOutcome = z.output<typeof onOutcomeSchema>;
export type OutcomeAction = OnOutcome[Category];

export const answerReplySchema = z.object({
  state: z.enum(["awaiting_user", "done", "incomplete", "refused"]),
  question: z.string().default(""),
  decision: z.enum(["answer", "escalate"]),
  answer: z.string().default(""),
  reason: z.string().default(""),
});
export type AnswerReply = z.output<typeof answerReplySchema>;
export const ANSWER_JSON_SCHEMA = z.toJSONSchema(answerReplySchema) as Record<string, unknown>;

// ---------- decider (version 3) ----------

export const deciderReplySchema = z.object({
  kind: z.enum(["send", "done", "escalate"]),
  /** send: the whole message for the agent. */
  message: z.string().default(""),
  /** send: the message answers a question the agent asked. */
  answers_question: z.boolean().default(false),
  /** escalate: what the user has to decide. */
  question: z.string().default(""),
  reason: z.string().default(""),
});
export type DeciderReply = z.output<typeof deciderReplySchema>;

export const deciderPlanSchema = z.object({
  assessment: z.enum(["done", "incomplete", "awaiting_user", "refused"]),
  /** Checks to run before replying; empty when the reply does not depend on them. */
  workers: z.array(z.enum(["verify", "review"])),
  /** The reply when no checks are needed; null otherwise. */
  reply_now: deciderReplySchema.nullable().default(null),
  /** The agent's question, if it asked one. */
  question: z.string().default(""),
});
export type DeciderPlan = z.output<typeof deciderPlanSchema>;
export const DECIDER_PLAN_JSON_SCHEMA = z.toJSONSchema(deciderPlanSchema) as Record<string, unknown>;
export const DECIDER_REPLY_JSON_SCHEMA = z.toJSONSchema(deciderReplySchema) as Record<string, unknown>;

export const triggerSchema = z.enum(["root_only", "root_and_opt_in", "all"]).default("root_and_opt_in");

const policyV2Schema = z
  .object({
    version: z.literal(2),
    trigger: triggerSchema,
    /** A failed review or verify: report it, or send the findings back to the agent for up to max_rounds fixes. */
    on_fail: z
      .union([
        z.literal("report"),
        z
          .object({
            fix: z
              .object({ max_rounds: z.number().int().min(1).max(5).default(2) })
              .strict(),
          })
          .strict(),
      ])
      // The gate exists to let the agent loop until its work passes, so fixing is the default.
      .default({ fix: { max_rounds: 2 } }),
    /**
     * An INCONCLUSIVE check (no tests, or another gap the agent can close): report it, or treat it as FAIL.
     * Blocked permissions and ambiguous requests always go to you; missing environment is always reported.
     */
    on_inconclusive: z.enum(["report", "fail"]).default("report"),
    agents: agentsSchema,
    on_outcome: onOutcomeSchema.prefault({}),
  })
  .strict();
/** Task-level supervision of a version 3 policy (docs/completion-supervisor.md §15). */
export const supervisionSchema = z
  .object({
    /** Checks the plugin can run for the decider, in order. */
    checks: z
      .array(z.enum(["review", "verify"]))
      .min(1)
      .refine((checks) => new Set(checks).size === checks.length, "each check may appear once")
      .default(["verify", "review"]),
    /** Start the checks together with the decider when the task changed files, instead of after its plan. */
    speculative_checks: z.boolean().default(true),
    /** Grace period before the decider starts: a reply from you in that time cancels the round. */
    reply_delay_seconds: z.number().int().min(0).max(3600).default(60),
    budget: z
      .object({
        /** Messages the plugin may send to the agent for one task (replies and retries). */
        max_auto_sends: z.number().int().min(1).max(50).default(12),
        /** Automatic retries after crashes, network errors and rate limits (backoff 30s, 2min, 8min). */
        max_retries: z.number().int().min(0).max(3).default(3),
        /** Consecutive decision rounds that end on the same tree before the task goes to you. */
        max_no_progress_rounds: z.number().int().min(1).max(10).default(2),
        /** Minutes from the task's start after which nothing more is sent automatically. */
        max_minutes: z.number().int().min(1).max(1440).default(120),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});
export type Supervision = z.output<typeof supervisionSchema>;

/**
 * Version 3: a decider agent answers for the user after every turn that did work (docs/completion-supervisor.md).
 * Normalized to the version 2 shape the gate runs on, plus `supervision`; `agents.decider` becomes the answerer role.
 */
const policyV3Schema = z
  .object({
    version: z.literal(3),
    trigger: triggerSchema,
    supervision: supervisionSchema,
    agents: z
      .object({
        decider: agentSchema("answerer", 10, ".paseo/post-turn-gate/decider.md"),
        verifier: agentSchema("verifier", 30),
        reviewer: agentSchema("reviewer", 30),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .transform(({ trigger, supervision, agents }) => {
    const retry = supervision.budget.max_retries > 0 ? { retry: { max: supervision.budget.max_retries, delay_seconds: 30 } } : ("notify" as const);
    return {
      ...policyV2Schema.parse({
        version: 2,
        trigger,
        // Checks report to the decider, which writes the reply; the plugin never sends a template fix.
        on_fail: "report",
        on_inconclusive: "report",
        agents: { reviewer: agents.reviewer, verifier: agents.verifier, answerer: agents.decider },
        on_outcome: {
          done: supervision.checks,
          awaiting_user: { answer: { max: 10, delay_seconds: supervision.reply_delay_seconds } },
          crashed: retry,
          network: retry,
          rate_limited: retry,
        },
      }),
      version: 3 as const,
      supervision,
    };
  });

export type Policy = Omit<z.output<typeof policyV2Schema>, "version"> & { version: 2 | 3; supervision?: Supervision };

// Chosen by version rather than z.union, so an error names the offending field instead of "Invalid input".
const schemaFor = (json: unknown) => ((json as { version?: unknown } | null)?.version === 3 ? policyV3Schema : policyV2Schema);
export const policySchema = {
  parse: (json: unknown): Policy => schemaFor(json).parse(json) as Policy,
  safeParse: (json: unknown) => schemaFor(json).safeParse(json) as z.ZodSafeParseResult<Policy>,
};

/**
 * Validates a policy stored with a run or task (already normalized). False for one written by an older release.
 */
export function isStoredPolicy(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const { supervision, version, ...rest } = json as Record<string, unknown>;
  if (version === 3 && !supervisionSchema.safeParse(supervision).success) return false;
  if (version !== 2 && version !== 3) return false;
  return policyV2Schema.safeParse({ ...rest, version: 2 }).success;
}


/** The checks a finished task gets, in order; empty when `done` does not gate. */
export function gateChecks(policy: Policy): Check[] {
  const done = policy.on_outcome.done;
  return Array.isArray(done) ? done : [];
}

/** Fix rounds allowed after a failed gate; 0 means report only. */
export const maxFixRounds = (policy: Policy) => (policy.on_fail === "report" ? 0 : policy.on_fail.fix.max_rounds);

export const severitySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export const findingSchema = z.object({
  severity: severitySchema,
  title: z.string(),
  evidence: z.string(),
  suggested_fix: z.string(),
});
export type Finding = z.output<typeof findingSchema>;

/** Why a check could not decide; each reason has its own follow-up (docs/design.md §5). */
export const INCONCLUSIVE_REASONS = ["blocked_permission", "ambiguous_request", "no_test_infra", "env_missing", "other"] as const;
export type InconclusiveReason = (typeof INCONCLUSIVE_REASONS)[number];

export const verdictSchema = z.object({
  verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
  summary: z.string(),
  findings: z.array(findingSchema),
  /** Only for INCONCLUSIVE; null otherwise. Nullable rather than optional, so strict structured output accepts it. */
  inconclusive_reason: z.enum(INCONCLUSIVE_REASONS).nullable().default(null),
});
export type Verdict = z.output<typeof verdictSchema>;

// Passed as outputSchema; providers without structured output ignore it.
export const VERDICT_JSON_SCHEMA = z.toJSONSchema(verdictSchema) as Record<string, unknown>;

export const runStatusSchema = z.enum([
  "DISPATCHING",
  "REVIEWING",
  "FIXING",
  "PASSED",
  "INCONCLUSIVE",
  "FAILED",
  "NEEDS_HUMAN",
  "ERROR",
  "SUPERSEDED",
]);
export type RunStatus = z.output<typeof runStatusSchema>;

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "PASSED",
  "INCONCLUSIVE",
  "FAILED",
  "NEEDS_HUMAN",
  "ERROR",
  "SUPERSEDED",
];

export const CARD_KIND = "post-turn-gate";
export const CARD_VERSION = 1;

export const permissionCardSchema = z.object({
  agentId: z.string(),
  requestId: z.string(),
  kind: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  /** Why the plugin did not approve it automatically. */
  reason: z.string().nullable(),
  actions: z.array(z.object({ id: z.string(), label: z.string(), behavior: z.enum(["allow", "deny"]) })),
});
export type PermissionCard = z.output<typeof permissionCardSchema>;

export const cardSchema = z.object({
  status: runStatusSchema,
  action: z.enum(["verify", "review"]).nullable(),
  round: z.number().int(),
  maxFixRounds: z.number().int(),
  waiting: z.boolean(),
  permission: permissionCardSchema.nullable(),
  autoApproved: z.number().int(),
  summary: z.string().nullable(),
  findings: z.array(findingSchema),
  otherFindings: z.number().int(),
  childAgentId: z.string().nullable(),
  childTitle: z.string().nullable(),
  reviewerChanges: z.string().nullable(),
  error: z.string().nullable(),
  /** One row per configured check of the current round. Optional so cards written before it still render. */
  checks: z
    .array(
      z.object({
        check: z.enum(["review", "verify"]),
        state: z.enum(["pending", "running", "PASS", "FAIL", "INCONCLUSIVE", "skipped"]),
        summary: z.string().nullable(),
        /** What an INCONCLUSIVE check could not verify. */
        reason: z.enum(INCONCLUSIVE_REASONS).nullable().default(null),
      }),
    )
    .default([]),
  /** Informational, e.g. a role profile that does not exist yet. */
  note: z.string().nullable().default(null),
  /** A permission request of the checker that was denied (by you, or after permission_wait_minutes). */
  denied: z.string().nullable().default(null),
  /** The agent's reply to a fix request when it changed nothing and disagreed with the findings. */
  dispute: z.string().nullable().default(null),
  /** A config error card whose policy is valid again. */
  fixed: z.boolean().default(false),
});
export type CardData = z.output<typeof cardSchema>;

export const OUTCOME_CARD_KIND = "post-turn-gate-outcome";
export const OUTCOME_CARD_VERSION = 1;

export const outcomeCardSchema = z.object({
  chainId: z.string(),
  category: z.enum(CATEGORIES),
  state: z.enum(["notice", "retry_scheduled", "retrying", "answer_scheduled", "answering", "answered", "needs_user", "stopped", "resolved"]),
  message: z.string().nullable(),
  suggestion: z.string().nullable(),
  question: z.string().nullable(),
  answer: z.string().nullable(),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  nextRetryAt: z.number().nullable(),
  childAgentId: z.string().nullable(),
  canStopAnswering: z.boolean(),
  permission: permissionCardSchema.nullable(),
  /** Version 3 decision round: the card shows the decider instead of the answerer. */
  decider: z.boolean().default(false),
  /** Version 3: the checks' results the decider worked from. */
  checks: z.string().nullable().default(null),
});
export type OutcomeCard = z.output<typeof outcomeCardSchema>;

export const stopAnsweringRpc = defineRpc({
  name: "post-turn-gate.stop-answering",
  input: z.object({ chainId: z.string() }),
  output: z.object({ stopped: z.boolean() }),
});
