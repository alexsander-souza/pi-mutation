# Feature: run_mutation_tests

> Status: Approved
> Source: `.ai/sdd/ideas/001-llm-backed-mutation-engine.md`
> Last Updated: 2026-08-12

## Overview

`run_mutation_tests` is the core LLM-callable tool of pi-mutation. It drives the full mutation testing pipeline — LLM hotspot analysis, targeted mutation generation, patch application to temp copies, native test runner execution, and streaming progress — in a single tool call. It exists to give developers a fast, low-noise signal on whether their tests catch real bugs, without leaving the OMP session and without installing a dedicated mutation testing tool.

## Business Context

- **Problem:** Traditional mutation tools generate hundreds of syntactic mutations exhaustively, are slow, and produce noisy results. Developers cannot easily tell if their tests would catch real bugs.
- **Users:** Developer using OMP with a Python or Go codebase and an existing test suite.
- **Value:** 3–10 high-signal mutations instead of hundreds; actionable surviving-mutant explanations instead of a raw score.
- **Success signal:** The LLM can read surviving mutants and immediately suggest the missing test, closing the loop in one session.

## Goals

- Provide a single OMP tool that runs a complete LLM-guided mutation test on a target function or file.
- Stream progress incrementally so users see results as they land and can abort early with partial results.
- Surface a structured final result (killed / surviving / score / suggestions) that the LLM can reason over directly.
- Support Python (pytest) and Go (go test) out of the box with a pluggable runner architecture for future languages.

## Non-Goals / Out of Scope

- Exhaustive operator-based mutation generation (as in mutmut / gremlins).
- Language support beyond Python and Go in v1.
- A pre-execution human review step for proposed mutations.
- Running tests in parallel or across multiple files in a single call.
- Persisting mutation results to disk.
- CI/CD integration.

## User Stories

### US-001: Quick function-level check

**As a** developer using OMP  
**I want to** run mutation tests on a single function  
**So that** I can quickly verify that my tests catch real bugs in the code I just wrote or reviewed.

**Acceptance Criteria:**
- [ ] Calling `run_mutation_tests` with a function target and no explicit scope runs a function-level analysis.
- [ ] Results stream incrementally — I see each mutant outcome as it lands.
- [ ] The final result names each surviving mutant and explains what test is missing.

---

### US-002: Deeper file-level analysis

**As a** developer using OMP  
**I want to** run mutation tests on an entire file  
**So that** I can identify under-tested areas I hadn't thought of.

**Acceptance Criteria:**
- [ ] Calling `run_mutation_tests` with a file target and `scope: "file"` analyzes all functions and prioritizes riskiest hotspots.
- [ ] The number of mutations is capped by `max_mutations` (default 20 for file scope) and the cap is enforced by the extension, not just a prompt instruction.
- [ ] Mutation count is visible in streamed progress.

---

### US-003: Surviving mutant explanation

**As a** developer using OMP  
**I want to** understand what each surviving mutant reveals about my test suite  
**So that** I can write the missing test without having to reverse-engineer the mutation diff myself.

**Acceptance Criteria:**
- [ ] Each surviving mutant includes a natural-language explanation of the missing test scenario.
- [ ] The final result includes at least one concrete test suggestion per surviving mutant.
- [ ] Suggestions reference the actual test framework (pytest or go test) idioms.

---

### US-004: Early abort with partial results

**As a** developer using OMP  
**I want to** abort a long mutation run and still see results collected so far  
**So that** I am not forced to wait for the full run when I already have enough information.

**Acceptance Criteria:**
- [ ] Sending an abort signal mid-run stops execution at the next safe boundary.
- [ ] The final result contains all mutations completed before the abort, marked with a `cancelled: true` flag.
- [ ] The tool result is a valid structured result, not an error.

---

### US-005: Invalid patch handling

**As a** developer using OMP  
**I want to** have syntactically invalid patches skipped and reported rather than counted as surviving or killed  
**So that** I get an accurate mutation score and can trust the results.

**Acceptance Criteria:**
- [ ] Patches that fail a syntax check are skipped without running the test suite.
- [ ] Skipped mutants appear in the final result under a separate `invalid` category.
- [ ] The mutation score is computed only over tested mutants (killed + surviving), not invalid or timed-out ones.

---

## Functional Requirements

### FR-001: Target resolution — Must Have

WHEN `run_mutation_tests` is called with a `target` string  
IF the target is a file path ending in `.py` or `.go`  
THE SYSTEM SHALL resolve the file, detect the language from the extension, and proceed with analysis  
SO THAT the caller does not need to specify the language explicitly.

### FR-002: Target resolution fallback — Must Have

WHEN `run_mutation_tests` is called with a `target` that is a symbol name (not a file path)  
THE SYSTEM SHALL search the workspace for a matching function in a `.py` or `.go` file  
AND IF no match is found, SHALL return an error result naming the target and explaining that no match was found  
SO THAT the caller can correct the target.

