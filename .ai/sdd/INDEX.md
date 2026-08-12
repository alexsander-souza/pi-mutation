# SDD Index

> Status: Active
> Last Updated: 2026-08-12

## Steering

| Document | Path | Status |
|----------|------|--------|
| Product | `.ai/steering/product.md` | draft |
| Tech Stack | `.ai/steering/tech-stack.md` | draft |
| Conventions | `.ai/steering/conventions.md` | draft |
| Principles | `.ai/steering/principles.md` | missing |

## Upstream Handoffs

| Artifact | Path | Status |
|----------|------|--------|
| Strategy Brief | `.ai/strategy/handoff/strategy-brief.md` | missing |

## Plan

| Artifact | Path | Status |
|----------|------|--------|
| Plan | `.ai/sdd/PLAN.md` | missing |

## Ideas

| ID | Name | Status | Path |
|----|------|--------|------|
| 001 | LLM-Backed Mutation Testing Engine | idea:captured | `.ai/sdd/ideas/001-llm-backed-mutation-engine.md` |

## Feature Workspace

> Numbering source: actual directories under `.ai/sdd/specs/`, not this index.

| Field | Value | Notes |
|-------|-------|-------|
| Next Feature ID | 001 | Recompute from filesystem before creating a new spec |
| Numbering Issues | none | |

## Specs

| ID | Feature | Status | Requirements | Design | Tasks | Review |
|----|---------|--------|--------------|--------|-------|--------|
| 001 | run_mutation_tests | implementation:done | yes | yes | yes | no |

## Handoff Output

| Artifact | Path | Status |
|----------|------|--------|
| SDD Brief | `.ai/sdd/handoff/sdd-brief.md` | missing |

## Next Actions

- [ ] Update `product.md` and `tech-stack.md` to reflect LLM-backed engine direction (see idea steering impact)
- [ ] `/skill:sdd-prd` for core `run_mutation_tests` tool
