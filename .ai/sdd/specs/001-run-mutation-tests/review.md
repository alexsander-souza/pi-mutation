# Review: run_mutation_tests

> Requirements: @requirements.md
> Design: @design.md
> Tasks: @tasks.md
> Status: Final
> Reviewed: 2026-08-12

## Review Scope

- **Feature:** run_mutation_tests (001)
- **Implementation status:** implementation:done
- **Files reviewed:**
  - `src/index.ts`
  - `src/types.ts`
  - `src/target-resolver.ts`
  - `src/test-discovery.ts`
  - `src/analysis-engine.ts`
  - `src/mutation-runner.ts`
  - `src/result-builder.ts`
  - `src/runners/index.ts`
  - `src/runners/python.ts`
  - `src/runners/go.ts`
  - `src/__tests__/` (all 7 test files)
  - `package.json`, `tsconfig.json`
- **Out of review scope:**
  - `fixtures/` — test fixtures, not production code

## Coverage Check

| Requirement | Expected Coverage | Status | Evidence / Notes |
|-------------|-------------------|--------|------------------|
| FR-001 Target resolution (path) | T3, `target-resolver.ts` | Pass | `resolveFilePath` handles `.py`/`.go`, path escape rejected, not-found named |
| FR-002 Target resolution (symbol) | T3, `target-resolver.ts` | Pass | `resolveSymbol` walks workspace for `def <symbol>(` / `func <symbol>(` |
| FR-003 Hotspot analysis | T6, `analysis-engine.ts` | Pass | `buildPrompt` constructs language-specific prompt; `llmCall` injected for testability |
| FR-004 Mutation generation + cap | T6, `analysis-engine.ts` | Pass | `mutations.slice(0, opts.maxMutations)` enforced post-parse, not in prompt |
| FR-005 Patch validation | T7, `mutation-runner.ts` | Pass | `validateSyntax` → `checkPythonSyntax` (ast.parse) / `checkGoSyntax` (gofmt -e); invalid → skipped, test not spawned |
| FR-006 Test execution | T5/T7, `runners/*.ts`, `mutation-runner.ts` | Pass | `pythonRunner` spawns `pytest <files> --tb=short -q`; `goRunner` spawns `go test ./...`; argv array, no shell |
| FR-007 Streaming progress | T7, `mutation-runner.ts` | Pass | `onUpdate` called once per mutant with symbol, count, description, outcome |
| FR-008 Final structured result | T8, `result-builder.ts` | Pass | `buildResult` returns `{ content, details }`; `details` matches `MutationRunResult` |
| FR-009 Cancellation | T7/T9, `mutation-runner.ts`, `index.ts` | Pass | Pre-abort check in `index.ts` before any FS touch; per-mutant `signal.aborted` check; `AbortError` catch → break; partial results returned |
| FR-010 Scope parameter | T9, `index.ts` | Pass | zod enum `["function", "file"]`, default `"function"`; caps 10/20 enforced |
| FR-011 Language detection | T3, `target-resolver.ts` | Pass | `EXTENSION_LANGUAGE` record; unsupported → named error with extension |
| FR-012 Original file isolation | T7, `mutation-runner.ts` | Pass | Backup to `.pi-mutation-bak` before first write; restore in `finally`; SIGINT/SIGTERM handler; integration test confirms byte-identical restore |
| FR-013 Test file discovery | T4, `test-discovery.ts` | Pass | Python: `test_<base>.py`, `<base>_test.py`, `tests/test_<base>.py`; Go: `<base>_test.go`; searched paths in error |
| FR-014 Subprocess timeout | T5/T7, `runners/*.ts` | Pass | `setTimeout` kills child with SIGKILL after `timeoutMs`; resolved as `{ killed: false, output: "timeout" }` |
| FR-015 Mutation description | T6, `analysis-engine.ts` | Pass | `description` and `explanation` required in schema; `isMutationItem` type guard enforces |
| FR-016 Run budget warning | T9, `index.ts` | Pass | `onUpdate` warning emitted when `max_mutations > defaultCap` |
| NFR-001 Usability | T8, `result-builder.ts` | Pass | Plain-language progress lines; surviving mutants first; actionable error messages naming searched paths |
| NFR-002 Performance | T7, `mutation-runner.ts` | Pass | Scoped test file list passed to runner; sequential execution per TD-003 |
| NFR-003 Security / Privacy | T3/T7 | Pass | Path escape rejected in `resolveTarget`; argv arrays (no shell); original restored in `finally`; concurrent-run guard |
| NFR-004 Reliability | T7 | Pass | Single-mutant failure does not abort run; `invalid`/`timeout` recorded and loop continues |
| NFR-005 Extensibility | T5, `runners/index.ts` | Pass | `registerRunner`/`getRunner`; new language = new `RunnerEntry` + runner implementation only |