### FR-003: Hotspot analysis — Must Have

WHEN a target is resolved  
THE SYSTEM SHALL read the source file and associated test file(s), present them to the LLM with a hotspot analysis prompt, and identify up to `max_mutations` mutation hotspots  
SO THAT only semantically meaningful mutations are generated.

### FR-004: Mutation generation — Must Have

WHEN hotspots are identified  
THE SYSTEM SHALL generate a targeted code patch for each hotspot  
AND SHALL cap the total mutation count at `max_mutations` (extension-enforced hard limit, not a prompt suggestion)  
SO THAT run count stays bounded.

### FR-005: Patch validation — Must Have

WHEN a mutation patch is generated  
THE SYSTEM SHALL apply the patch to a temp copy of the source file and validate syntactic correctness before running tests  
AND IF the patch is invalid, SHALL skip the test run and record the mutant as `invalid`  
SO THAT invalid patches never corrupt the original source or produce misleading test results.

### FR-006: Test execution — Must Have

WHEN a validated patch is applied to a temp copy  
THE SYSTEM SHALL invoke the appropriate native test runner subprocess (`pytest` for Python, `go test` for Go) against the affected test files  
AND SHALL record the mutant as `killed` if any test fails and `surviving` if all tests pass  
SO THAT results reflect real test suite behavior.

### FR-007: Streaming progress — Must Have

WHEN the tool is executing mutations  
THE SYSTEM SHALL emit an `onUpdate` event after each mutant completes, containing the mutant description, outcome (`killed` | `surviving` | `invalid` | `timeout`), and a running count  
SO THAT the user sees progress without waiting for the full run.

### FR-008: Final structured result — Must Have

WHEN all mutations are complete or the run is aborted  
THE SYSTEM SHALL return a structured result containing: total mutations attempted, count of `killed`, `surviving`, `invalid`, `timeout`, mutation score (killed / tested × 100), a list of surviving mutants with natural-language explanations, and test improvement suggestions  
SO THAT the LLM can reason over the results and suggest fixes.

### FR-009: Cancellation — Must Have

WHEN the abort signal fires during execution  
THE SYSTEM SHALL stop processing at the next mutation boundary, kill any in-flight subprocess, and return all results collected so far with a `cancelled: true` flag  
SO THAT the user is never blocked by a slow run.

### FR-010: Scope parameter — Should Have

THE SYSTEM SHALL accept a `scope` parameter with values `"function"` (default) or `"file"`  
AND SHALL use function scope when not specified  
AND SHALL cap `max_mutations` at 10 for function scope and 20 for file scope when not explicitly provided by the caller  
SO THAT function-level runs stay fast by default.

### FR-011: Language detection from extension — Must Have

THE SYSTEM SHALL detect the target language from file extension: `.py` → Python, `.go` → Go  
AND SHALL return an error result for any other extension  
SO THAT the plugin fails clearly rather than guessing.

### FR-012: Original file isolation — Must Have

THE SYSTEM SHALL apply all mutations to temp file copies  
AND SHALL never modify the original source file  
SO THAT the workspace is unchanged after the run.

### FR-013: Test file discovery — Should Have

WHEN analyzing a Python target  
THE SYSTEM SHALL look for test files matching `test_<name>.py` or `<name>_test.py` in the same directory or a `tests/` sibling  
AND WHEN analyzing a Go target  
THE SYSTEM SHALL look for `<name>_test.go` in the same package  
SO THAT the correct tests are run against each mutant.

### FR-014: Subprocess timeout — Should Have

THE SYSTEM SHALL enforce a configurable per-mutation subprocess timeout (default 60 s)  
AND SHALL record mutants that exceed the timeout as `timeout` (not `surviving` or `killed`)  
SO THAT slow or hanging test suites do not block the run indefinitely.

### FR-015: Mutation description — Should Have

THE SYSTEM SHALL include for each mutant a one-sentence natural-language description of what the mutation changes  
SO THAT streamed progress and final results are human-readable without parsing a diff.

### FR-016: Run budget warning — Could Have

WHEN the caller passes `max_mutations` above the default cap  
THE SYSTEM SHALL note in the streamed progress that the run may be slow  
SO THAT the user can abort early if needed.

---

## Non-Functional Requirements

### NFR-001: Usability

- Streamed progress messages MUST be readable without parsing JSON — plain language describing the mutant, its outcome, and running totals.
- Error results MUST name the target and suggest a concrete fix (e.g. "no function named X found; check the target path or symbol name").

### NFR-002: Performance

- Function-scope runs SHOULD complete within 60 seconds on a typical small Python/Go project (≤ 20 test files, fast tests).
- Each mutation MUST run only the relevant test files for the target module, not the full project test suite.

### NFR-003: Security / Privacy

