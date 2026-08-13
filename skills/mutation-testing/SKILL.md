---
name: mutation-testing
description: Assess whether a test suite actually catches bugs, and fix the gaps. Use when the user asks if their tests are meaningful, whether coverage is "real", to harden or audit tests, or right after writing/generating tests for a Python or Go function or file. Runs the run_mutation_tests tool and drives the surviving-mutant → write-test loop.
---

# Mutation testing workflow

Line coverage proves a line *ran*, not that a test would *fail if the line broke*.
Mutation testing closes that gap: mutate the code, rerun the suite, and any mutant
the tests still pass on is a hole. This plugin uses the LLM as the mutation engine —
it targets high-signal spots, not exhaustive operators, so runs are small and fast.

## When to reach for it

- User asks "are my tests any good / meaningful?", "is this actually covered?",
  "would my tests catch a bug here?"
- Immediately after you or the user writes or generates tests — verify they bite.
- Hardening a critical function (parsers, money math, boundary/branch-heavy logic).

Not a coverage replacement: it is LLM-guided and non-exhaustive. Pair with a
line-coverage tool when completeness matters, and say so.

## How to run

Call the `run_mutation_tests` tool.

- `target` — a file path (`src/billing.py`) or a symbol name (`calculate_total`).
  Language is auto-detected from the extension.
- `scope` — default `function`; use `file` only when auditing a whole module.
  Start narrow: function scope is faster and its survivors are easier to act on.
- Leave `max_mutations` / `timeout_ms` at defaults unless a run is too shallow
  (raise the cap) or tests are genuinely slow (raise the timeout). Raising the cap
  above the default triggers a slow-run warning — expected.

Prerequisites the tool enforces: the target must resolve to a source file, test
files must be discoverable, and the native runner (`pytest` / `go test`) must be
installed. If it returns `no_tests_found`, the real gap is that there are no tests —
write some first, then run.

## Reading the result

The tool returns a mutation score and a structured `details` object:

- **score** = killed / (killed + surviving). `invalid` and `timeout` mutants are
  excluded from the denominator, so report tested-vs-total honestly, not just the %.
- **surviving** mutants are the payload. Each carries `description` (what changed),
  `explanation` (why no test caught it), and `suggestion` (a concrete test to add).
- `invalid` = the patch didn't apply/parse (skipped, not a test gap).
  `timeout` = the suite hung on that mutant; consider raising `timeout_ms`.
- Score 100% with a low tested count is weak evidence, not a clean bill — note it.

## Act on survivors — don't just report

A run is not done when you print the score. For each surviving mutant:

1. Read its `explanation` to understand the untested behavior.
2. Write the test from its `suggestion`, in the project's existing test style and
   file — adapt it, don't paste verbatim.
3. Rerun `run_mutation_tests` on the same target and confirm the mutant is now
   killed and the score rose.

Loop until survivors are gone or a remaining survivor is a known
equivalent/acceptable mutant — call those out explicitly rather than silently
leaving them.

## Recovery

Mutations are applied in place with a `<file>.pi-mutation-bak` backup, restored on
every exit path. Only if the OMP process is killed with SIGKILL mid-run will a stale
mutated file remain; restore it with `mv <file>.pi-mutation-bak <file>`.
