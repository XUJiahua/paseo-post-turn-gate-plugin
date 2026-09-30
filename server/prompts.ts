import type { ZodType, output } from "zod";
import type { AnswerReply, Verdict } from "../shared/schema.ts";
import { answerReplySchema, verdictSchema } from "../shared/schema.ts";

const ROLE = {
  verify: `You are an independent VERIFIER. Answer one question: does the change fully deliver the original request?
Map every requirement in the request to evidence in the change. Build and run the relevant tests or commands and
observe the behavior. A requirement without evidence is a finding.`,
  review: `You are an independent code REVIEWER. Answer one question: is the change correct and maintainable?
Look for correctness bugs, regressions, missing error handling, security problems, missing or weak tests,
and maintainability issues. Report only real, evidenced problems.`,
} as const;

// The user reads these texts on the card, so they follow the request's language; a policy instruction can override it.
const LANGUAGE_RULE = `Write the free-text JSON values (summary, question, answer, reason, title, evidence, suggested_fix) in the
  language of the original request, unless the additional instructions name another language. Keep JSON keys,
  enum values, code, paths and commands as they are.`;

export function buildGatePrompt(input: {
  action: "verify" | "review";
  requestText: string;
  repoRoot: string;
  baseTree: string;
  endTree: string;
  instructions?: string;
  concurrentAgents?: readonly string[];
}): string {
  const concurrent = input.concurrentAgents?.length
    ? `\nOther agents (${input.concurrentAgents.join(", ")}) were working in this repository at the same time, so the diff
may include their changes and the working tree may change while you check. Judge only changes that belong to the
request; say in the summary when build or test results may have been disturbed by concurrent work.\n`
    : "";
  const extra = input.instructions?.trim()
    ? `\nAdditional instructions from the repository policy:\n<<<INSTRUCTIONS\n${input.instructions.trim()}\nINSTRUCTIONS>>>\n`
    : "";
  return `${ROLE[input.action]}
${extra}
Repository: ${input.repoRoot}
Inspect the change with: git -C ${JSON.stringify(input.repoRoot)} diff ${input.baseTree} ${input.endTree}
(The two shas are tree snapshots of the working directory before and after the change, including uncommitted files.)
${concurrent}
Original request:
<<<REQUEST
${input.requestText}
REQUEST>>>

Rules:
- Do not modify files in the repository. Your job is to judge, not to fix.
- Severity: CRITICAL/HIGH block acceptance; MEDIUM/LOW do not.
- verdict is FAIL when any CRITICAL or HIGH finding exists, PASS when none exists,
  INCONCLUSIVE only when you could not gather enough evidence.
- ${LANGUAGE_RULE}

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape:
{"verdict":"PASS|FAIL|INCONCLUSIVE","summary":"...","findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","title":"...","evidence":"...","suggested_fix":"..."}]}`;
}

