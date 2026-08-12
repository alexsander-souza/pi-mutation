# Idea: LLM-Backed Mutation Testing Engine

> Status: idea:captured
> Created: 2026-08-12

## Raw Idea

Build the mutation generation engine directly into the plugin using the LLM, rather than delegating to existing tools (mutmut, gremlins, Stryker). Existing tools apply mechanical syntactic operators exhaustively — they generate too many irrelevant or equivalent mutations, run every combination, and don't scale to real codebases. The LLM understands code semantics, so it can identify the spots most likely to expose test gaps and author only the mutations that matter, minimizing the number of test suite executions required.

## Problem Space

- Traditional mutation tools apply operators blindly (flip `+` to `-`, remove a line, change a constant) across the entire file — most generated mutants are equivalent or semantically irrelevant.
- Every mutant requires a full test suite run; combinatorial mutation counts make this prohibitively slow on anything but tiny modules.
- Existing tools are per-language and require installation, configuration, and output parsing per framework.
- Developers get a noisy result: hundreds of surviving mutants they have to manually triage to find the ones that actually indicate test gaps.

## Target Users

- **Developer using OMP:** Has a Python or Go codebase with a test suite. Wants to know whether the tests would catch real bugs — not a long wall of equivalent mutant reports.

## Current Alternatives

- **mutmut (Python):** Syntactic operators, slow on large files, requires pip install, produces raw JSON/text output.
- **gremlins (Go):** Similar model; requires separate install and project-level config.
- **Stryker (JS/TS):** More sophisticated, but still operator-based and JS/TS only.
- **Manual review:** Developer reads code and tests and guesses where tests are thin — subjective, misses non-obvious gaps.

## Desired Outcome

- A single OMP tool call surfaces 3–10 high-signal mutations for a target function or file.
- Each mutation is a plausible real-world bug, not a syntactic curiosity.
- The test suite runs only for those mutations; results arrive incrementally so the user sees progress.
- Surviving mutants come with a natural-language explanation of what test is missing.
- No external mutation tool installation required — only the language's native test runner (pytest, go test).

## Chosen Direction: C — Streaming Single Tool with Incremental Output

One `run_mutation_tests(target, scope)` tool call drives the full pipeline:

```
1. Analyze:   LLM reads source + tests → identifies mutation hotspots
2. Generate:  LLM authors targeted patches at those hotspots
3. Execute:   Extension applies each patch to a temp copy → runs pytest / go test
4. Stream:    onUpdate emits progress as each mutant result lands
5. Report:    Final structured result: killed, surviving, score, improvement suggestions
```

**Scope:** caller chooses `function` (fast, targeted) or `file` (deeper analysis); defaults to `function`.

**Trade-offs accepted:**
- No pre-execution review step — mutations run immediately after generation. Acceptable because LLM-generated mutations are few and high-signal; user can abort early if test suite is slow.
- Tool call blocks until all mutations complete, but `onUpdate` streaming means the user is never staring at a blank response.

### Discarded Directions

- **Direction A (Monolithic, no streaming):** Same as C but no incremental output. Rejected — bad UX for slow test suites; no way to abort with partial results.
- **Direction B (Two-phase interactive):** Separate analyze and execute tools. Higher orchestration overhead; adds a mandatory review step that slows the happy path without meaningful benefit given low mutation count.

## Constraints

- **Languages:** Python (pytest) and Go (go test) first. Runner interface must be pluggable for future languages.
- **No external mutation tool dependency:** Only native test runners.
- **Token budget:** Mutation generation must stay within a reasonable context window; very large files should be scoped to function-level or chunked.
- **Correctness gate:** Generated patches must be syntactically valid before being applied; invalid patches are skipped and reported as errors, not test failures.
- **Temp file hygiene:** Mutations applied to temp copies; original files never modified.

## Signals of Value

- Test suite run count is dramatically lower than traditional tools (3–10 runs vs hundreds).
- Surviving mutants map directly to missing test cases — actionable, not just a score.
- Works on any Python/Go project with zero per-project configuration.
- The LLM can immediately suggest the missing test after identifying a surviving mutant, closing the loop in one session.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM generates syntactically invalid patches | Medium | Validate patch applies cleanly before running tests; skip and report |
| LLM generates semantically equivalent mutants | Medium | Prompt engineering; hotspot analysis biases toward behavior-changing spots |
| Mutation run time still slow for large test suites | High | Default to function scope; stream progress; support early abort via signal |
| LLM context window limits for large files | Medium | Chunk at function boundary; warn user to narrow scope |
| False confidence — LLM skips a real gap | Low-Medium | Explicit disclaimer: LLM-guided, not exhaustive; pair with coverage tools |

## Steering Impact

This idea **inverts** the following boundary in `product.md`:

> ~~Out of Scope: Implementing a mutation testing engine~~

The plugin now **is** the mutation engine — LLM-backed. `product.md` and `tech-stack.md` need to be updated:
- Remove mutmut / gremlins as dependencies.
- Remove "delegate to external CLI tool" as the architectural model.
- Add native test runner (pytest, go test) as the only subprocess dependency.
- Update TD-001 and TD-002 in tech-stack.md.

## Recommendation

- [x] Create REQUIREMENTS directly — direction is clear, scope is well-bounded, no competing directions remain.

**Next:** `/skill:sdd-prd` for the core `run_mutation_tests` tool feature.
