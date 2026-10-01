// Classifies why an agent turn ended (docs/turn-outcomes.md). Pure functions, no I/O.
import type { Category } from "../shared/schema.ts";

export interface OutcomeLike {
  kind: "completed" | "failed" | "canceled";
  error?: { message: string; code?: string };
  reason?: string;
}

export interface TurnItem {
  type: string;
  text?: unknown;
}

/** Items after the latest user message: what this turn produced. */
export function currentTurnItems<Item extends TurnItem>(timeline: readonly Item[]): Item[] {
  let start = 0;
  timeline.forEach((item, index) => {
    if (item.type === "user_message") start = index + 1;
  });
  return timeline.slice(start);
}

const SYSTEM_ERROR = "[System Error]";

function assistantTexts(items: readonly TurnItem[]): string[] {
  return items
    .filter((item) => item.type === "assistant_message" && typeof item.text === "string")
    .map((item) => item.text as string);
}

/** The agent's reply without Paseo's synthetic error messages. */
export function replyText(items: readonly TurnItem[]): string {
  return assistantTexts(items)
    .filter((text) => !text.startsWith(SYSTEM_ERROR))
    .join("");
}

// ponytail: provider error texts, not structured codes; a reworded message falls through to
// `error` (decider, no mechanical retry). Upgrade path: structured outcome fields from Paseo.
const FAILURE_PATTERNS: ReadonlyArray<[Exclude<Category, "done" | "awaiting_user" | "refused" | "user_canceled" | "replaced" | "error">, RegExp]> = [
  ["crashed", /exited unexpectedly|app-server exited|\bsigkill\b|\bsigterm\b|spawn \S+ enoent/],
  ["context_exhausted", /context (limit|window|length)|too many tokens|maximum context|start a new session/],
  // Checked before rate_limited: "quota exceeded, please wait" must never be retried.
  ["quota_exhausted", /(daily|monthly) (usage )?limit|hit your (usage )?limit|quota exceeded|out of credits|insufficient (credits|balance|quota)|billing/],
  // A bare 429 is ambiguous: some providers use it for exhausted daily quota.
  ["rate_limited", /too many requests|throttl|rate.?limit|overloaded/],
  ["network", /dispatch failure|econn\w*|etimedout|enotfound|eai_again|socket hang up|network|timed? ?out|\b50[234]\b/],
];

export interface Classification {
  category: Category;
  /** Short human-readable cause, e.g. the provider error text. */
  detail: string | null;
}

export function classify(input: {
  outcome: OutcomeLike;
  turnItems: readonly TurnItem[];
  /** Agent status right after the turn ended; "running" means a newer turn already started. */
  statusAtEnd: string | null;
}): Classification {
  const { outcome, turnItems } = input;
  if (outcome.kind === "canceled") {
    return {
      category: input.statusAtEnd === "running" ? "replaced" : "user_canceled",
      detail: outcome.reason ?? null,
    };
  }
  if (outcome.kind === "failed") {
    const systemErrors = assistantTexts(turnItems).filter((text) => text.startsWith(SYSTEM_ERROR));
    const haystack = [outcome.error?.message ?? "", ...systemErrors].join("\n").toLowerCase();
    const detail = (systemErrors.at(-1)?.slice(SYSTEM_ERROR.length).trim() || outcome.error?.message || "").slice(0, 600);
    for (const [category, pattern] of FAILURE_PATTERNS) {
      if (pattern.test(haystack)) return { category, detail: detail || null };
    }
    return { category: "error", detail: detail || null };
  }
  const signal = stopSignal(turnItems);
  return signal ? { category: "awaiting_user", detail: signal } : { category: "done", detail: null };
}

export type StopSignal = "question" | "truncated" | "tool_last" | "todo_pending" | "refused" | "missing_reply";

