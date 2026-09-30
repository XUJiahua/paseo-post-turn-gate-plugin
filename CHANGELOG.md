# Changelog

All notable changes to this project are documented here.

## [Unreleased]

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
