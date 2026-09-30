import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Repository policy: <git toplevel>/.paseo/post-turn-gate.json
export const POLICY_PATH = ".paseo/post-turn-gate.json";

export type Role = "reviewer" | "verifier" | "decider";
export type Check = "review" | "verify";
export const ROLE_OF: Record<Check, Role> = { review: "reviewer", verify: "verifier" };
/** Optional profile ids created by `npm run profiles`. */
export const ROLE_PROFILE: Record<Role, string> = {
  reviewer: "post-turn-gate-reviewer",
  verifier: "post-turn-gate-verifier",
  decider: "post-turn-gate-decider",
};

/** Maximum length of a role's rules (file plus inline instructions). */
export const INSTRUCTIONS_LIMIT = 20000;
export const defaultInstructionsFile = (role: Role) => `.paseo/post-turn-gate/${role}.md`;

function agentSchema(role: Role, timeoutMinutes: number) {
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
      instructions_file: z.string().min(1).nullable().default(defaultInstructionsFile(role)),
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
    decider: agentSchema("decider", 10),
    verifier: agentSchema("verifier", 30),
    reviewer: agentSchema("reviewer", 30),
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

// ---------- decider ----------

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

// ---------- policy ----------

export const triggerSchema = z.enum(["root_only", "root_and_opt_in", "all"]).default("root_and_opt_in");

/** Task-level supervision (docs/completion-supervisor.md §15). */
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

/** A decider agent answers for the user after every turn that did work (docs/completion-supervisor.md). */
export const policySchema = z
  .object({
    version: z.literal(3),
    trigger: triggerSchema,
    supervision: supervisionSchema,
    agents: agentsSchema,
  })
  .strict();
export type Policy = z.output<typeof policySchema>;

/** The checks a task gets, in order. */
export const gateChecks = (policy: Policy): Check[] => policy.supervision.checks;

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

/** Configuration and baseline errors; decision rounds use the outcome card below. */
export const cardSchema = z.object({
  status: z.literal("ERROR"),
  error: z.string(),
  note: z.string().nullable(),
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
  /** A decision round rather than a mechanical retry. */
  decider: z.boolean().default(false),
  /** The checks' results the decider worked from. */
  checks: z.string().nullable().default(null),
  /** Auto-answering was stopped for the task; the card offers to resume it. */
  canResume: z.boolean().default(false),
});
export type OutcomeCard = z.output<typeof outcomeCardSchema>;

export const stopAnsweringRpc = defineRpc({
  name: "post-turn-gate.stop-answering",
  /** resume: turn auto-answering back on for the task (the card's Resume button). */
  input: z.object({ chainId: z.string(), resume: z.boolean().optional() }),
  output: z.object({ stopped: z.boolean() }),
});