export function buildFixPrompt(
  verdict: Verdict,
  round: number,
  maxFixRounds: number,
  concurrentAgents: readonly string[] = [],
): string {
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

Fix the CRITICAL and HIGH findings, then stop. The change will be reviewed again automatically.${
    concurrentAgents.length
      ? `\n\nOther agents were changing this repository at the same time. Fix only findings caused by your own changes;
for a finding in someone else's work, say so instead of changing their code.`
      : ""
  }`;
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

/** Finds complete top-level JSON objects without being confused by braces inside strings. */
function jsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      objects.push(text.slice(start, index + 1));
      start = -1;
    }
  }
  return objects;
}

/** Parses the final JSON reply (raw, fenced, or embedded in prose); null when it does not validate. */
export function parseJsonReply<Schema extends ZodType>(text: string, schema: Schema): output<Schema> | null {
  const candidates = [text.trim()];
  const lastFence = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].at(-1)?.[1].trim();
  if (lastFence) candidates.push(lastFence);
  const lastObject = jsonObjects(text).at(-1);
  if (lastObject) candidates.push(lastObject);
  for (const candidate of candidates) {
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Never treated as PASS when null. A CRITICAL/HIGH finding makes the verdict FAIL whatever the model
 * wrote, as the prompt's rule says; a blocking finding under PASS would otherwise slip through.
 */
export function parseVerdict(text: string): Verdict | null {
  const verdict = parseJsonReply(text, verdictSchema);
  if (!verdict || verdict.verdict === "FAIL") return verdict;
  const blocking = verdict.findings.some((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH");
  return blocking ? { ...verdict, verdict: "FAIL" } : verdict;
}

export function parseAnswer(text: string): AnswerReply | null {
  return parseJsonReply(text, answerReplySchema);
}

export const ANSWER_PREFIX = "[post-turn gate answered on your behalf]";

export function buildAnswerPrompt(input: {
  requestText: string;
  repoRoot: string;
  baseTree: string;
  endTree: string;
  agentReply: string;
  previousQuestion: string | null;
  signal?: string | null;
  instructions?: string;
}): string {
  const hints: Record<string, string> = {
    truncated: "The reply ends inside an unclosed code block; it may have been cut off.",
    tool_last: "The turn ended right after a tool call, without a final reply; the agent may have been stopped by a turn limit.",
    todo_pending: "The agent's todo list still has unfinished items.",
    refused: "The reply starts like a refusal.",
    question: "The reply looks like it asks the user something.",
  };
  const hint = input.signal && hints[input.signal] ? `\nThe plugin noticed: ${hints[input.signal]}\n` : "";
  const extra = input.instructions?.trim()
    ? `\nAdditional rules from the repository policy:\n<<<RULES\n${input.instructions.trim()}\nRULES>>>\n`
    : "";
  const previous = input.previousQuestion
    ? `\nYou already answered this earlier question in the same task: ${JSON.stringify(input.previousQuestion)}\nIf the agent is asking the same thing again, escalate.\n`
    : "";
  return `You stand in for the user of a coding agent. The agent just stopped its turn. Decide whether it is
waiting for the user, and if so answer on the user's behalf when that is safe, so the work can continue
without a human.
${extra}${previous}${hint}
Repository: ${input.repoRoot}
Work done so far in this task: git -C ${JSON.stringify(input.repoRoot)} diff ${input.baseTree} ${input.endTree}
You may read files and run read-only commands to inform the answer. Do not modify the repository.

Original request from the user:
<<<REQUEST
${input.requestText}
REQUEST>>>

The agent's last message:
<<<AGENT
${input.agentReply}
AGENT>>>

Classify the agent's state:
- "awaiting_user": it asks the user a question or for a decision and stopped.
- "incomplete": it did not ask anything but stopped before finishing (e.g. "next I will …", a reply cut off
  mid-way, unfinished todo items, or it stopped right after a tool call).
- "refused": it declined to do the request (a policy or safety refusal), so there is nothing to answer.
- "done": it finished the request and is not waiting for anything.

For "awaiting_user", choose decision "answer" only when the request, the repository, or common engineering
practice clearly determines the answer. If the agent recommends one option and that option is reversible,
stays inside this repository, and stays within the scope of the original request, answer
"Go with your recommendation." Keep the answer short and actionable. Choose "escalate" when:
- it is a product or business trade-off the request does not settle (several reasonable options);
- it involves deleting data, force-pushing, publishing, deploying, spending money, changing permissions,
  credentials or secrets, or sending anything outside this machine;
- it needs information only the user has (accounts, personal preferences, passwords, external context);
- it would expand the work beyond what the user asked for (e.g. the user asked for analysis, the agent
  offers to implement);
- you are not confident.
For "incomplete", "refused" and "done", use decision "answer" with an empty answer.
${LANGUAGE_RULE}

Reply with ONLY one JSON object, no prose and no code fence:
{"state":"awaiting_user|incomplete|refused|done","question":"<the question, verbatim or summarized>","decision":"answer|escalate","answer":"<reply to send to the agent>","reason":"<one sentence>"}`;
}