## Task Completion Check

| Task | Status | Evidence / Notes |
|------|--------|------------------|
| T1 Project scaffold | Pass | `package.json` has `omp.extensions`, `tsconfig.json` strict, `bunx tsc --noEmit` exits 0 |
| T2 Shared types | Pass | All 5 interfaces exported from `types.ts`; `score: number \| null` confirmed |
| T3 Target resolver | Pass | 8 unit tests pass; escape, not-found, unsupported, symbol-found, symbol-not-found all covered |
| T4 Test discovery | Pass | 8 unit tests pass; all three Python conventions and Go convention covered |
| T5 Runners + registry | Pass | 15 unit tests pass with mocked spawn; ENOENT, timeout, abort, registry lookup covered |
| T6 Analysis engine | Pass | 11 unit tests pass; JSON fence extraction, parse error, cap enforcement, missing-field drop covered |
| T7 Mutation runner | Pass | 8 unit tests pass; restore-on-success, restore-on-abort, invalid skip, concurrent guard, onUpdate count covered |
| T8 Result builder | Pass | 8 unit tests pass; score 75, null score, cancelled flag, surviving-first ordering, zero mutants covered |
| T9 Tool registration | Pass | `index.ts` registers tool with correct schema; all error paths return named error results; typecheck clean |
| T10 Integration tests | Pass | 4 integration tests pass with real pytest and go test: killed, invalid, abort partial, go killed |

## Design Check

| Design Area / Decision | Status | Notes |
|------------------------|--------|-------|
| TD-001 Full-body replacement | Pass | `mutation.replacement` written directly to source file; no diff parsing anywhere |
| TD-002 `child_process.spawn` | Pass | `spawn` used in both runners; `pi.exec` not used; abort via `signal.addEventListener` + `SIGKILL` |
| TD-003 Sequential execution | Pass | `for` loop in `runMutations`; no parallel spawn |
| TD-004 Structured JSON output | Pass | `extractJson` handles markdown fences; `JSON.parse` on extracted string; cap enforced post-parse |
| TD-005 Language-native syntax check | Pass | `ast.parse` for Python (python3 → python fallback); `gofmt -e` for Go |
| TD-006 In-place with `.pi-mutation-bak` | Pass | `copyFileSync` backup → `writeFileSync` mutate → `copyFileSync` restore in `finally`; SIGINT/SIGTERM handler registered and removed correctly |
| Edge cases (design §8) | Pass | All 15 edge cases from design table have corresponding handling in code or tests |
| Security / permissions | Pass | No shell interpolation; argv arrays; path escape rejected; concurrent-run guard; SIGKILL residue documented in tool description |
| Accessibility | N/A | CLI tool; no UI surface beyond `onUpdate` text |

## Code Quality Check

- [x] Follows project conventions — `Record` for static lookups, `Set` not misused, `Promise.withResolvers` used where applicable, no `console.log`
- [x] No obvious duplication
- [x] Error/loading/empty states handled — all error paths return named `errorResult`; zero-mutation case returns valid result
- [x] Types are appropriate — no `any`; type guards used for JSON parse boundary; single documented cast for omptype params
- [x] Security/privacy considerations are handled — see Design Check
- [x] Accessibility considerations are handled where relevant — N/A
- [x] No unnecessary complexity — runner injection into `runMutations` (not registry lookup inside) is the right call; keeps the mock surface clean
- [x] Tests cover important behavior and edge cases — 58 unit + 4 integration; all critical paths covered

