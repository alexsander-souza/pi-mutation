# Tech Stack Steering

> Status: Draft
> Last Updated: 2026-08-12

## Runtime / Platform

- **Runtime:** Node.js (LTS)
- **Language:** TypeScript
- **Package manager:** TBD — see Open Questions
- **Deployment target:** OMP plugin — installed via `omp plugin install` or `npm install`
- **Monorepo:** No (single plugin package)

## Extension API

- **Host SDK:** `@oh-my-pi/pi-coding-agent` (`ExtensionAPI`)
- **Schema builder:** `pi.zod` (omptype Zod-compatible builder)
- **Manifest field:** `package.json → omp.extensions`
- **Entry point convention:** `src/index.ts` (or `index.ts` at root)

## Mutation Engine

> The plugin is the mutation engine — no external mutation tool required.

| Concern | Approach |
|---------|----------|
| Hotspot analysis | LLM reads source + tests; identifies risky logic and boundary conditions |
| Mutation authoring | LLM generates targeted code patches at identified hotspots |
| Patch validation | Syntactic check before applying; invalid patches skipped and reported |
| Test execution | Native test runner subprocess — `pytest` (Python), `go test` (Go) |
| Result streaming | `onUpdate` emits progress per mutant as results land |
| Runner extensibility | Pluggable runner interface; Python and Go are first implementations |

## Testing / Verification Commands

| Purpose | Command | Notes |
|---------|---------|-------|
| Install | TBD | |
| Lint | TBD | |
| Typecheck | `tsc --noEmit` | |
| Test | TBD | |
| Build | TBD | |
| Full verify | TBD | |

## Architectural Constraints

- MUST export a default factory function matching the `ExtensionAPI` contract.
- MUST NOT call runtime action methods (`pi.sendMessage`, etc.) during module load — registration only.
- MUST use `ctx.setInterval`/`ctx.setTimeout` for any background timers; never raw `setInterval`.
- Tool `execute` functions MUST check `signal?.aborted` before long-running work.
- Subprocess invocations MUST respect `signal` for cancellation.
- MUST apply mutations to temp file copies; original source files MUST NOT be modified.
- MUST validate patch syntactic correctness before running tests; skip invalid patches.
- No external mutation tool dependency — only native test runners (pytest, go test).

## Observability / Operations

- **Logging:** `pi.logger` for extension-level debug output.
- **User feedback:** `ctx.ui.notify` for progress; `onUpdate` for streaming tool results.
- **Error surface:** Tool errors returned as `{ isError: true, content: [...] }`, not thrown.

## Technical Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| TD-001 | LLM is the mutation engine | Avoids combinatorial explosion of traditional tools; generates semantically meaningful mutations only |
| TD-002 | Pluggable runner interface | Python and Go first; new language support plugs in without touching tool definitions or the LLM analysis layer |
| TD-003 | Temp-file mutation isolation | Original source files are never modified; each mutant applied to a fresh temp copy |

## Open Questions

- Q-001 (open): npm vs pnpm as the package manager?
- Q-002 (open): Should mutation runs execute via the `bash` tool / `ctx.exec`, or a direct `child_process` spawn inside `execute`?
- Q-003 (answered): Framework strategy — **LLM-backed engine; no external mutation tool. Native test runners only (pytest, go test). Pluggable runner for future languages.**
