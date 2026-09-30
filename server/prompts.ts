import type { ZodType, output } from "zod";
import type { AnswerReply, DeciderPlan, DeciderReply, Verdict } from "../shared/schema.ts";
import { answerReplySchema, deciderPlanSchema, deciderReplySchema, verdictSchema } from "../shared/schema.ts";

const ROLE = {
  verify: `You are an independent VERIFIER. Answer one question: does the change fully deliver the original request?
Map every requirement in the request to evidence in the change. Build and run the relevant tests or commands and
observe the behavior. A requirement without evidence is a finding.`,
  review: `You are an independent code REVIEWER. Answer one question: is the change correct and maintainable?
Look for correctness bugs, regressions, missing error handling, security problems, missing or weak tests,
and maintainability issues. Report only real, evidenced problems.`,
} as const;

// The user reads these texts on the card, so they follow the request's language; a policy instruction can override it.
// Real kiro runs answered English requests in Spanish and Chinese when told "the language of the request", so the
// rule names the language when it can tell.
const LANGUAGE_BASE = `Keep JSON keys, enum values, code, paths and commands as they are. Additional instructions naming
  another language win.`;

/** Labels and wrappers the plugin adds to request text; they are not the user's words. */
const PLUGIN_LABELS = /Earlier messages from the user in this conversation \(context only\):|Request:|Follow-up from the user:|Answered on the user's behalf:|\[post-turn gate answered on your behalf\]|\[… \d+ characters omitted …\]/g;

/**
 * The language the user wrote in, when a cheap check can tell; null otherwise.
 * ponytail: script ranges plus a short English word list; other Latin-script languages get the generic rule.
 */
export function requestLanguage(requestText: string): string | null {
  const text = requestText.replace(PLUGIN_LABELS, " ").replace(/`[^`]*`/g, " ");
  const scripts: Array<[string, RegExp]> = [
    ["Japanese", /[\u3040-\u30ff]/g],
    ["Korean", /[\uac00-\ud7af]/g],
    ["Chinese", /[\u4e00-\u9fff]/g],
    ["Russian", /[\u0400-\u04ff]/g],
  ];
  for (const [name, pattern] of scripts) if ((text.match(pattern)?.length ?? 0) >= 2) return name;
  const english = text.match(/\b(the|and|to|of|a|an|in|is|it|that|for|with|when|should|add|fix|make|write|me|you|this|please)\b/gi);
  return (english?.length ?? 0) >= 2 ? "English" : null;
}

export function languageRule(requestText: string): string {
  const language = requestLanguage(requestText);
  const target = language
    ? `in ${language}, the language the user wrote the request in`
    : "in the language the user wrote the request in (the text between <<<REQUEST and REQUEST>>>), not the language of these instructions";
  return `Write the free-text JSON values (summary, question, answer, message, reason, title, evidence, suggested_fix)
  ${target}. ${LANGUAGE_BASE}`;
}

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
- inconclusive_reason is null unless the verdict is INCONCLUSIVE; then say why:
  "blocked_permission" (a command or file you needed was denied or not answered), "ambiguous_request" (the
  request does not say what is required), "no_test_infra" (the change has no tests or runnable check that could
  show it works), "env_missing" (credentials, services or tools this machine does not have), or "other".
- ${languageRule(input.requestText)}

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape:
{"verdict":"PASS|FAIL|INCONCLUSIVE","summary":"...","findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","title":"...","evidence":"...","suggested_fix":"..."}],"inconclusive_reason":null}`;
}

/** Sent to a checker whose permission request was denied and whose turn ended without a verdict. */
export function buildNudgePrompt(denied: string): string {
  return `The permission request "${denied}" was denied. Do not retry it or work around it.
Reply now with the verdict JSON based on the evidence you already have. If that is not enough to decide, use
verdict INCONCLUSIVE with inconclusive_reason "blocked_permission" and say in the summary what you could not check.`;
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
  const task =
    verdict.verdict === "INCONCLUSIVE"
      ? "The check could not verify the change (see the summary). Add what is missing, such as tests or a runnable check, then stop."
      : "Fix the CRITICAL and HIGH findings, then stop.";
  return `The post-turn gate reviewed your last change and it did not pass (fix round ${round} of ${maxFixRounds}).

Summary: ${verdict.summary}

Findings:
${findings || "(none listed)"}

${task} The change will be reviewed again automatically. If you believe a finding is wrong, change nothing and
explain why in your reply.${
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
  const parsed = parseJsonReply(text, verdictSchema);
  if (!parsed) return null;
  const blocking = parsed.findings.some((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH");
  const verdict = blocking ? "FAIL" : parsed.verdict;
  return { ...parsed, verdict, inconclusive_reason: verdict === "INCONCLUSIVE" ? parsed.inconclusive_reason : null };
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
"Go with your recommendation." Keep the answer short and actionable, and put any command in backticks. Choose "escalate" when:
- it is a product or business trade-off the request does not settle (several reasonable options);
- it involves deleting data, force-pushing, publishing, deploying, spending money, changing permissions,
  credentials or secrets, or sending anything outside this machine;
- it needs information only the user has (accounts, personal preferences, passwords, external context);
- it would expand the work beyond what the user asked for (e.g. the user asked for analysis, the agent
  offers to implement);
- you are not confident.
For "incomplete", "refused" and "done", use decision "answer" with an empty answer.
${languageRule(input.requestText)}

Reply with ONLY one JSON object, no prose and no code fence:
{"state":"awaiting_user|incomplete|refused|done","question":"<the question, verbatim or summarized>","decision":"answer|escalate","answer":"<reply to send to the agent>","reason":"<one sentence>"}`;
}

