import type { Verdict } from "../shared/schema.ts";
import { verdictSchema } from "../shared/schema.ts";

const ROLE = {
  verify: `You are an independent VERIFIER. Answer one question: does the change fully deliver the original request?
Map every requirement in the request to evidence in the change. Build and run the relevant tests or commands and
observe the behavior. A requirement without evidence is a finding.`,
  review: `You are an independent code REVIEWER. Answer one question: is the change correct and maintainable?
Look for correctness bugs, regressions, missing error handling, security problems, missing or weak tests,
and maintainability issues. Report only real, evidenced problems.`,
} as const;

export function buildGatePrompt(input: {
  action: "verify" | "review";
  requestText: string;
  repoRoot: string;
  baseTree: string;
  endTree: string;
}): string {
  return `${ROLE[input.action]}

Repository: ${input.repoRoot}
Inspect the change with: git -C ${JSON.stringify(input.repoRoot)} diff ${input.baseTree} ${input.endTree}
(The two shas are tree snapshots of the working directory before and after the change, including uncommitted files.)

Original request:
<<<REQUEST
${input.requestText}
REQUEST>>>

Rules:
- Do not modify files in the repository. Your job is to judge, not to fix.
- Severity: CRITICAL/HIGH block acceptance; MEDIUM/LOW do not.
- verdict is FAIL when any CRITICAL or HIGH finding exists, PASS when none exists,
  INCONCLUSIVE only when you could not gather enough evidence.

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape:
{"verdict":"PASS|FAIL|INCONCLUSIVE","summary":"...","findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","title":"...","evidence":"...","suggested_fix":"..."}]}`;
}

export function buildFixPrompt(verdict: Verdict, round: number, maxFixRounds: number): string {
  const findings = verdict.findings
    .map(
      (finding, index) =>
        `${index + 1}. [${finding.severity}] ${finding.title}\n   Evidence: ${finding.evidence}\n   Suggested fix: ${finding.suggested_fix}`,
    )
    .join("\n");
  return `The post-turn gate reviewed your last change and it did not pass (fix round ${round} of ${maxFixRounds}).

Summary: ${verdict.summary}

Findings:
${findings || "(none listed)"}

Fix the CRITICAL and HIGH findings, then stop. The change will be reviewed again automatically.`;
}

/** Concatenated assistant text after the latest user message (providers may split one reply into chunks). */
export function latestAssistantText(
  timeline: readonly { type: string; text?: unknown }[],
): string {
  let output = "";
  for (const item of timeline) {
    if (item.type === "user_message") output = "";
    else if (item.type === "assistant_message" && typeof item.text === "string") output += item.text;
  }
  return output;
}

/** Parses a verdict from reply text; null when nothing valid is found (never treated as PASS). */
export function parseVerdict(text: string): Verdict | null {
  const candidates = [text.trim()];
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1].trim());
  candidates.push(...fences.reverse());
  const lastBrace = text.lastIndexOf("}");
  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = verdictSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
