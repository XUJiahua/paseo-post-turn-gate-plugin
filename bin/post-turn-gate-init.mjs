#!/usr/bin/env node
// Initializes the repository policy without depending on the plugin runtime packages. Keeping this
// entry point dependency-free lets it run directly from a Git package through npm exec / npx.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const POLICY_PATH = ".paseo/post-turn-gate.json";
const ROLES = ["reviewer", "verifier", "decider"];

const role = (name, timeout) => ({
  profile: null,
  instructions_file: `.paseo/post-turn-gate/${name}.md`,
  permissions: "auto",
  timeout_minutes: timeout,
  permission_wait_minutes: 5,
});

// Task supervision: a decider agent answers for you after every turn that did work.
const SUPERVISED_POLICY = {
  version: 3,
  trigger: "root_and_opt_in",
  supervision: {
    checks: ["verify", "review"],
    speculative_checks: true,
    reply_delay_seconds: 60,
    budget: { max_auto_sends: 12, max_retries: 3, max_no_progress_rounds: 2, max_minutes: 120 },
  },
  agents: { decider: role("decider", 10), verifier: role("verifier", 30), reviewer: role("reviewer", 30) },
};

const USAGE = `Usage: post-turn-gate-init [options]

Options:
  --check <list>   checks, in order, comma-separated: verify (the change delivers the request), review (code
                   quality); default verify,review
  --dir <path>     repository to write into (default: current directory; the git root is used)
  --force          overwrite an existing policy file (role rules files are never overwritten)
  --stdout         print the policy instead of writing files
  --agent-prompt   print a coding-Agent setup task for --dir; write nothing
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
  decider: `<!--
Decider rules for this repository (.paseo/post-turn-gate/decider.md).
The Markdown below is active and is appended to the built-in decider prompt. The decider replies to the agent
for you after each turn; record what it may decide for this project and what must always come to you.
-->
# Repository decider instructions

- Base replies on repository-local guidance and the project's existing architecture and conventions.
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
    check: { type: "string" },
    dir: { type: "string", default: process.cwd() },
    force: { type: "boolean", default: false },
    stdout: { type: "boolean", default: false },
    "agent-prompt": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values["agent-prompt"]) {
  if (values.stdout || values.force) {
    fail("--agent-prompt cannot be combined with --stdout or --force");
  }
  const target = path.resolve(values.dir);
  if (/[\r\n]/.test(target)) fail("--dir cannot contain a newline");
  const shellTarget = `'${target.replaceAll("'", `'\\''`)}'`;
  const prompt = readFileSync(new URL("../docs/install-with-agent.md", import.meta.url), "utf8");
  process.stdout.write(
    prompt
      .replaceAll("{{TARGET_REPOSITORY_SHELL}}", shellTarget)
      .replaceAll("{{TARGET_REPOSITORY}}", target.replaceAll("`", "\\`")),
  );
  process.exit(0);
}

const checkText = values.check ?? "verify,review";
const checks = checkText.split(",").map((check) => check.trim());
if (!checks.every((check) => check === "review" || check === "verify") || new Set(checks).size !== checks.length) {
  fail(`--check takes review and/or verify once each, got "${checkText}"\n\n${USAGE}`);
}
const policy = JSON.parse(JSON.stringify(SUPERVISED_POLICY));
policy.supervision.checks = checks;
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
for (const name of ROLES) {
  files.push([policy.agents[name].instructions_file, TEMPLATES[name]]);
}
// Role rules are the project's own work: an existing rules file is always kept. Only the policy is
// regenerated, and only with --force. Check first, so a refusal never leaves a half-written setup.
if (existsSync(path.join(root, POLICY_PATH)) && !values.force) fail(`already exists: ${POLICY_PATH}; use --force to overwrite it`);
for (const [file, content] of files) {
  const target = path.join(root, file);
  if (file !== POLICY_PATH && existsSync(target)) {
    console.log(`kept ${target} (delete it to regenerate the template)`);
    continue;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`wrote ${target}`);
}
console.log("\nEdit the values and rules you want to change, then commit these files.");