- Original source files MUST NOT be modified under any circumstance.
- Temp files MUST be written to a session-scoped temp directory and cleaned up after the run (or on abort).
- File paths passed to subprocess commands MUST be sanitized to prevent shell injection.
- Source file contents MUST NOT be included in tool result `content` beyond what is necessary to describe the mutation.

### NFR-004: Reliability

- A single invalid patch or subprocess failure MUST NOT abort the entire run.
- The tool MUST return a valid structured result even when all mutations fail or time out.
- Subprocess handles MUST be released (killed and awaited) on abort or timeout.

### NFR-005: Extensibility

- Adding a new language MUST require only: a new runner implementation and a language-detection entry. No changes to tool definition or LLM analysis logic.

---

## User Experience Notes

- Primary flow: `run_mutation_tests("path/to/file.py#my_function")` or `run_mutation_tests("my_function", scope: "function")`.
- The streamed progress line for each mutant should read like: `✓ mutant 3/10 — "off-by-one in loop bound" — killed by pytest`.
- When the final result arrives, surviving mutants are listed first (most important signal), each with the suggested missing test.
- On abort: a clear `cancelled: true` note appears in the result, followed by whatever results were collected.
- If no tests are found for the target, the tool returns an error result explaining which test files were searched for and where.

## Constraints

- Python targets require `pytest` to be on `$PATH`.
- Go targets require `go` to be on `$PATH`.
- No other external dependencies.
- Mutations are generated by the LLM session model — a session with an active model is required.

## Decisions

### D-001: Direction C — Streaming single tool

**Decision:** One `run_mutation_tests` tool call with `onUpdate` streaming. No separate analyze/execute phases.  
**Reason:** Low mutation count makes a mandatory review step unnecessary; streaming satisfies visibility without extra orchestration.  
**Source:** Idea artifact Direction C (user confirmed)  
**Impacts:** FR-003 through FR-009, US-001, US-004

### D-002: Path or symbol + auto-detect language

**Decision:** `target` accepts a file path or a symbol name; language is inferred from file extension (`.py` / `.go`).  
**Reason:** Fewer required parameters; extension inference is unambiguous for Python and Go.  
**Source:** Ask Q-detection (user selected "Path or symbol + auto-detect")  
**Impacts:** FR-001, FR-002, FR-011

### D-003: Configurable `max_mutations` with hard cap

**Decision:** Caller may pass `max_mutations`; extension enforces hard caps (10 function / 20 file default).  
**Reason:** Prevents runaway runs on large files while giving the caller control.  
**Source:** Ask Q-mutation_count (user selected "Configurable with hard cap")  
**Impacts:** FR-004, FR-010, NFR-002

### D-004: Skip and continue on failure

**Decision:** Invalid patches and subprocess timeouts are recorded as separate categories and the run continues.  
**Reason:** One bad patch must not invalidate the whole run; score is computed only over tested mutants.  
**Source:** Ask Q-failure_handling (user selected "Skip and continue on failure")  
**Impacts:** FR-005, FR-006, FR-014, US-005

### D-005: Graceful abort with partial results

**Decision:** On abort signal, stop at next mutation boundary, kill in-flight subprocess, return partial results with `cancelled: true`.  
**Reason:** User must never be blocked; partial results are still useful.  
**Source:** Ask Q-cancellation (user selected "Graceful abort, partial results")  
**Impacts:** FR-009, US-004, NFR-004

## Questions

_No open questions. All ambiguities resolved in clarification passes._

## Success Metrics

| Metric | Target / Signal | Notes |
|--------|-----------------|-------|
| Mutation count per function-scope run | 3–10 | vs hundreds in traditional tools |
| Surviving mutants include explanation | 100% | no bare score without context |
| Function-scope run wall time | ≤ 60 s typical | assumes fast local test suite |
| Runs requiring zero external mutation tool | 100% | only pytest / go test |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM generates invalid patches | Medium | FR-005 validates before applying; skipped, not counted |
| LLM generates equivalent mutants | Medium | Prompt engineering toward behavior-changing hotspots; low mutation count limits noise |
| Slow test suite delays run | High | Function-scope default, per-mutation timeout, early abort |
| Test file not found for target | Medium | FR-013 search heuristic + clear error naming what was searched |
| LLM misses a real test gap | Low-Medium | Disclaimer in tool description: LLM-guided, not exhaustive |

## Glossary

- **Mutant:** A modified copy of the source with one targeted change.
- **Killed mutant:** A mutant that caused at least one test to fail.
- **Surviving mutant:** A mutant that no test caught — a test gap.
- **Invalid mutant:** A patch that failed syntax validation before execution.
- **Timeout mutant:** A mutant whose test subprocess exceeded the time limit.
- **Mutation score:** killed / (killed + surviving) × 100. Excludes invalid and timeout mutants.
- **Hotspot:** A code location identified by the LLM as likely to expose a test gap.

## Open Questions

- _None at this time._