const REFUSAL =
  /^(i('m| am) sorry[,.]?\s*(but\s*)?)?(i\s+)?(can(no|')?t|am unable to|won't|will not|must decline to)\s+(help|assist|do|comply|complete|continue|provide)|^抱歉[，,]?\s*我(无法|不能)|^我(无法|不能)(帮|协助|完成|提供)/i;

/**
 * Cheap, high-recall pre-screen for "the turn may not really be finished": a question, a reply cut off
 * mid code block, a turn that ended right after a tool call, unfinished todos, a refusal, or no reply.
 * A hit only means the semantic check (decider agent) runs; a miss means `done`.
 * Deliberately not a signal: a reply without final punctuation (too common in normal replies).
 */
export function stopSignal(items: readonly (TurnItem & { items?: unknown })[]): StopSignal | null {
  const reply = replyText(items);
  const trimmed = reply.trim();
  if (!trimmed) return "missing_reply";
  if (REFUSAL.test(trimmed.replace(/[*_`>#]+/g, "").trim())) return "refused";
  if (((trimmed.match(/```/g) ?? []).length % 2) === 1) return "truncated";
  const last = [...items].reverse().find((item) => item.type === "tool_call" || item.type === "assistant_message");
  if (last?.type === "tool_call") return "tool_last";
  const todo = [...items].reverse().find((item) => item.type === "todo");
  const todoItems = Array.isArray(todo?.items) ? (todo.items as Array<{ completed?: boolean; status?: string }>) : [];
  if (todoItems.some((entry) => entry.completed === false && entry.status !== "completed")) return "todo_pending";
  return looksLikeQuestion(reply) && !isCourtesyOffer(reply) ? "question" : null;
}

// Opening of a closing offer: "Let me know if …", "Want me to also …", "需要我…吗", "如有问题…".
const OFFER =
  /^(let me know (if|whether)|is there anything else|anything else\b|if you('d| would)? (like|want|need|prefer)|(would|do) you (like|want) me to|want me to|shall i (also|go ahead)|should i also|happy to|feel free|i can also|需要我|要不要我|还需要|如有|如果(你|您)?(需要|想|希望|有)|有(任何|其他)?问题|随时)/i;
// A choice between options is a real question even when phrased as an offer.
const CHOICE = /\bor\b|\bwhich\b|还是|哪/i;

/**
 * A finished report that ends with one closing offer ("Implemented X. Let me know if you need anything
 * else."). Treated as done: a miss only costs a review of a half-finished task (whose FAIL tells the agent to
 * continue), while a false question costs an decider run that may even accept the offer.
 */
export function isCourtesyOffer(reply: string): boolean {
  const text = reply.replace(/```[\s\S]*?```/g, " ").replace(/[*_`>#]+/g, "").trim();
  const sentences = text.split(/(?<=[.!?。！？])\s*/).map((sentence) => sentence.trim()).filter(Boolean);
  const last = sentences.at(-1) ?? "";
  // The offer may follow a clause of the same sentence: "我先按 Python 写了，如果你想换语言请告诉我。"
  const clauses = last.split(/[，,;；]\s*/);
  const at = clauses.findIndex((clause) => OFFER.test(clause.trim()));
  if (at === -1 || last.length > 200 || CHOICE.test(clauses.slice(at).join(" "))) return false;
  const before = [...sentences.slice(0, -1), ...clauses.slice(0, at)].join(" ").trim();
  return before.length >= 8 && !looksLikeQuestion(before);
}

const ASKING =
  /\b(should i|shall i|would you like|do you want|which (one|option)|let me know|please confirm|before i (proceed|continue)|waiting for (your|you))\b|要不要|是否需要|需要我|请确认|请告诉我|你希望|选哪个/i;

/**
 * Cheap, high-recall pre-screen for "the agent stopped to ask the user something".
 * A hit only means the semantic check (decider agent) runs; a miss means `done`.
 */
export function looksLikeQuestion(reply: string): boolean {
  const text = reply
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`>#]+/g, "")
    .trim();
  if (!text) return false;
  if (/[?？]\s*$/.test(text)) return true;
  // Only the closing sentence asks. An asking phrase earlier, or inside quotes, is usually reported speech
  // ("选方案、要不要继续这两类提问"), not a question to the user.
  const lastLine = text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  const lastSentence = lastLine
    .replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」/g, " ")
    .split(/(?<=[.!?。！？])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .at(-1);
  if (lastSentence && ASKING.test(lastSentence)) return true;
  // Ends with an option list of at least two items ("1. …\n2. …", "A) …\nB) …") introduced as a choice,
  // not a summary like "Steps taken:".
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const trailing = [];
  for (let index = lines.length - 1; index >= 0 && /^(\d+[.)]|[A-Za-z][.)]|[-•])\s+\S/.test(lines[index]); index -= 1) {
    trailing.push(lines[index]);
  }
  const intro = lines[lines.length - 1 - trailing.length] ?? "";
  return trailing.length >= 2 && /[?？]\s*$|\b(options?|choose|prefer|which|either)\b|方案|选择|哪/i.test(intro);
}

export const SUGGESTIONS: Record<Category, string | null> = {
  done: null,
  awaiting_user: "Reply in the chat to continue; the task picks up from your answer.",
  refused: "The agent declined the request. Rephrase it or adjust the task, then continue.",
  user_canceled: null,
  replaced: null,
  crashed: "The agent process exited. Send a message to continue; Paseo restarts the session.",
  network: "Network error. Send a message to continue when the connection is back.",
  rate_limited: "The provider is throttling requests. Wait a little, then send a message to continue.",
  quota_exhausted: "The provider quota or credits are used up. Top up or switch provider, then continue.",
  context_exhausted: "The conversation ran out of context. Start a new agent or compact the context.",
  error: "The turn failed. Check the error and decide how to continue.",
};

/** Character-bigram Jaccard similarity; works for CJK text without word boundaries. */
export function similarity(left: string, right: string): number {
  const grams = (text: string) => {
    const clean = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const set = new Set<string>();
    for (let index = 0; index < clean.length - 1; index += 1) set.add(clean.slice(index, index + 2));
    return set;
  };
  const a = grams(left);
  const b = grams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}
