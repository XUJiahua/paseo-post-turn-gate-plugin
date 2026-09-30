import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { classify, currentTurnItems, isCourtesyOffer, looksLikeQuestion, similarity, stopSignal } from "./outcome.ts";
import { answerRisk } from "./permissions.ts";
import { gateChecks, maxFixRounds, policySchema } from "../shared/schema.ts";

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

describe("classify: Codex provider wording", () => {
  test("app-server exits are crashes", () => {
    assert.equal(
      turn({ kind: "failed", error: { message: "Codex app-server exited with code 17 and signal null\nprovider crashed" } }, []).category,
      "crashed",
    );
  });

  test("the Codex usage-limit message is quota exhaustion", () => {
    assert.equal(turn({ kind: "failed", error: { message: "You've hit your usage limit" } }, []).category, "quota_exhausted");
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
    for (const text of [
      "Done. All tests pass.",
      "Fixed the bug in parse().",
      "Steps taken:\n1. Read\n2. Fixed",
      "```js\nif (a?.b) {}\n```\nImplemented.",
      "",
      // An asking phrase that is reported, not asked: only the closing sentence counts.
      "结果是：选方案、要不要继续这两类提问都能自动回答。这也符合插件的定位。",
      'The prompt now says "should I ask first" nowhere. Tests pass.',
    ]) {
      assert.equal(looksLikeQuestion(text), false, text);
    }
  });
});