// ---------- decider (version 3) ----------

export function parseDeciderPlan(text: string): DeciderPlan | null {
  return parseJsonReply(text, deciderPlanSchema);
}

export function parseDeciderReply(text: string): DeciderReply | null {
  return parseJsonReply(text, deciderReplySchema);
}

const ESCALATE_RULES = `Hand the decision to the user (kind "escalate") instead of replying when:
- it is a product or business trade-off the request does not settle (several reasonable options);
- it involves deleting data, force-pushing, publishing, deploying, spending money, changing permissions,
  credentials or secrets, or sending anything outside this machine;
- it needs information only the user has (accounts, personal preferences, passwords, external context);
- it would expand the work beyond what the user asked for;
- the agent disputes a check's finding and you would accept its argument (only the user may overrule a check);
- you are not confident.`;

const REPLY_RULES = `Reply kinds:
- "send": one message for the agent that covers everything it needs now: the answer to its question, the
  findings to fix with what to change, missing tests or evidence to add, or "Continue." when it stopped early.
  Put commands in backticks. Tell it to stop when done.
- "done": the request is fully delivered and nothing is left to ask or fix.
- "escalate": see the rules above; "question" says what the user must decide, "reason" why.`;

/**
 * The decider stands in for the user after a turn (docs/completion-supervisor.md §5). Phase "plan" decides what
 * the next step depends on; phase "merge" writes the reply from the checks' results.
 */
export function buildDeciderPrompt(input: {
  phase: "plan" | "merge";
  requestText: string;
  repoRoot: string;
  baseTree: string;
  endTree: string;
  agentReply: string;
  signal?: string | null;
  previousQuestion: string | null;
  instructions?: string;
  /** What the plugin does about checks this round (running, reused, none). */
  checks: string;
  /** merge: the checks' results. */
  results?: string;
  /** merge: the plan from the first phase. */
  plan?: DeciderPlan | null;
  sendsLeft: number;
  concurrentAgents?: readonly string[];
}): string {
  const extra = input.instructions?.trim()
    ? `\nAdditional rules from the repository policy:\n<<<RULES\n${input.instructions.trim()}\nRULES>>>\n`
    : "";
  const previous = input.previousQuestion
    ? `\nYou already answered this earlier question in the same task: ${JSON.stringify(input.previousQuestion)}\nIf the agent is asking the same thing again, escalate.\n`
    : "";
  const hint = input.signal ? `\nThe plugin noticed a signal in the reply: ${input.signal}.\n` : "";
  const others = input.concurrentAgents?.length
    ? `\nOther agents (${input.concurrentAgents.join(", ")}) changed this repository at the same time; the diff may include their work. Ask the agent to fix only its own changes.\n`
    : "";
  const head = `You supervise a coding agent on behalf of its user, so the work continues without the user until the
request is done. The agent just ended a turn. You decide the next step and write the reply; independent
checkers (verify: does the change deliver the request; review: is it correct and maintainable) give you
evidence. You cannot overrule a check: a FAIL stands until the agent's next change passes it.
${extra}${previous}${hint}${others}
Repository: ${input.repoRoot}
Work done so far in this task: git -C ${JSON.stringify(input.repoRoot)} diff ${input.baseTree} ${input.endTree}
You may read files and run read-only commands. Do not modify the repository.
Automatic messages left for this task: ${input.sendsLeft}.

The user's request:
<<<REQUEST
${input.requestText}
REQUEST>>>

The agent's last message:
<<<AGENT
${input.agentReply}
AGENT>>>

Checks this round: ${input.checks}
`;
  if (input.phase === "plan") {
    return `${head}
Assess the agent's state: "done" (it says it finished), "incomplete" (it stopped early: cut off, "next I will…",
open todos, or its turn failed), "awaiting_user" (it asks a question or for a decision), "refused" (it declined
the request). When the turn failed, reply "Continue from where you left off." if another try can help, and
escalate when it needs something only the user can fix (credentials, a missing service, a broken environment).

Plan the next step:
- "workers": the checks your reply depends on. Keep the running checks when the agent says it is done or asks
  something whose answer depends on whether the work is correct. Use [] when the reply does not depend on them
  (it stopped early, or asks something the request already settles).
- "reply_now": with workers [], the reply (see below); otherwise null.

${ESCALATE_RULES}

${REPLY_RULES}
${languageRule(input.requestText)}

Reply with ONLY one JSON object, no prose and no code fence:
{"assessment":"done|incomplete|awaiting_user|refused","question":"<the agent's question, if any>","workers":["verify","review"],"reply_now":null}`;
  }
  return `${head}
Your plan: ${JSON.stringify(input.plan ?? null)}

Results of the checks:
<<<RESULTS
${input.results ?? "(none)"}
RESULTS>>>

Write the reply. A FAIL or an INCONCLUSIVE check the agent can close (missing tests, missing evidence) means the
work is not done: send what to fix or add, together with the answer to the agent's question if it asked one.
"done" is only right when every check passed.

${ESCALATE_RULES}

${REPLY_RULES}
${languageRule(input.requestText)}

Reply with ONLY one JSON object, no prose and no code fence:
{"kind":"send|done|escalate","message":"<the message for the agent>","answers_question":false,"question":"","reason":"<one sentence>"}`;
}
