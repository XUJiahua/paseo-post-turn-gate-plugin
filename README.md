# paseo-post-turn-gate-plugin

A [Paseo](https://paseo.sh) plugin that runs an independent reviewer or verifier agent after each agent turn. The result shows up as a card in the original agent's timeline. In `fix` mode the plugin can send failing findings back to the agent for a limited number of rounds.

Design and verified platform behavior: [docs/design.md](docs/design.md). Workflow diagrams: [docs/workflow.md](docs/workflow.md).

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
npm install            # devDependencies only, for typecheck/tests
paseo plugin install "$PWD"
```

Requires Paseo >= 0.10.0 with plugins enabled (Settings → Plugins).

## Enable it for a repository

Generate `.paseo/post-turn-gate.json` and the role rule templates at the target repository's git root. This can also run directly from the Git repository without cloning it:

```bash
npx --yes --package=git+https://github.com/XUJiahua/paseo-post-turn-gate-plugin.git \
  post-turn-gate-init --dir /path/to/repo
```

This downloads and runs the repository's initializer, so review or pin the source when needed (for example, append `#<tag-or-commit>` to the Git URL). From a local checkout, the equivalent commands are:

```bash
npm run init -- --dir /path/to/repo                            # every field with its default
npm run init -- --dir /path/to/repo --check verify,review --fix 3  # the same, with these choices applied
npm run init -- --dir /path/to/repo --report                   # report failures instead of fixing them
npm run init -- --stdout                                       # print the policy instead of writing
```

The initializer writes four files:

- `.paseo/post-turn-gate.json`: every field with its default value. Tests keep the initializer output aligned with the plugin schema. A field you delete falls back to the same default.
- `.paseo/post-turn-gate/reviewer.md`, `verifier.md`, `answerer.md`: active repository instructions for each role. The short HTML comment is editing guidance and is ignored; the Markdown below it is included in every role prompt. Customize and commit these files with the project. See [Choosing the agents](#choosing-the-agents).

It refuses to overwrite any of them unless you pass `--force`; `post-turn-gate-init --help` or `npm run init -- --help` lists all options.

| Field | Values | Default |
|---|---|---|
| `trigger` | `root_only`, `root_and_opt_in`, `all` | `root_and_opt_in` |
| `on_fail` | `{ "fix": { "max_rounds": 1–5 } }`: send a failed check's findings back to the agent and check again, so the agent loops until its work passes. `report`: only show the result | `{ "fix": { "max_rounds": 2 } }` |
| `agents` | launch settings and repository rules for the `reviewer`, `verifier` and `answerer`, see [below](#choosing-the-agents) | inherit the source agent; load each role's repository rules file |
| `on_outcome` | what to do for each way a turn ends, see [below](#what-happens-when-a-turn-ends) | `done: ["review"]` |

### Review, verify, or both

`on_outcome.done` lists the checks a finished task gets. Each check runs as a separate child agent on the task's diff and returns PASS, FAIL or INCONCLUSIVE.

| Check | Agent | Question it answers |
|---|---|---|
| `review` | reviewer | Is the change correct and maintainable? Looks for bugs, regressions, missing error handling, security problems, weak tests. |
| `verify` | verifier | Does the change fully deliver the request? Maps each requirement to evidence and runs the build and tests. |

```json
"on_outcome": { "done": ["verify", "review"] }
```

- Checks run one after another, in the listed order. The first FAIL stops the round: reviewing the code of a change that misses a requirement is wasted work.
- The task passes only when every check passes. An INCONCLUSIVE check does not stop the next one; the result is then INCONCLUSIVE.
- With `on_fail: { "fix": … }` the failing check's findings go back to the agent. The next round starts again from the first check, because a fix can break a check that passed. `max_rounds` counts rounds for the whole task.
- One card shows every check of the current round with its result.
- `"done": "notify"` or `"ignore"` turns checks off.

They do not run in parallel, because two agents building and testing in the same working tree can interfere.

### Choosing the agents

Each role has its own block under `agents`:

```json
"agents": {
  "reviewer": { "profile": null, "permissions": "auto", "timeout_minutes": 30 },
  "verifier": { "profile": null, "permissions": "auto", "timeout_minutes": 30,
                "instructions": "Also run the e2e suite." },
  "answerer": { "profile": null, "permissions": "auto", "timeout_minutes": 10 }
}
```

- `profile` defaults to `null`: the role inherits the source agent's launch settings and does not read a Paseo profile. Set an id or exact name only when this project deliberately opts into a shared profile. A named profile must exist, otherwise the card shows an error. Policies generated by an older release may still contain `post-turn-gate-<role>`; change those values to `null` to adopt the new default.
- Settings are layered: source agent, then `profile`, then explicit fields (`provider`, `model`, `mode`, `thinking`, `features`). If a layer switches to another provider, nothing provider-specific is carried over from the layers below it.
- `profile` is matched by id first, then by exact name.
- `instructions_file` holds the role's rules for this repository, relative to the git root, so they are versioned and reviewed like code. It defaults to `.paseo/post-turn-gate/<role>.md` (`reviewer.md`, `verifier.md`, `answerer.md`); a missing file at the default path means no rules. A path you name yourself must exist and stay inside the repository. `null` turns it off.
- `instructions` is inline text added after the file's rules. Both go into the role's built-in prompt (20,000 characters at most together) and cannot change the reply format. They are read when the turn starts, so an agent editing them during its turn does not affect its own check.
- `permissions`: `auto` approves routine requests and puts risky ones on the card; `ask` puts every request on the card.
- `timeout_minutes` includes time spent waiting for a permission answer. A reviewer or verifier that times out is an ERROR; an answerer that times out hands the question to you.
- The agents write card text (summary, findings, questions, answers) in the language of the original request. To fix a language, say so in `instructions`, for example `"Write all text in English."`.

The role prompt is always built by this plugin: its built-in job and JSON contract, followed by the project-specific `instructions_file` and `instructions`. Paseo profiles only provide launch settings; they never provide or replace these prompts.

For the `codex` provider, managed reviewer, verifier and answerer agents inherit the source model, mode, thinking level and Fast setting. The plugin always turns Codex Plan mode off for those child agents: a Plan-mode turn ends with a plan-approval request, while a gate role must finish with its structured JSON result. Explicitly setting `agents.<role>.features.plan_mode` to `true` is therefore also overridden.

Profiles are optional. To create shared launch profiles and then opt a project into one, run:

```bash
npm run profiles -- --provider kiro --model claude-opus-4.8 --mode kiro_default
npm run profiles -- --provider codex --model gpt-5.5 --role reviewer --dry-run
```

This creates or updates `post-turn-gate-reviewer`, `post-turn-gate-verifier` and `post-turn-gate-answerer` in the local daemon. It does not change repository policy: set `agents.<role>.profile` to the desired id or name to opt in. Use `--role` to create only one profile. The script checks the provider, model, mode and thinking level before writing anything, then reloads the daemon. Run it with `--help` to see all options.

### What happens when a turn ends

Every turn of a gated agent is sorted into a category, and `on_outcome` in the policy decides what the plugin does next:

| Category | Detected from | Default |
|---|---|---|
| `done` | turn completed | `["review"]`: the checks to run, see [above](#review-verify-or-both). Or `notify`, `ignore` |
| `awaiting_user` | the agent stopped to ask something, or the turn looks unfinished (unclosed code block, ended on a tool call, open todos). A rule-based pre-screen runs first, then a semantic check by the answerer | `{ "answer": { "max": 3 } }`: the answerer agent replies for you (or says "Continue."), or hands the question to you. `as_done` treats the stop as finished and applies `done` |
| `refused` | the answerer judged the reply a refusal | `notify` |
| `user_canceled`, `replaced` | you stopped the agent, or sent a new message | `ignore` |
| `crashed`, `network`, `rate_limited` | error text of a failed turn | `notify`, or `{ "retry": { "max", "delay_seconds", "message" } }` |
| `quota_exhausted`, `context_exhausted`, `error` | error text of a failed turn | `notify` (retry is not allowed) |

```json
"on_outcome": {
  "awaiting_user": { "answer": { "max": 3 } },
  "network": { "retry": { "max": 2, "delay_seconds": 30 } }
}
```

- The answerer never answers product trade-offs, anything irreversible or outward-facing (deleting data, pushing, publishing, deploying, spending money), credentials, or information only you have. It also hands a question to you when the agent asks the same thing twice.
- Rules for the answerer, such as "Language and tooling choices are yours to make.", go in `agents.answerer.instructions`.
- The plugin never waits forever: every agent has a `timeout_minutes`, see [above](#choosing-the-agents).
- Answers are sent as `[post-turn gate answered on your behalf]` and stay visible in the timeline.
- The outcome card has a **Stop auto-answering** button.
- A task that spans several turns (answered questions, retries) is reviewed as a whole, starting from its first turn.

- **Which turns are gated:** root agents, and sub-agents labelled `post-turn-gate.target=true`. A turn gets a check, an answerer or a retry only if its task changed the working tree; a turn that only answers a question or asks you one is left alone. So an agent that asks before it starts editing is not auto-answered: tell it in its own instructions to decide routine choices itself.
- **The child agents:** reviewers, verifiers and answerers run in the same workspace as the source agent and are created as its children.
- **Permissions:** by default, routine requests from these agents (reading, building, testing, edits inside the repo) are approved automatically, one at a time. Risky requests (`rm -rf`, `git push`, `sudo`, publishing, deploy tools, secrets, paths outside the repo) are shown on the card with a reason and Yes/No buttons. Set `"permissions": "ask"` on a role to answer every request yourself.
- **Where to find them:** while running, a child agent is listed under the source agent's **Subagents**; when finished it is archived and can be opened from **History**. From a terminal, `paseo logs <id> -f` follows a running one and `paseo logs <id>` shows a finished one; the card prints the command with the id.
- **Where state lives:** in `${PASEO_HOME:-~/.paseo}/plugin-data/post-turn-gate/ledger.sqlite`.

## Develop

```bash
npm run typecheck
npm test
paseo plugin reload post-turn-gate
```

The full workflow has been verified end-to-end with the `kiro` provider. Codex-specific launch, structured-output dispatch and failure classification are covered by tests; a real Paseo + Codex smoke run remains on the TODO list in the design doc, as does Claude.
