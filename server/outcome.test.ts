import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { classify, currentTurnItems, isCourtesyOffer, looksLikeQuestion, similarity, stopSignal } from "./outcome.ts";
import { answerRisk } from "./permissions.ts";
import { gateChecks, policySchema, supervisionSchema } from "../shared/schema.ts";

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

describe("supervision policy and initialization", () => {
  test("only v3 is accepted, with strict checks, roles and budgets", () => {
    const policy = policySchema.parse({ version: 3 });
    assert.deepEqual(gateChecks(policy), ["verify", "review"]);
    assert.deepEqual([policy.agents.reviewer.profile, policy.agents.verifier.profile, policy.agents.decider.profile], [null, null, null]);
    assert.equal(policy.agents.decider.timeout_minutes, 10);
    for (const input of [
      { version: 2 }, { version: 1 }, { version: 3, on_fail: "report" },
      { version: 3, on_outcome: {} }, { version: 3, agents: { answerer: {} } },
      { version: 3, supervision: { checks: [] } },
      { version: 3, supervision: { checks: ["review", "review"] } },
      { version: 3, supervision: { budget: { max_auto_sends: 0 } } },
      { version: 3, supervision: { budget: { max_retries: 4 } } },
    ]) assert.equal(policySchema.safeParse(input).success, false, JSON.stringify(input));
  });

  test("init writes every v3 default, permits check order, and rejects removed flags", () => {
    const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
      ["bin/post-turn-gate-init.mjs", "--stdout", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.deepEqual(run(), policySchema.parse({ version: 3 }));
    assert.deepEqual(run().supervision, supervisionSchema.parse({}));
    assert.deepEqual(run("--check", "review").supervision.checks, ["review"]);
    assert.deepEqual(run("--check", "review,verify").supervision.checks, ["review", "verify"]);
    for (const args of [["--v2"], ["--report"], ["--fix", "2"], ["--supervise"], ["--check", "review,review"], ["--check", ""]]) {
      assert.throws(() => run(...args), /Command failed/);
    }
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
    assert.match(prompt, /decider\.md/);
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

test("requestLanguage names the language of the user's words, not the plugin's labels", async () => {
  const { requestLanguage } = await import("./prompts.ts");
  assert.equal(requestLanguage("Add a function mul(a, b) to add.js that returns a * b."), "English");
  assert.equal(requestLanguage("阅读最新的代码，修正这份设计文档"), "Chinese");
  assert.equal(requestLanguage("Request:\n修正文档\n\nFollow-up from the user: 好的"), "Chinese");
  assert.equal(requestLanguage("Añade una función que multiplique dos números."), null);
  assert.equal(requestLanguage("`npm test`"), null);
});
