#!/usr/bin/env node
// Initializes the repository policy without depending on the plugin runtime packages. Keeping this
// entry point dependency-free lets it run directly from a Git package through npm exec / npx.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const POLICY_PATH = ".paseo/post-turn-gate.json";
const ROLES = ["reviewer", "verifier", "answerer"];

const DEFAULT_POLICY = {
  version: 2,
  trigger: "root_and_opt_in",
  on_fail: { fix: { max_rounds: 2 } },
  agents: {
    reviewer: {
      profile: null,
      instructions_file: ".paseo/post-turn-gate/reviewer.md",
      permissions: "auto",
      timeout_minutes: 30,
    },
    verifier: {
      profile: null,
      instructions_file: ".paseo/post-turn-gate/verifier.md",
      permissions: "auto",
      timeout_minutes: 30,
    },
    answerer: {
      profile: null,
      instructions_file: ".paseo/post-turn-gate/answerer.md",
      permissions: "auto",
      timeout_minutes: 10,
    },
  },
  on_outcome: {
    done: ["review"],
    awaiting_user: { answer: { max: 3 } },
    refused: "notify",
    user_canceled: "ignore",
    replaced: "ignore",
    crashed: "notify",
    network: "notify",
    rate_limited: "notify",
    quota_exhausted: "notify",
    context_exhausted: "notify",
    error: "notify",
  },
};

const USAGE = `Usage: post-turn-gate-init [options]

Options:
  --check <list>   checks for a finished task, in order, comma-separated: review (code quality, default),
                   verify (the change delivers the request), e.g. verify,review
  --fix <rounds>   fix rounds after a failed check, 1-5 (default: 2)
  --report         report a failed check instead of sending it back to the agent
  --dir <path>     repository to write into (default: current directory; the git root is used)
  --force          overwrite existing files
  --stdout         print the policy instead of writing files
  -h, --help       show this help`;

// Text inside <!-- --> is guidance for the person editing the file; active Markdown below it is added
// to the role prompt. The defaults deliberately anchor each role in this repository's own conventions.
const TEMPLATES = {
  reviewer: `<!--
Reviewer rules for this repository (.paseo/post-turn-gate/reviewer.md).
The Markdown below is active and is appended to the built-in reviewer prompt. Edit it to capture this
project's architecture, conventions, required checks, blocking conditions, and intentional exceptions.
-->
# Repository review instructions

- Read relevant repository-local guidance, configuration, tests, and nearby code before judging a change.
- Treat the repository's documented conventions and established patterns as the source of truth.
- Run the smallest relevant test, typecheck, lint, or build commands that can substantiate a finding.
- Report only concrete issues that affect this project; do not block on personal style preferences.
`,
  verifier: `<!--
Verifier rules for this repository (.paseo/post-turn-gate/verifier.md).
The Markdown below is active and is appended to the built-in verifier prompt. Edit it to name this
project's acceptance criteria, authoritative documentation, test commands, and required evidence.
-->
# Repository verification instructions

- Read relevant repository-local guidance and turn every part of the original request into an explicit check.
- Discover build and test commands from this repository's manifests and documentation; run the relevant ones.
- Require observable evidence for behavior changes instead of relying only on a code diff.
- Mark missing evidence as inconclusive or a finding; never silently assume a requirement is satisfied.
`,
  answerer: `<!--
Answerer rules for this repository (.paseo/post-turn-gate/answerer.md).
The Markdown below is active and is appended to the built-in answerer prompt. Edit it to record decisions
the answerer may make for this project and choices that must always be escalated to a person.
-->
# Repository answer instructions

- Base answers on repository-local guidance and the project's existing architecture and conventions.
- Prefer existing dependencies, tools, and patterns over introducing a new project-wide choice.
- Choose the smallest reversible option that stays within the original request.
- Escalate when the repository does not determine the answer or the choice changes product behavior.
`,
};

function fail(message) {
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
if (!checks.every((check) => check === "review" || check === "verify") || new Set(checks).size !== checks.length) {
  fail(`--check takes review and/or verify once each, got "${values.check}"\n\n${USAGE}`);
}
if (values.report && values.fix !== undefined) fail("--fix and --report exclude each other");
const rounds = values.fix === undefined ? null : Number(values.fix);
if (rounds !== null && (!Number.isInteger(rounds) || rounds < 1 || rounds > 5)) {
  fail(`--fix must be an integer from 1 to 5, got "${values.fix}"`);
}

const policy = JSON.parse(JSON.stringify(DEFAULT_POLICY));
policy.on_outcome.done = checks;
if (values.report) policy.on_fail = "report";
if (rounds !== null) policy.on_fail = { fix: { max_rounds: rounds } };
const text = `${JSON.stringify(policy, null, 2)}\n`;

if (values.stdout) {
  process.stdout.write(text);
  process.exit(0);
}

let root;
try {
  root = execFileSync("git", ["-C", values.dir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch {
  fail(`${values.dir} is not inside a git repository`);
}

const files = [[POLICY_PATH, text]];
for (const role of ROLES) files.push([policy.agents[role].instructions_file, TEMPLATES[role]]);
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
