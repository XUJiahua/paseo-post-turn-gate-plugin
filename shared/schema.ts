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
    timeout_minutes: z.number().int().min(1).max(240).optional(),
  })
  .strict();
export type ReviewerSpec = z.output<typeof reviewerSchema>;

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
    reviewer: reviewerSchema.default({}),
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
  summary: z.string().nullable(),
  findings: z.array(findingSchema),
  otherFindings: z.number().int(),
  childAgentId: z.string().nullable(),
  childTitle: z.string().nullable(),
  reviewerChanges: z.string().nullable(),
  error: z.string().nullable(),
});
export type CardData = z.output<typeof cardSchema>;
