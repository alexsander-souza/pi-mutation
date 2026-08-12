# Product Steering

> Status: Draft
> Last Updated: 2026-08-12

## Product Vision

pi-mutation is an Oh My Pi plugin that brings LLM-backed mutation testing into the coding assistant workflow. Instead of wrapping existing mutation tools, it uses the LLM as the mutation engine — identifying the code spots most likely to expose test gaps and generating a small set of semantically meaningful mutations. The native test runner (pytest or go test) verifies each mutant; results stream back in real time with actionable improvement suggestions.

## Problem We Solve

- Developers cannot easily tell whether their tests catch real bugs, only that tests pass.
- Mutation testing tools exist but require context-switching out of the coding workflow.
- LLMs generating code have no signal about whether the generated tests are meaningful.

## Target Users / Personas

### Developer using OMP

- **Who:** Software engineer with an existing test suite, using OMP as a coding assistant.
- **Needs:** Confidence that tests would fail if code broke.
- **Pains:** Mutation testing setup is manual, slow, and disconnected from the coding session.
- **Goals:** Know which parts of the codebase are under-tested; get actionable recommendations.
- **Current alternatives:** Running mutmut / gremlins independently — mechanical operators, hundreds of mutations, slow runs, noisy results.

## Value Proposition

Mutation testing is surfaced as a first-class LLM tool — the assistant analyzes code semantics, generates only the mutations that matter, streams results as each test run completes, and immediately suggests the missing tests for surviving mutants. Dramatically fewer test suite executions than traditional tools.

## Core Use Cases

| Use Case | Primary Persona | Value |
|----------|-----------------|-------|
| Run mutation tests on a target file or module | Developer using OMP | Discover weak tests without context-switching |
| Query surviving mutants | Developer using OMP | Understand exactly what tests missed |
| Recommend test improvements based on surviving mutants | Developer using OMP | Actionable coverage fixes from the assistant |

## Product Boundaries

### In Scope

- Registering LLM-callable tools to trigger and report mutation test runs.
- Parsing and surfacing mutation test results (surviving, killed, timeout, error).
- LLM-backed hotspot analysis: identifying the code locations most likely to expose test gaps.
- Targeted mutation generation: a small set of semantically meaningful patches per run.
- Patch validation before execution: invalid patches are skipped and reported, not run.
- Streaming execution via native test runners (pytest, go test) — no external mutation tool.
- Pluggable runner architecture: Python and Go first, extensible for future languages.
- Surviving mutant explanations and test improvement suggestions.

### Out of Scope

- Implementing a traditional syntactic mutation engine (operator-based exhaustive generation).
- IDE/editor integrations beyond OMP.
- CI/CD pipeline integration (may be future scope).

## Success Metrics

| Metric | Target / Signal | Why It Matters |
|--------|-----------------|----------------|
| Mutation score surfaced in session | LLM can read and reason about it | Core value |
| Surviving mutant list available as tool output | Structured, parseable | Enables LLM reasoning |
| Time to first result | Under 30 s for small modules | Must not feel blocking |

## Risks / Assumptions

| Risk or Assumption | Impact | Validation / Mitigation |
|--------------------|--------|-------------------------|
| Mutation runs still slow for large test suites | High | Default to function scope; stream progress; early abort via signal |
| LLM generates syntactically invalid patches | Medium | Validate before applying; skip and report invalid patches |
| LLM generates semantically equivalent mutants | Medium | Prompt engineering; hotspot analysis targets behavior-changing locations |
| LLM context window limits on large files | Medium | Chunk at function boundary; warn user to narrow scope |
| False confidence — LLM misses a real gap | Low-Medium | Explicit disclaimer: LLM-guided, not exhaustive; pair with coverage tools |

## Domain Glossary

- **Mutant:** A variant of the source code with one small syntactic change.
- **Killed mutant:** A mutant that caused at least one test to fail — good.
- **Surviving mutant:** A mutant that no test caught — a test gap.
- **Mutation score:** Percentage of mutants killed out of total generated.

## Open Questions

- Q-001 (answered): Which frameworks first? **LLM is the mutation engine; no external mutation tool. Python (pytest) and Go (go test) native test runners first.**
- Q-002 (answered): Pluggable adapter? **Yes — pluggable runner interface for test execution; new languages add a runner without touching the LLM analysis layer.**
