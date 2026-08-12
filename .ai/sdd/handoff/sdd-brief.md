# SDD Handoff Brief

> Generated: 2026-08-12
> Readiness: **ready for implementation**

## Feature

| Field | Value |
|-------|-------|
| ID | 001 |
| Name | run_mutation_tests |
| Status | tasks:approved |

## Source Artifacts

| Artifact | Path |
|----------|------|
| Requirements | `.ai/sdd/specs/001-run-mutation-tests/requirements.md` |
| Design | `.ai/sdd/specs/001-run-mutation-tests/design.md` |
| Tasks | `.ai/sdd/specs/001-run-mutation-tests/tasks.md` |
| Status | `.ai/sdd/specs/001-run-mutation-tests/.status` |
| Idea (upstream) | `.ai/sdd/ideas/001-llm-backed-mutation-engine.md` |

## What to Build

A single OMP extension tool `run_mutation_tests` that:

1. Resolves a `target` (file path or symbol name) to a source file + language (Python or Go)
2. Discovers relevant test files by language convention
3. Calls the LLM to identify mutation hotspots and generate targeted full-body replacement patches
4. For each mutation: backs up the original file, writes the mutation in-place, runs the native test runner (pytest / go test), restores the original
5. Streams progress via `onUpdate` after each mutant
6. Returns a structured result: killed / surviving / invalid / timeout counts, mutation score, surviving mutant explanations, and test improvement suggestions

## Key Architectural Constraints

- Mutations written in-place; original backed up to `<file>.pi-mutation-bak`; restored in `finally` + SIGINT/SIGTERM handler
- Only one concurrent run per file (module-level `Set<string>` guard)
- Subprocess spawned via `child_process.spawn` with argv array — never shell strings
- Per-mutation timeout: 60 s default, configurable via `timeout_ms`
- `max_mutations` hard cap enforced by extension post-LLM, not by prompt: 10 (function) / 20 (file)
- Abort signal: checked before each mutant; kills in-flight subprocess; returns partial results with `cancelled: true`
- Syntax validation before test run: `python3 -c "import ast; ast.parse(...)"` / `gofmt -e`
- Original file must be byte-identical after every run, success or failure

## Implementation Order

```
T1 scaffold → T2 types → [T3 resolver, T4 discovery, T5 runners, T6 analysis, T8 result-builder]
                        → T7 mutation-runner → T9 index.ts → T10 integration tests
```

T3–T6 and T8 are parallel-safe after T2.

## Likely Files

| File | Action |
|------|--------|
| `package.json` | create |
| `tsconfig.json` | create |
| `src/index.ts` | create |
| `src/types.ts` | create |
| `src/target-resolver.ts` | create |
| `src/test-discovery.ts` | create |
| `src/analysis-engine.ts` | create |
| `src/mutation-runner.ts` | create |
| `src/result-builder.ts` | create |
| `src/runners/index.ts` | create |
| `src/runners/python.ts` | create |
| `src/runners/go.ts` | create |
| `src/__tests__/*.test.ts` | create (per task) |
| `fixtures/python/` | create (T10) |
| `fixtures/go/` | create (T10) |

## Verification Plan

| Level | Command | Gate |
|-------|---------|------|
| Typecheck | `npx tsc --noEmit` | Every task |
| Unit tests | `node --test src/__tests__/<module>.test.ts` | T3–T8 |
| Integration tests | `RUN_INTEGRATION_TESTS=1 node --test src/__tests__/integration.test.ts` | T10 only; env-gated |

## Blockers

None. All requirements approved, design approved, tasks approved, no open questions.

## Notes for Implementer

- LLM returns a JSON array of `Mutation` objects; extension parses and slices to `max_mutations` — do not rely on the LLM to self-cap
- `pi.exec()` is not used; `pi.exec` abort semantics are undocumented — `child_process.spawn` with manual `AbortSignal` wiring is the approved approach (TD-002)
- `python3` falls back to `python` on ENOENT for the syntax check
- Tool result `content` is human-readable text; `details` carries the structured `MutationRunResult` for LLM reasoning
