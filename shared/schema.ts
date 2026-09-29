import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Repository policy: <git toplevel>/.paseo/post-turn-gate.json
export const POLICY_PATH = ".paseo/post-turn-gate.json";

export const reviewerSchema = z
  .object({
    /** Paseo agent profile, matched by id first, then by exact name. */
    profile: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinking: z.string().min(1).optional(),
    features: z.record(z.string(), z.unknown()).optional(),
    /** Appended to the built-in role prompt; cannot replace the verdict contract. */
    instructions: z.string().max(4000).optional(),
    /** auto: approve routine tool use, escalate risky requests to the card; ask: every request goes to the user. */
    permissions: z.enum(["auto", "ask"]).default("auto"),
    timeout_minutes: z.number().int().min(1).max(240).optional(),
  })
  .strict();
export type ReviewerSpec = z.output<typeof reviewerSchema>;

// ---------- turn outcomes (docs/turn-outcomes.md) ----------

export const CATEGORIES = [
  "done",
  "awaiting_user",
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
        instructions: z.string().max(4000).optional(),
        /** Agent profile for the answerer; defaults to post-turn-gate-answerer when it exists, else the reviewer config. */
        profile: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
const passive = z.enum(["notify", "ignore"]);
const retryable = z.union([passive, retryActionSchema]);

// Retry is only accepted where waiting can help; quota and context exhaustion never recover by retrying.
export const onOutcomeSchema = z
  .object({
    done: z.enum(["gate", "notify", "ignore"]).default("gate"),
    awaiting_user: z.union([z.enum(["gate", "notify", "ignore"]), answerActionSchema]).default({ answer: { max: 3 } }),
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
  state: z.enum(["awaiting_user", "done", "incomplete"]),
  question: z.string().default(""),
  decision: z.enum(["answer", "escalate"]),
  answer: z.string().default(""),
  reason: z.string().default(""),
});
export type AnswerReply = z.output<typeof answerReplySchema>;
export const ANSWER_JSON_SCHEMA = z.toJSONSchema(answerReplySchema) as Record<string, unknown>;

export const policySchema = z
  .object({
    version: z.literal(1),
    action: z.enum(["none", "verify", "review"]),
    trigger: z.enum(["root_only", "root_and_opt_in", "all"]).default("root_and_opt_in"),
    review: z
      .object({
        on_fail: z.enum(["report", "fix"]).default("report"),
        max_fix_rounds: z.number().int().min(0).max(5).default(2),
      })
      .strict()
      .default({ on_fail: "report", max_fix_rounds: 2 }),
    reviewer: reviewerSchema.default({ permissions: "auto" }),
    on_outcome: onOutcomeSchema.prefault({}),
  })
  .strict();
export type Policy = z.output<typeof policySchema>;

export const severitySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export const findingSchema = z.object({
  severity: severitySchema,
  title: z.string(),
  evidence: z.string(),
  suggested_fix: z.string(),
});
export type Finding = z.output<typeof findingSchema>;

export const verdictSchema = z.object({
  verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
  summary: z.string(),
  findings: z.array(findingSchema),
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
});
export type CardData = z.output<typeof cardSchema>;

export const OUTCOME_CARD_KIND = "post-turn-gate-outcome";
export const OUTCOME_CARD_VERSION = 1;

export const outcomeCardSchema = z.object({
  chainId: z.string(),
  category: z.enum(CATEGORIES),
  state: z.enum(["notice", "retry_scheduled", "retrying", "answering", "answered", "needs_user", "stopped", "resolved"]),
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
});
export type OutcomeCard = z.output<typeof outcomeCardSchema>;

export const stopAnsweringRpc = defineRpc({
  name: "post-turn-gate.stop-answering",
  input: z.object({ chainId: z.string() }),
  output: z.object({ stopped: z.boolean() }),
});
