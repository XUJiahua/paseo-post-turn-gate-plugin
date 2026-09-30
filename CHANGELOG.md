# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Task supervision with a decider's plan and merge phases, independent checks, one reply and one card per round.
- A plain finished reply with file changes starts checks immediately and skips the decider when all pass.
- Shared task state, automatic send budgets, no-progress and wall-clock limits, and retry backoff (30s, 2min, 8min).
- Stop/Resume auto-answering controls and bounded permission waits with a checker verdict nudge.
- Per-workspace queues, baseline capture at turn arrival, Git timeouts, and persistent overlap notes.

### Changed

- Initialization and policy validation now support version 3 only, directly without an internal v2 translation.
- Failed checks go to the decider for a reply; stopped source turns never start one and keep unaccepted changes.
- Repository role rules and optional shared profiles are named reviewer, verifier and decider.
- Managed roles disable `plan_mode` regardless of provider id, preserving other inherited settings.
- Requests, snapshots, carry and decision state persist together across turns and reloads.

### Removed

- Version 2 policies, report-only mode, template fix loops, the independent answerer path, and their old state fields.
- Initializer flags `--v2`, `--fix`, `--report`, `--supervise`, and the `answerer.md` rules fallback.
- Imports from the early chains/carries/turn_snapshots tables; old policies are not migrated automatically.

### Fixed

- A role rules symlink outside the repository is rejected instead of being read into a prompt.
- Transient check dispatch failures remain attached to their decision round for recovery and error reporting.

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
