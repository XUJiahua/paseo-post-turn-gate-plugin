#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// Writes <git root>/.paseo/post-turn-gate.json with every field at its default, plus a rules template for
// each role (.paseo/post-turn-gate/<role>.md). The policy is built from the plugin's own schema, so it
// always matches the current format.
//
//   npm run init -- [--check <list>] [--fix <rounds> | --report] [--dir <path>] [--force] [--stdout]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { POLICY_PATH, type Role, policySchema } from "../shared/schema.ts";

const USAGE = `Usage: npm run init -- [options]

Options:
  --check <list>   checks for a finished task, in order, comma-separated: review (code quality, default),
                   verify (the change delivers the request), e.g. verify,review
  --fix <rounds>   fix rounds after a failed check, 1-5 (default: 2)
  --report         report a failed check instead of sending it back to the agent
  --dir <path>     repository to write into (default: current directory; the git root is used)
  --force          overwrite existing files
  --stdout         print the policy instead of writing files
  -h, --help       show this help`;

// Text inside <!-- --> is guidance for the person editing the file; the plugin strips it before use,
// so an untouched template adds no rules.
const TEMPLATES: Record<Role, string> = {
  reviewer: `<!--
Reviewer rules for this repository (.paseo/post-turn-gate/reviewer.md).

Rules the post-turn reviewer applies on top of its built-in review (correctness, regressions, error
handling, security, tests, maintainability). Write them as plain statements, delete what you don't need.
Everything inside these comment markers is ignored; write your rules below the closing marker. Examples:

## Conventions
- Money is stored as integer cents, never floats.
- Every new HTTP endpoint has an integration test in tests/api/.

## What counts as blocking (HIGH)
- Any change to db/migrations/ without a matching rollback.

## Ignore
- Formatting; the pre-commit hook handles it.
-->
`,
  verifier: `<!--
Verifier rules for this repository (.paseo/post-turn-gate/verifier.md).

Rules the post-turn verifier applies when it checks that a change delivers the request. Its built-in job:
map every requirement to evidence, build, and run the relevant tests. Tell it how to do that here.
Everything inside these comment markers is ignored; write your rules below the closing marker. Examples:

## How to build and test
- Build: npm run build
- Unit tests: npm test
- E2E tests: npm run test:e2e (needs \`docker compose up -d\` first)

## Evidence that counts
- A UI change needs a screenshot or a Playwright test, not only a code read.
-->
`,
  answerer: `<!--
Answerer rules for this repository (.paseo/post-turn-gate/answerer.md).

Rules for the agent that answers the coding agent's questions on your behalf. It never answers product
trade-offs, irreversible or outward-facing actions, credentials, or things only you know; use this file to
say which decisions it may make. Everything inside these comment markers is ignored; write your rules below the closing marker. Examples:

- Language and tooling choices are yours to make; follow what the repository already uses.
- Prefer the simplest option that stays within the original request.
- Never approve adding a new dependency; hand that question to me.
-->
`,
};

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    check: { type: "string", default: "review" },
    fix: { type: "string" },
    report: { type: "boolean", default: false },
    dir: { type: "string", default: process.cwd() },
    force: { type: "boolean", default: false },
    stdout: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const checks = values.check.split(",").map((check) => check.trim());
if (!checks.every((check) => check === "review" || check === "verify")) fail(`--check takes review and/or verify, got "${values.check}"\n\n${USAGE}`);
if (values.report && values.fix !== undefined) fail("--fix and --report exclude each other");

// Every field is written with its default value, so the file shows what can be changed.
const chosen: Record<string, unknown> = { version: 2, on_outcome: { done: checks } };
if (values.report) chosen.on_fail = "report";
if (values.fix !== undefined) chosen.on_fail = { fix: { max_rounds: Number(values.fix) } };

const parsed = policySchema.safeParse(chosen);
if (!parsed.success) fail(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
const policy = parsed.data;
const text = `${JSON.stringify(policy, null, 2)}\n`;

if (values.stdout) {
  process.stdout.write(text);
  process.exit(0);
}

let root: string;
try {
  root = execFileSync("git", ["-C", values.dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
} catch {
  fail(`${values.dir} is not inside a git repository`);
}

const files: Array<[string, string]> = [[POLICY_PATH, text]];
for (const role of ["reviewer", "verifier", "answerer"] as const) {
  const file = policy.agents[role].instructions_file;
  if (file) files.push([file, TEMPLATES[role]]);
}
// Check everything first, so a refusal never leaves a half-written setup.
const existing = files.map(([file]) => file).filter((file) => existsSync(path.join(root, file)));
if (existing.length > 0 && !values.force) fail(`already exists: ${existing.join(", ")}; use --force to overwrite`);
for (const [file, content] of files) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`wrote ${target}`);
}
console.log("\nEdit the values and rules you want to change, then commit these files.");
