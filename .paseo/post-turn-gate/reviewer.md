<!--
Reviewer rules for this repository (.paseo/post-turn-gate/reviewer.md).

Rules the post-turn reviewer applies on top of its built-in review (correctness, regressions, error
handling, security, tests, maintainability). Write them as plain statements, delete what you don't need.
Everything inside these comment markers is ignored; write your rules below the closing marker. Examples:

## Conventions
- Money is stored as integer cents, never floats.
- Every new HTTP endpoint has an integration test in tests/api/.

## What counts as blocking (HIGH)
- Any change to db/migrations/ without a matching rollback.

## Ignore
- Formatting; the pre-commit hook handles it.
-->
