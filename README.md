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
