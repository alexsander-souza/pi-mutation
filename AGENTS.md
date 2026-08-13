# AGENTS.md

Guidance for AI coding agents working in **pi-mutation**.

## Project

pi-mutation is an [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) plugin that
provides LLM-guided mutation testing. It does **not** wrap a traditional
operator-based mutation engine — the session LLM is the mutation engine: it reads
source and tests, identifies the code locations most likely to expose test gaps,
and generates a small set of semantically meaningful mutations. Native test
runners (`pytest`, `go test`) verify each mutant; results stream back in real time
with suggestions for the missing tests.

The plugin registers one LLM-callable tool, `run_mutation_tests`, plus a bundled
`mutation-testing` skill under `skills/`.

## Stack

- **Runtime:** Bun (Node-compatible). TypeScript, ESM (`"type": "module"`).
- **Host SDK:** `@oh-my-pi/pi-coding-agent` — `ExtensionAPI`.
- **Schema builder:** `pi.zod` (omptype Zod-compatible builder) for tool parameters.
- **Manifest:** `package.json → omp.extensions` points to `./src/index.ts`.
- **No external mutation tool** — only native test runners (`pytest`, `go test`).
- **No runtime dependencies** — devDependencies only (types + typescript).

## Commands

```sh
bun install                    # install dev dependencies
bun run typecheck              # bunx tsc --noEmit — MUST pass before done
bun test src/__tests__/        # unit tests
bun run test:integration       # RUN_INTEGRATION_TESTS=1; needs pytest + go on PATH
```

Integration tests are env-gated (`RUN_INTEGRATION_TESTS=1`) and skipped otherwise,
so they pass in CI without the language toolchains installed.

## Architecture

Single tool, four-phase pipeline inside one `execute()` call:
resolve target → discover tests → LLM hotspot analysis + mutation generation →
apply/run/restore per mutant (streaming via `onUpdate`) → aggregate result.

```text
src/
  index.ts             # Extension factory; registers run_mutation_tests. No business logic.
  types.ts             # Shared interfaces (Mutation, MutantResult, TestRunner, ...).
  target-resolver.ts   # Target string -> abs file path + language + optional symbol. Pure.
  test-discovery.ts    # Locate test files for a target (Python/Go conventions). FS read only.
  analysis-engine.ts   # LLM hotspot analysis + mutation generation; enforces max_mutations cap.
  mutation-runner.ts   # Backup -> mutate in place -> spawn runner -> restore. Signal/timeout.
  result-builder.ts    # Aggregate per-mutant results into final structured result. Pure.
  runners/
    index.ts           # RunnerRegistry: language -> TestRunner.
    python.ts          # PythonRunner: pytest subprocess.
    go.ts              # GoRunner: go test subprocess.
  __tests__/           # Unit + integration tests.
skills/mutation-testing/SKILL.md   # Bundled OMP workflow skill.
```

Mutations are minimal search/replace patches (`original` -> `mutated`), never
full-file bodies, to keep LLM output small. Adding a language = implement a
`TestRunner` and register it in `runners/index.ts`; touch nothing else.

### Mutation file lifecycle (critical safety invariant)

Mutations are applied **in place** to the original source file. The original is
backed up to `<file>.pi-mutation-bak` before the first mutation and **restored on
every exit path** — success, invalid patch, timeout, abort, and error (via a
`finally` block plus `SIGINT`/`SIGTERM` handlers). Only `SIGKILL` can leave a
mutated file behind; the backup filename is intentionally greppable
(`*.pi-mutation-bak`) for manual recovery (`mv <file>.pi-mutation-bak <file>`).
Never weaken this restore guarantee.

## Conventions

- TypeScript strict mode. No `any` unless justified in a comment. Prefer `const`.
- **Tool `execute` returns errors as values** (`{ isError: true, content: [...] }`)
  — never throw to the caller.
- **No `console.log`** — use `pi.logger` for debug output.
- Registration (tools, commands, handlers) happens **synchronously** in the
  factory. Runtime actions (`pi.sendMessage`, etc.) happen only inside
  `execute`/event/command handlers — **never at module load**.
- Use `ctx.setInterval`/`ctx.setTimeout`, **never** raw `setInterval`/`setTimeout`.
- Check `signal?.aborted` before long-running work; subprocesses MUST respect
  `signal` for cancellation. Subprocess args passed as an argv array — **no shell
  interpolation**.
- Resolve `target` to an absolute path under `ctx.cwd`; reject paths that escape it.
- Don't expose raw source in tool result `content` beyond what was requested.

### Extension factory pattern

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function piMutation(pi: ExtensionAPI) {
  // Register tools, commands, event handlers here.
  // Never call runtime actions (sendMessage, etc.) at this level.
}
```

### Naming

| Item                | Convention   | Example                |
|---------------------|--------------|------------------------|
| Tool names          | `snake_case` | `run_mutation_tests`   |
| Command names       | `kebab-case` | `mutation-report`      |
| TypeScript files    | `kebab-case` | `mutation-runner.ts`   |
| Exported functions  | `camelCase`  | `parseMutationReport`  |
| Types / interfaces  | `PascalCase` | `MutationResult`       |

## Testing

- Tests live in `src/__tests__/` (Bun test runner).
- Unit-test pure functions (resolvers, discovery, result builder, cap enforcement).
- Mock subprocess calls in unit tests; avoid mocking `ExtensionAPI` internals.
- Integration tests for real runners are gated behind `RUN_INTEGRATION_TESTS=1`.
- Verification evidence (typecheck + tests) is required before marking work done.

## Anti-patterns

- Calling `pi.sendMessage`/`pi.exec` during module load (throws
  `ExtensionRuntimeNotInitializedError`).
- Raw `setInterval`/`setTimeout` in extension code.
- Swallowing subprocess errors silently — surface them as `isError` results.
- Full-file mutation bodies instead of minimal search/replace patches.
- Any code path that mutates the source file without a guaranteed backup restore.

## SDD workflow

This project uses Spec-Driven Development under `.ai/`. Durable context lives in
`.ai/steering/` (`product.md`, `tech-stack.md`, `conventions.md`); feature specs
live in `.ai/sdd/specs/NNN-feature-name/` (`requirements.md` → `design.md` →
`tasks.md` → `review.md`), gated by each spec's `.status` file. Flow:
`IDEA → PLAN → PRD → SPEC → TASKS → EXEC → REVIEW`. Human approval is required for
requirements, design, and tasks before the next phase — no implementation code
before `tasks:approved`. See `.ai/sdd/WORKFLOW.md` and `.ai/sdd/INDEX.md`.
