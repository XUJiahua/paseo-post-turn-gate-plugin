# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- `agents.<role>.permission_wait_minutes` (default 5): a request on the card that nobody answers is denied, and the checker is asked once for a verdict from its evidence.
- `awaiting_user.answer.delay_seconds` (default 60): the answerer waits for your own reply first.
- `on_inconclusive` (`report` | `fail`) and `inconclusive_reason` in the verdict; blocked or ambiguous checks show NEEDS HUMAN.

### Changed

- After the fix rounds are used up (or the agent disputed the findings), the next turn keeps counting the task's rounds instead of starting a new fix loop, and a turn that changes nothing leaves the changes as they are instead of checking the same tree again. Unchecked changes expire after a day.
- Stopping the agent no longer drops what it changed: the changes are checked with its next turn.
- Failed turns are reported or retried even when they changed no files; a stop after tool calls is auto-answered even before files change.
- A finished report ending with a closing offer ("Let me know if you need anything else.") is `done`, not a question.
- A fix turn that changes nothing is no longer checked again: a question goes to the answerer, a disagreement to you. The checker never sees the agent's reply.
- Only the closing sentence of a reply counts as asking: "要不要" or "should I" earlier in the reply, or inside quotes, no longer starts the answerer.
- The second check on automatic answers looks at commands and action phrases only: a cloud tool named in prose ("use the AWS SDK", `src/aws/client.ts`) no longer sends the question to you.
- When the answerer finds the agent had finished, the card reads "Finished" without an "Agent asked" excerpt; excerpts of long replies start at a sentence boundary.
- Outcome cards: each new question, failure or retry gets a new card at the current timeline position.
- Config error cards appear only for gated turns that changed files, once per policy version, and are marked fixed once the policy is valid.
- Cloud/deploy tools named in a command still need you whatever prefix runs them, but read-only commands (`cat src/aws/x.ts`, `grep helm …`) no longer do; `git -C <dir> push` and `sh -c` scripts are recognized.

### Fixed

- A role rules file symlinked to a path outside the repository is rejected instead of being read into the prompt.

## [0.1.0] - 2026-09-30

Initial release of the Paseo Post Turn Gate plugin. Requires Paseo 0.10.0 or later with plugins enabled.

### Added

- Configurable reviewer and verifier agents that check completed work, show results in the agent timeline, and can send failed findings back for a bounded fix loop.
- Outcome-based handling for unfinished turns, refusals, cancellations, and errors, including optional answerer and retry behavior.
- Repository setup through `post-turn-gate-init`, with a policy file and role-specific instruction templates for reviewer, verifier, and answerer agents.
- Codex provider support, along with per-role agent settings and Paseo profile support.
- Agent-guided installation instructions for tailoring the plugin to a repository.

### Changed

- Gate behavior is configurable per repository, including which checks run, when they run, and how failures are handled.
- Tasks that make no working-tree changes are skipped by the gate.

### Fixed

- Parse the final structured reply from gate agents reliably.
- Publish a status card for every gate round before archiving the reviewer agent.

[Unreleased]: https://github.com/XUJiahua/paseo-post-turn-gate-plugin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/XUJiahua/paseo-post-turn-gate-plugin/releases/tag/v0.1.0