## Verification

```text
Command: bunx tsc --noEmit
Exit code: 0
Summary: No diagnostics; strict mode clean
Verdict: PASS

Command: bun test src/__tests__/
Exit code: 0
Summary: 58 pass, 4 skip (integration, env-gated), 0 fail — 142 expect() calls across 7 files
Verdict: PASS

Command: RUN_INTEGRATION_TESTS=1 PATH="/tmp/pytest-venv/bin:$PATH" bun test src/__tests__/integration.test.ts
Exit code: 0
Summary: 4 pass, 0 fail — python killed detected, python invalid skipped, python abort partial results + file restored, go killed detected
Verdict: PASS
```

## Issues Found

### Issue 1: `extractText` type guard does not narrow correctly

- **Severity:** Low
- **File:** `src/index.ts`
- **Line:** `extractText` function
- **Problem:** The type guard `c is TextContent` filters on `c.type === "text"` but `TextContent` from `pi-ai` may have additional required fields beyond `type` and `text`. If `pi-ai` adds a required field to `TextContent` in the future, the guard will silently pass objects that don't satisfy the full interface. Currently safe because `TextContent` is `{ type: "text"; text: string }`.
- **Requirement/Task Impact:** None currently; latent type safety risk on pi-ai upgrade
- **Suggested Fix:** Add a comment noting the assumption, or use `pi-ai`'s own type guard if one is exported

### Issue 2: `checkPythonSyntax` double-spawns on syntax error

- **Severity:** Low
- **File:** `src/mutation-runner.ts`
- **Line:** `checkPythonSyntax`
- **Problem:** When `python3` exists but the file has a syntax error, the function spawns `python3 --version` as a probe before returning `false`. This is a wasted subprocess on every invalid mutant when `python3` is present (the common case). The exit code from the first spawn already distinguishes ENOENT (error event) from syntax error (non-zero close code) — the probe is unnecessary.
- **Requirement/Task Impact:** FR-005 — minor performance overhead per invalid mutant; not a correctness issue
- **Suggested Fix:** Return `false` directly on non-zero close code; only try the next binary (`python`) on ENOENT

### Issue 3: `PYTEST_BIN` env var removed from integration test but not documented

- **Severity:** Low
- **File:** `src/__tests__/integration.test.ts`
- **Line:** Header comment
- **Problem:** The header comment still references `PYTEST_BIN` as a supported env var, but the variable was removed when the implementation was fixed to use `PATH` instead. The comment is stale.
- **Requirement/Task Impact:** None — documentation only
- **Suggested Fix:** Update the header comment to say "requires pytest on PATH"

## Positive Findings

- The `inProgress` concurrent-run guard is a clean `Record<string, true>` — simple, correct, no over-engineering
- Runner injection into `runMutations` (rather than registry lookup inside) eliminates the mock-leak problem entirely and makes the dependency explicit at the call site
- `analysis-engine.ts` validates each parsed item with a proper type guard (`isMutationItem`) and drops invalid items silently — no crash on partial LLM output
- The backup/restore lifecycle in `mutation-runner.ts` is verified by integration test: original file byte-identical after run, `.pi-mutation-bak` absent
- Error messages throughout name the target and suggest a concrete fix — matches NFR-001 exactly

## Follow-Ups

- Fix Issue 2 (double-spawn in `checkPythonSyntax`) — one-line change, no spec impact
- Fix Issue 3 (stale `PYTEST_BIN` comment) — one-line change
- Consider exposing `completeSimple` model call as a separate injectable for unit-testing `index.ts` without a live model — currently untestable in isolation (acceptable for v1)

## Verdict

- [ ] Approved
- [x] Approved with follow-ups
- [ ] Needs fixes

**Reason:** All 16 FRs and 5 NFRs pass. All 10 tasks verified with evidence. Typecheck, unit, and integration suites all pass. Three issues found, all Low severity, none blocking. Follow-ups are cosmetic or minor performance.