describe("stopSignal (truncation, turn limit, todos, refusal)", () => {
  test("detects each signal", () => {
    assert.equal(stopSignal([says("Here:\n```ts\nconst a = 1;")]), "truncated");
    assert.equal(stopSignal([says("Let me check."), tool("completed")]), "tool_last");
    assert.equal(
      stopSignal([{ type: "todo", items: [{ text: "a", completed: true }, { text: "b", completed: false }] }, says("Progress so far.")] as never),
      "todo_pending",
    );
    assert.equal(stopSignal([says("I'm sorry, but I can't help with that request.")]), "refused");
    assert.equal(stopSignal([says("抱歉，我无法完成这个请求。")]), "refused");
    assert.equal(stopSignal([says("Which one?")]), "question");
  });
  test("does not flag normal finished turns", () => {
    assert.equal(stopSignal([tool("completed"), says("Done. Tests pass")]), null);
    assert.equal(stopSignal([says("```ts\nconst a = 1;\n```\nImplemented")]), null);
    assert.equal(stopSignal([{ type: "todo", items: [{ text: "a", completed: true }] }, says("All done.")] as never), null);
    assert.equal(stopSignal([says("I can't reproduce the bug anymore after the fix; all tests pass.")]), null);
  });
  test("classify routes a truncated reply to the semantic check with its signal", () => {
    assert.deepEqual(turn({ kind: "completed" }, [says("```js\nfunction")]), { category: "awaiting_user", detail: "truncated" });
  });
  test("a finished report with one closing offer is done, not a question", () => {
    for (const text of [
      "Implemented the parser and added tests. Let me know if you need anything else.",
      "Fixed the bug in parse(). Anything else?",
      "Added the CLI flag and updated the README. Want me to also add a changelog entry?",
      "我先按 Python 写了，如果你想换语言请告诉我。",
      "已完成修改并通过测试。需要我再补充文档吗？",
    ]) {
      assert.equal(isCourtesyOffer(text), true, text);
      assert.equal(stopSignal([says(text)]), null, text);
    }
    for (const text of [
      "Anything else?", // nothing reported before it
      "Should I also update the docs?",
      "I read the code. Would you like me to use Redis or an in-memory cache?", // a choice
      "Which database should I use? Let me know.", // a real question before the offer
      "Done with step 1. Should I proceed with the migration, which drops the old table?",
    ]) {
      assert.equal(isCourtesyOffer(text), false, text);
      assert.equal(stopSignal([says(text)]), "question", text);
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
  test("answerRisk counts commands and actions, not a cloud tool's name in prose", () => {
    for (const text of [
      "Should I use the AWS SDK v3 or v2 for the S3 client?\nUse v3.",
      "Should I add a unit test for src/aws/client.ts?\nYes.",
      "Helm chart values: keep replicaCount at 2 or bump it to 3?\nKeep 2.",
      "Should I update the Terraform module docs in README?\nYes, update the README.",
      "Want me to refactor the blob adapter? (az-storage)\nYes.",
      "Should I run the tests?\nYes, run `npm test`.",
      "Should I check `cat src/aws/client.ts` first?\nYes.",
    ]) {
      assert.equal(answerRisk(text), null, text);
    }
    for (const text of [
      "Should I run `terraform apply`?\nYes.",
      "Clean up the bucket?\nYes, run aws s3 rm s3://old --recursive",
      "Next step:\n```sh\nkubectl delete ns staging\n```\nGo ahead.",
      "Should I apply the Terraform plan?\nYes.",
      "Should I push the branch?\nYes, push it.",
      "Should I run the migrations on production?\nYes.",
    ]) {
      assert.ok(answerRisk(text), text);
    }
  });
  test("similarity catches the same question reworded slightly", () => {
    assert.ok(similarity("Which language should I use?", "Which language should I use for this?") >= 0.5);
    assert.ok(similarity("要用哪种语言？", "你希望用哪种语言？") >= 0.5);
    assert.ok(similarity("Which language?", "Should I add tests for the parser module?") < 0.5);
  });
});

describe("on_outcome schema", () => {
  test("defaults and restrictions", () => {
    const policy = policySchema.parse({ version: 2 });
    assert.deepEqual(policy.on_outcome.awaiting_user, { answer: { max: 3, delay_seconds: 60 } });
    assert.equal(policy.on_outcome.network, "notify");
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { network: { retry: { max: 2, delay_seconds: 30 } } } }).success, true);
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { quota_exhausted: { retry: { max: 1, delay_seconds: 30 } } } }).success, false);
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { network: { answer: {} } } }).success, false);
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { bogus: "ignore" } }).success, false);
  });

  test("done lists the checks, on_fail picks fix rounds, profiles default off, v1 fields are rejected", () => {
    const policy = policySchema.parse({ version: 2 });
    assert.deepEqual(gateChecks(policy), ["review"]);
    assert.equal(maxFixRounds(policy), 2, "fix is the default");
    assert.equal(maxFixRounds(policySchema.parse({ version: 2, on_fail: "report" })), 0);
    assert.deepEqual(gateChecks(policySchema.parse({ version: 2, on_outcome: { done: ["verify", "review"] } })), ["verify", "review"]);
    assert.deepEqual(gateChecks(policySchema.parse({ version: 2, on_outcome: { done: "notify" } })), []);
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { done: [] } }).success, false);
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { done: ["review", "review"] } }).success, false);
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { done: "review" } }).success, false);
    assert.deepEqual(
      [policy.agents.reviewer.profile, policy.agents.verifier.profile, policy.agents.answerer.profile],
      [null, null, null],
    );
    assert.equal(policy.agents.answerer.timeout_minutes, 10);
    assert.equal(policySchema.parse({ version: 2, agents: { verifier: { profile: null } } }).agents.verifier.profile, null);
    assert.equal(policySchema.safeParse({ version: 2, reviewer: {} }).success, false);
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { awaiting_user: { answer: { profile: "x" } } } }).success, false);
    assert.equal(maxFixRounds(policySchema.parse({ version: 2, on_fail: { fix: {} } })), 2);
    assert.equal(policySchema.safeParse({ version: 2, on_fail: { fix: { max_rounds: 0 } } }).success, false);
    assert.equal(policySchema.safeParse({ version: 2, on_outcome: { awaiting_user: "gate" } }).success, false);
    assert.equal(policySchema.safeParse({ version: 1, action: "review" }).success, false);
    assert.equal(policySchema.safeParse({ version: 2, action: "review" }).success, false);
  });

  test("npm run init writes every field with its default, plus the chosen options", () => {
    const run = (...args: string[]) =>
      JSON.parse(execFileSync(process.execPath, ["bin/post-turn-gate-init.mjs", "--stdout", ...args], { encoding: "utf8" }));
    const defaults = run();
    assert.deepEqual(defaults, policySchema.parse({ version: 2 }));
    assert.deepEqual(defaults.on_fail, { fix: { max_rounds: 2 } });
    assert.equal(run("--report").on_fail, "report");
    assert.deepEqual(defaults.on_outcome.done, ["review"]);
    assert.equal(defaults.agents.verifier.profile, null);
    const chosen = run("--check", "verify,review", "--fix", "3");
    assert.deepEqual(chosen.on_fail, { fix: { max_rounds: 3 } });
    assert.deepEqual(chosen.on_outcome.done, ["verify", "review"]);
    assert.equal(chosen.on_outcome.network, "notify", "other fields keep their defaults");
    assert.throws(() => run("--fix", "0"), /Command failed/);
    assert.throws(() => run("--check", "review,review"), /Command failed/);
  });

  test("the CLI prints a safe, repository-specific coding-Agent setup task", () => {
    const target = path.resolve("a target repository");
    const prompt = execFileSync(
      process.execPath,
      ["bin/post-turn-gate-init.mjs", "--agent-prompt", "--dir", target],
      { encoding: "utf8" },
    );
    assert.ok(prompt.includes(target));
    assert.match(prompt, /paseo plugin install XUJiahua\/paseo-post-turn-gate-plugin/);
    assert.match(prompt, /Never use `--force`/);
    assert.match(prompt, /reviewer\.md/);
    assert.match(prompt, /verifier\.md/);
    assert.match(prompt, /answerer\.md/);
    assert.match(prompt, /next agent turn/i);
    assert.match(prompt, /exact installed plugin checkout/i);
    assert.match(prompt, /does not contain.*bin\/post-turn-gate-init\.mjs.*stop/is);
    assert.doesNotMatch(
      prompt,
      /npx --yes --package=git\+https:\/\/github\.com\/XUJiahua\/paseo-post-turn-gate-plugin\.git[\s\\]*post-turn-gate-init --dir/,
    );
    assert.doesNotMatch(prompt, /\{\{TARGET_REPOSITORY\}\}/);
    assert.doesNotMatch(prompt, /\{\{TARGET_REPOSITORY_SHELL\}\}/);
    assert.throws(
      () => execFileSync(process.execPath, ["bin/post-turn-gate-init.mjs", "--agent-prompt", "--stdout"]),
      /Command failed/,
    );
  });
});
