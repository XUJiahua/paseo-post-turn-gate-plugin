import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classify, currentTurnItems, looksLikeQuestion, similarity } from "./outcome.ts";
import { answerRisk } from "./permissions.ts";
import { policySchema } from "../shared/schema.ts";

const user = (text: string) => ({ type: "user_message", text });
const says = (text: string) => ({ type: "assistant_message", text });
const tool = (status: string) => ({ type: "tool_call", status });

const turn = (outcome: Parameters<typeof classify>[0]["outcome"], items: object[], statusAtEnd = "idle") =>
  classify({ outcome, turnItems: currentTurnItems([user("earlier"), says("old reply?"), user("now"), ...items] as never), statusAtEnd });

describe("classify: real kiro-cli 2.25 payloads (docs/turn-outcomes.md §1)", () => {
  test("E1 done", () => {
    assert.equal(turn({ kind: "completed" }, [says("ALL DONE")]).category, "done");
  });
  test("E2 a question is awaiting_user; the previous turn's question does not count", () => {
    assert.equal(turn({ kind: "completed" }, [says("Which programming language would you like me to use for the script?")]).category, "awaiting_user");
  });
  test("E3 user stop vs E4 replaced by a new message", () => {
    const items = [says("I'll run that command for you."), tool("canceled")];
    assert.equal(turn({ kind: "canceled", reason: "Interrupted" }, items, "idle").category, "user_canceled");
    assert.equal(turn({ kind: "canceled", reason: "Interrupted" }, items, "running").category, "replaced");
  });
  test("E5 crash", () => {
    const result = turn(
      { kind: "failed", error: { message: "ACP agent exited unexpectedly (null, SIGKILL)" } },
      [{ type: "reasoning" }, tool("canceled"), says("[System Error] ACP agent exited unexpectedly (null, SIGKILL)")],
      "error",
    );
    assert.deepEqual(result, { category: "crashed", detail: "ACP agent exited unexpectedly (null, SIGKILL)" });
  });
  test("E6 network: the cause is only in the [System Error] message", () => {
    const result = turn(
      { kind: "failed", error: { message: "Internal error", code: "-32603" } },
      [says('[System Error] Internal error\n\ncode: -32603\n\nInternal error | code=-32603 | data="Encountered an error in the response stream: An unknown error occurred: dispatch failure"')],
      "error",
    );
    assert.equal(result.category, "network");
    assert.match(result.detail ?? "", /dispatch failure/);
  });
  test("S4 kiro throttling / quota / context wording (from public issues)", () => {
    const failed = (message: string) => turn({ kind: "failed", error: { message: "Internal error", code: "-32603" } }, [says(`[System Error] ${message}`)]).category;
    assert.equal(failed("Too many requests, please wait before trying again."), "rate_limited");
    assert.equal(failed("The request was throttled by the service"), "rate_limited");
    assert.equal(failed("Request quota exceeded. Please wait a moment and try again."), "quota_exhausted");
    assert.equal(failed("You've reached your daily usage limit. Please return tomorrow to continue building."), "quota_exhausted");
    assert.equal(failed("Context limit exceeded unexpectedly. Please start a new session to continue."), "context_exhausted");
    assert.equal(failed("Something odd happened"), "error");
  });
});

describe("looksLikeQuestion (pre-screen, high recall)", () => {
  test("hits", () => {
    for (const text of [
      "Which one do you prefer?",
      "要用哪种语言？",
      "I wrote it in Python. Let me know if you'd like another language.",
      "我先按 Python 写了，如果你想换语言请告诉我。",
      "Before I proceed, please confirm the schema change.",
      "Which option do you prefer:\n1. Patch the parser\n2. Replace the parser",
      "**Should I also update the docs?**",
    ]) {
      assert.equal(looksLikeQuestion(text), true, text);
    }
  });
  test("misses", () => {
    for (const text of ["Done. All tests pass.", "Fixed the bug in parse().", "Steps taken:\n1. Read\n2. Fixed", "```js\nif (a?.b) {}\n```\nImplemented.", ""]) {
      assert.equal(looksLikeQuestion(text), false, text);
    }
  });
});

describe("answer guards", () => {
  test("answerRisk flags irreversible or credential answers", () => {
    assert.ok(answerRisk("Yes, run git push origin main"));
    assert.ok(answerRisk("Go ahead and deploy to production"));
    assert.ok(answerRisk("Use the password from 1Password"));
    assert.ok(answerRisk("可以，删除数据库里的旧数据"));
    assert.equal(answerRisk("Use TypeScript and keep the existing test layout."), null);
    assert.equal(answerRisk("Yes, delete the unused helper function."), null);
  });
  test("similarity catches the same question reworded slightly", () => {
    assert.ok(similarity("Which language should I use?", "Which language should I use for this?") >= 0.5);
    assert.ok(similarity("要用哪种语言？", "你希望用哪种语言？") >= 0.5);
    assert.ok(similarity("Which language?", "Should I add tests for the parser module?") < 0.5);
  });
});

describe("on_outcome schema", () => {
  test("defaults and restrictions", () => {
    const policy = policySchema.parse({ version: 1, action: "review" });
    assert.deepEqual(policy.on_outcome.awaiting_user, { answer: { max: 3 } });
    assert.equal(policy.on_outcome.network, "notify");
    assert.equal(policySchema.safeParse({ version: 1, action: "review", on_outcome: { network: { retry: { max: 2, delay_seconds: 30 } } } }).success, true);
    assert.equal(policySchema.safeParse({ version: 1, action: "review", on_outcome: { quota_exhausted: { retry: { max: 1, delay_seconds: 30 } } } }).success, false);
    assert.equal(policySchema.safeParse({ version: 1, action: "review", on_outcome: { network: { answer: {} } } }).success, false);
    assert.equal(policySchema.safeParse({ version: 1, action: "review", on_outcome: { bogus: "ignore" } }).success, false);
  });
});
