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

This creates or updates `post-turn-gate-reviewer` and `post-turn-gate-verifier` in the local daemon. The script checks the provider, model, mode and thinking level before writing anything, then reloads the daemon. Run it with `--help` to see all options.

- **Which turns are gated:** root agents, and sub-agents labelled `post-turn-gate.target=true`. A turn is gated only if it completed and changed the working tree.
- **The reviewer agent:** it inherits the source agent's provider, model, mode, thinking and features. It runs in the same workspace as the source agent and is created as its child.
- **Permissions:** if the reviewer asks for a permission, you answer it, the same way you would for the source agent.
- **Where to find reviewers:** finished reviewers are archived and can still be opened from **History**.
- **Where state lives:** in `${PASEO_HOME:-~/.paseo}/plugin-data/post-turn-gate/ledger.sqlite`.

## Develop

```bash
npm run typecheck
npm test
paseo plugin reload post-turn-gate
```

Only verified end-to-end with the `kiro` provider so far; codex and claude are on the TODO list in the design doc.
