# paseo-post-turn-gate-plugin

A [Paseo](https://paseo.sh) plugin that runs an independent reviewer or verifier agent after each agent turn. The result shows up as a card in the original agent's timeline. In `fix` mode the plugin can send failing findings back to the agent for a limited number of rounds.

Design and verified platform behavior: [docs/design.md](docs/design.md).

## Install

```bash
npm install            # devDependencies only, for typecheck/tests
paseo plugin install "$PWD"
```

Requires Paseo >= 0.10.0 with plugins enabled (Settings → Plugins).

## Enable it for a repository

Commit `.paseo/post-turn-gate.json` at the git root:

```json
{
  "version": 1,
  "action": "review",
  "trigger": "root_and_opt_in",
  "review": { "on_fail": "report", "max_fix_rounds": 2 }
}
```

| Field | Values | Default |
|---|---|---|
| `action` | `none`, `verify`, `review` | required |
| `trigger` | `root_only`, `root_and_opt_in`, `all` | `root_and_opt_in` |
| `review.on_fail` | `report`, `fix` | `report` |
| `review.max_fix_rounds` | 0–5 | 2 |
| `reviewer` | see below | inherit from the source agent |

### Choosing the reviewer

By default the reviewer uses the same provider, model, mode, thinking level and features as the agent it reviews. You can override this with a Paseo agent profile, with explicit fields, or with both:

```json
"reviewer": {
  "profile": "post-turn-gate-reviewer",
  "model": "gpt-5.5",
  "instructions": "Also check that every public function has a test.",
  "timeout_minutes": 45
}
```

- Settings are layered: source agent, then `profile`, then explicit fields (`provider`, `model`, `mode`, `thinking`, `features`).
- If a layer switches to another provider, nothing provider-specific is carried over from the layers below it.
- `profile` is matched by id first, then by exact name.
- `instructions` is added to the built-in prompt. It cannot change the verdict format.

To create the profiles, run:

```bash
npm run profiles -- --provider kiro --model claude-opus-4.8 --mode kiro_default
npm run profiles -- --provider codex --model gpt-5.5 --role reviewer --dry-run
```

This creates or updates `post-turn-gate-reviewer`, `post-turn-gate-verifier` and `post-turn-gate-answerer` in the local daemon. Use `--role` to create only one of them. The script checks the provider, model, mode and thinking level before writing anything, then reloads the daemon. Run it with `--help` to see all options.

### What happens when a turn ends

Every turn of a gated agent is sorted into a category, and `on_outcome` in the policy decides what the plugin does next:

| Category | Detected from | Default |
|---|---|---|
| `done` | turn completed | `gate` (run the review or verify) |
| `awaiting_user` | the agent stopped to ask something (a rule-based pre-screen, then a semantic check by the answerer) | `{ "answer": { "max": 3 } }`: the answerer agent replies for you, or hands the question to you |
| `user_canceled`, `replaced` | you stopped the agent, or sent a new message | `ignore` |
| `crashed`, `network`, `rate_limited` | error text of a failed turn | `notify`, or `{ "retry": { "max", "delay_seconds", "message" } }` |
| `quota_exhausted`, `context_exhausted`, `error` | error text of a failed turn | `notify` (retry is not allowed) |

```json
"on_outcome": {
  "awaiting_user": { "answer": { "max": 3, "instructions": "Language and tooling choices are yours to make." } },
  "network": { "retry": { "max": 2, "delay_seconds": 30 } }
}
```

- The answerer never answers product trade-offs, anything irreversible or outward-facing (deleting data, pushing, publishing, deploying, spending money), credentials, or information only you have. It also hands a question to you when the agent asks the same thing twice.
- Answers are sent as `[post-turn gate answered on your behalf]` and stay visible in the timeline.
- The outcome card has a **Stop auto-answering** button.
- A task that spans several turns (answered questions, retries) is reviewed as a whole, starting from its first turn.

- **Which turns are gated:** root agents, and sub-agents labelled `post-turn-gate.target=true`. A turn is gated only if it completed and changed the working tree.
- **The reviewer agent:** it inherits the source agent's provider, model, mode, thinking and features. It runs in the same workspace as the source agent and is created as its child.
- **Permissions:** by default, routine requests from the reviewer (reading, building, testing, edits inside the repo) are approved automatically, one at a time. Risky requests (`rm -rf`, `git push`, `sudo`, publishing, deploy tools, secrets, paths outside the repo) are shown on the card with a reason and Yes/No buttons. Set `"reviewer": { "permissions": "ask" }` to answer every request yourself.
- **Where to find reviewers:** finished reviewers are archived and can still be opened from **History**.
- **Where state lives:** in `${PASEO_HOME:-~/.paseo}/plugin-data/post-turn-gate/ledger.sqlite`.

## Develop

```bash
npm run typecheck
npm test
paseo plugin reload post-turn-gate
```

Only verified end-to-end with the `kiro` provider so far; codex and claude are on the TODO list in the design doc.
