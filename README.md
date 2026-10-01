# paseo-post-turn-gate-plugin

A [Paseo](https://paseo.sh) plugin that keeps coding tasks moving: independent verifier and reviewer agents check the work, and a decider replies on your behalf when an answer or repair is needed. Passing checks after a plain finished reply complete the task without a decider call. Each decision round appears as one card in the original agent's timeline.

Design and verified platform behavior: [docs/design.md](docs/design.md). Workflow diagrams: [docs/workflow.md](docs/workflow.md). Supervisor design and remaining roadmap: [docs/completion-supervisor.md](docs/completion-supervisor.md).

## Install

Install directly from GitHub; Paseo keeps a managed checkout and can update it later with `paseo plugin update post-turn-gate`:

```bash
paseo plugin install XUJiahua/paseo-post-turn-gate-plugin
# Equivalent full URL:
paseo plugin install https://github.com/XUJiahua/paseo-post-turn-gate-plugin.git
```

Paseo plugins are trusted, unsandboxed code. Review the repository before installing it. Use `--ref <tag-or-commit>` to pin the initial revision.

For development, install this checkout instead:

```bash
npm ci                 # pinned development dependencies
paseo plugin install "$PWD"
```

Requires Paseo >= 0.10.0 with plugins enabled (Settings → Plugins).
See [local development and testing](docs/local-development.md) for the isolated Paseo 0.10.1 smoke test and
optional startup recovery connection.

## Enable it for a repository

Generate `.paseo/post-turn-gate.json` and the role rule templates at the target repository's git root. This can also run directly from the Git repository without cloning it:

```bash
npx --yes --package=git+https://github.com/XUJiahua/paseo-post-turn-gate-plugin.git \
  post-turn-gate-init --dir /path/to/repo
```

This downloads and runs the repository's initializer, so review or pin the source when needed (for example, append `#<tag-or-commit>` to the Git URL). From a local checkout, the equivalent commands are:

```bash
npm run init -- --dir /path/to/repo                    # version 3: a decider answers for you, every field with its default
npm run init -- --dir /path/to/repo --check review     # the same, reviewing code quality only
npm run init -- --stdout                               # print the policy instead of writing
```

The initializer writes four files:

- `.paseo/post-turn-gate.json`: every field with its default value. Tests keep the initializer output aligned with the plugin schema. A field you delete falls back to the same default.
- `.paseo/post-turn-gate/reviewer.md`, `verifier.md`, `decider.md`: active repository instructions for each role. The short HTML comment is editing guidance and is ignored; the Markdown below it is included in every role prompt. Customize and commit these files with the project. See [Choosing the agents](#choosing-the-agents).

It refuses to overwrite an existing policy unless you pass `--force`, and never overwrites an existing role rules file (delete one to regenerate its template); `post-turn-gate-init --help` or `npm run init -- --help` lists all options.

### Install and tailor it with a coding agent

You can give a coding agent the provider-neutral setup task template in
[docs/install-with-agent.md](docs/install-with-agent.md), after replacing its target-repository placeholders. It tells
the agent how to install the plugin, preserve an existing setup, inspect authoritative project files, and write
distinct repository-specific rules for the reviewer, verifier and decider. It also keeps sensitive and behavioral
decisions with the user.

To print the same task with an absolute target path filled in:

```bash
npx --yes --package=git+https://github.com/XUJiahua/paseo-post-turn-gate-plugin.git \
  post-turn-gate-init --agent-prompt --dir /path/to/repo
```

Paste that output into the coding agent which can access the target repository. The setup turn itself is not gated:
policy and rules are captured when a turn starts, so the plugin takes effect on the next turn that changes files.

## Automatic supervision

Only version 3 policies are supported. Version 2 policies and the `--v2`, `--fix`, `--report`, and `--supervise`
initializer flags have been removed. There is no report-only mode. Replace an old policy explicitly using the
example below or `init --force` after reviewing its settings; existing role rule files are preserved. Move rules
from `answerer.md` into `decider.md` yourself: the plugin no longer reads the old filename.

A plain `done` reply with file changes and no question or unfinished signal starts checks immediately, even with
`speculative_checks: false`. It skips the grace period and the decider plan. All PASS completes the task without
a decider or an automatic message. Other results go to a decider's merge phase after the reply grace period;
checker errors, workspace edits, denied required permissions and ambiguous requirements go directly to you.

For a question or unfinished turn that did work, the decider plans after the grace period while speculative checks
can run. It then writes one reply covering both the answer and any findings to fix. Product trade-offs, risky
external actions, credentials, repeated questions and exhausted budgets go to you. Checkers remain independent:
they read the request and code, never the source agent's explanation. A decider cannot override FAIL.

```json
{
  "version": 3,
  "trigger": "root_and_opt_in",
  "supervision": {
    "checks": ["verify", "review"],
    "speculative_checks": true,
    "reply_delay_seconds": 60,
    "budget": { "max_auto_sends": 12, "max_retries": 3, "max_no_progress_rounds": 2, "max_minutes": 120 }
  },
  "agents": { "decider": {}, "verifier": {}, "reviewer": {} }
}
```

| Field | Meaning | Default |
|---|---|---|
| `supervision.checks` | the checks the decider can rely on, in order | `["verify", "review"]` |
| `supervision.speculative_checks` | start the checks together with the decider instead of after its plan | `true` |
| `supervision.reply_delay_seconds` | grace period after a turn: a reply from you in that time cancels the round | `60` |
| `supervision.budget.max_auto_sends` | messages the plugin may send for one task (replies and retries); your own message starts a new budget | `12` |
| `supervision.budget.max_retries` | automatic retries after crashes, network errors and rate limits (30s, 2min, 8min); then the decider looks at the failure | `3` |
| `supervision.budget.max_no_progress_rounds` | rounds in a row that end on the same tree before the task comes to you | `2` |
| `supervision.budget.max_minutes` | minutes of automation per task | `120` |
| `agents.decider`, `verifier`, `reviewer` | the same settings as [below](#choosing-the-agents); each role reads its own rules file | inherit the source agent |

Code enforces the limits the decider cannot talk its way around: "done" on changed files needs a PASS on the current
tree, a FAIL stands until a change passes it (the checkers never see the agent's arguments), replies that would
approve a risky action are not sent, and every automatic send checks the source revision, idle/error status and
pending permissions immediately before sending. These checks are best-effort: Paseo still needs an atomic
conditional-send API to close the final race with a user message. Design and status:
[docs/completion-supervisor.md](docs/completion-supervisor.md). Verified end to end with the `kiro` and `codex` (via `codex-proxy`) providers.

### Review, verify, or both

`supervision.checks` lists checks in order. `verify` maps requirements to evidence and runs relevant checks;
`review` looks for correctness and maintainability problems. Checks share the source directory and run serially.
The first FAIL stops the run; INCONCLUSIVE continues the remaining checks and goes to the decider. A changed task
completes only with every required check PASS. A repair starts a new run from the first check.

### Choosing the agents

Each role has its own block under `agents`:

```json
"agents": {
  "reviewer": { "profile": null, "permissions": "auto", "timeout_minutes": 30, "permission_wait_minutes": 5 },
  "verifier": { "profile": null, "permissions": "auto", "timeout_minutes": 30, "permission_wait_minutes": 5,
                "instructions": "Also run the e2e suite." },
  "decider": { "profile": null, "permissions": "auto", "timeout_minutes": 10, "permission_wait_minutes": 5 }
}
```

- `profile` defaults to `null`: the role inherits the source agent's launch settings and does not read a Paseo profile. Set an id or exact name only when this project deliberately opts into a shared profile. A named profile must exist, otherwise the card shows an error. Policies generated by an older release may still contain `post-turn-gate-<role>`; change those values to `null` to adopt the new default.
- Settings are layered: source agent, then `profile`, then explicit fields (`provider`, `model`, `mode`, `thinking`, `features`). If a layer switches to another provider, nothing provider-specific is carried over from the layers below it.
- `profile` is matched by id first, then by exact name.
- `instructions_file` holds the role's rules for this repository, relative to the git root, so they are versioned and reviewed like code. It defaults to `.paseo/post-turn-gate/<role>.md` (`reviewer.md`, `verifier.md`, `decider.md`); a missing file at the default path means no rules. A path you name yourself must exist and stay inside the repository; a symlink that points outside it is rejected at any path. `null` turns it off.
- `instructions` is inline text added after the file's rules. Both go into the role's built-in prompt (20,000 characters at most together) and cannot change the reply format. They are read when the turn starts, so an agent editing them during its turn does not affect its own check.
- `permissions`: `auto` approves routine requests and puts risky ones on the card; `ask` puts every request on the card.
- `timeout_minutes` includes time spent waiting for a permission answer. A reviewer or verifier that times out is an ERROR; a decider that times out hands the question to you.
- `permission_wait_minutes`: a request shown on the card that nobody answers in this time is denied. A reviewer or verifier is then asked once for a verdict from the evidence it has, so the card usually shows NEEDS HUMAN with the denied request instead of a timeout ERROR.
- The agents write card text (summary, findings, questions, answers) in the language of the original request. To fix a language, say so in `instructions`, for example `"Write all text in English."`.

The role prompt is always built by this plugin: its built-in job and JSON contract, followed by the project-specific `instructions_file` and `instructions`. Paseo profiles only provide launch settings; they never provide or replace these prompts.

Managed reviewer, verifier and decider agents inherit the source model, mode, thinking level and features such as Codex's Fast setting. The plugin always turns a `plan_mode` feature off for those child agents, whatever the provider id (`codex`, `codex-proxy`, …): a Plan-mode turn ends with a plan-approval request, while a gate role must finish with its structured JSON result. Explicitly setting `agents.<role>.features.plan_mode` to `true` is therefore also overridden.

Profiles are optional. To create shared launch profiles and then opt a project into one, run:

```bash
npm run profiles -- --provider kiro --model claude-opus-4.8 --mode kiro_default
npm run profiles -- --provider codex --model gpt-5.5 --role reviewer --dry-run
```

This creates or updates `post-turn-gate-reviewer`, `post-turn-gate-verifier` and `post-turn-gate-decider` in the local daemon. It does not change repository policy: set `agents.<role>.profile` to the desired id or name to opt in. Use `--role` to create only one profile. The script checks the provider, model, mode and thinking level before writing anything, then reloads the daemon. Run it with `--help` to see all options.

### Turn outcomes and controls

- A pure chat turn without file changes or tool calls is left alone. Failures are handled even without edits.
- Crash, network and rate-limit failures retry after 30 seconds, 2 minutes and 8 minutes, within the task budget.
  After that the decider decides how to continue. Quota and context exhaustion go directly to you.
- Stopping the source never starts a decider. Its unaccepted changes stay in scope for your next message.
  Stopping a turn started by the plugin retains its task and Stop/Resume controls.
- **Stop auto-answering** cancels the current round, including checks. Later turns go to you until you press
  **Resume auto-answering**. Your messages cancel pending automation and reset the task's budget.
- A lost send acknowledgement pauses automation unless the message id is found in the timeline. The plugin
  never replays an uncertain message; check the chat before resuming. An empty completed reply goes to the
  decider rather than being accepted as done, and a bare `429` does not trigger mechanical retries.
- Replies begin with `[post-turn gate answered on your behalf]`. Every new round gets a card at the current
  timeline position; progress updates replace that card.
- Children run in the source workspace and appear in Subagents while running, then History after archival.
  The card includes `paseo logs <id>` for inspecting a decider; running checks include their agent ids.
- File changes during a checker or decider turn discard the result and hand control to you. Nothing is reverted.
  Ignore generated build output in Git. Your next message checks the task from its original baseline.
- Each workspace has its own event queue. Two workspaces using the same Git directory can overlap; detected
  overlaps are persisted and included in prompts. Separate worktrees avoid mixing changes.
- Policy and role rules freeze at turn start. Invalid policies get an error card only for gated turns with edits.
  A fixed configuration updates that card.
- Every automatic send refreshes the source and checks for `idle` or `error` immediately before sending.
  Paseo has no atomic send-if-idle operation; a user message arriving in that small window can still be canceled.
- State lives in `${PASEO_HOME:-~/.paseo}/plugin-data/post-turn-gate/ledger.sqlite`. Recovery starts on the first
  hook or RPC after reload, then reconciles every 60 seconds. Pending child creation replays the same id and key.

## Develop

```bash
npm run typecheck
npm test
paseo plugin reload post-turn-gate
```

Previous smoke runs verified kiro and codex-proxy, including a labelled source sub-agent. See the implementation notes in the supervisor design for the tested revisions; Claude remains untested on this machine.
