# Conventions Steering

> Status: Draft
> Last Updated: 2026-08-12

## Code Style

- TypeScript strict mode (`"strict": true` in tsconfig).
- No `any` unless explicitly justified in a comment.
- Prefer `const`; use `let` only when reassignment is required.
- Errors returned as values from tool `execute`; never thrown to the caller.
- No `console.log` — use `pi.logger` for debug output.

## Extension Factory Pattern

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function piMutation(pi: ExtensionAPI) {
  // Register tools, commands, and event handlers here.
  // Never call runtime actions (sendMessage, etc.) at this level.
}
```

- One default export per entry point.
- Registration (tools, commands, event handlers) happens synchronously in the factory.
- Runtime actions happen only inside event handlers, tool `execute`, or command handlers.

## Naming Conventions

| Item | Convention | Example |
|------|------------|---------|
| Tool names | `snake_case` | `run_mutation_tests` |
| Command names | `kebab-case` | `mutation-report` |
| TypeScript files | `kebab-case.ts` | `mutation-runner.ts` |
| Exported functions | `camelCase` | `parseMutationReport` |
| Types / interfaces | `PascalCase` | `MutationResult` |

## Architecture Patterns

- **Folders:** `src/` for source, `src/tools/` for tool definitions, `src/runners/` for subprocess wrappers.
- **Tool isolation:** Each tool defined in its own file; imported and registered in `index.ts`.
- **Runner abstraction:** Mutation framework CLI calls isolated behind a runner interface — enables swapping frameworks without touching tool definitions.

## Testing Rules

- Tests live in `src/__tests__/` or alongside source as `*.test.ts`.
- Unit-test pure functions (parsers, formatters, result mappers).
- Integration tests for subprocess runners may be skipped in CI without the underlying tool installed — gate with an env flag.
- Mocking policy: mock subprocess calls in unit tests; avoid mocking `ExtensionAPI` internals.

## Security / Privacy Rules

- MUST NOT expose workspace file contents in tool result `content` beyond what the user/LLM explicitly requested.
- MUST sanitize paths passed to subprocess commands to prevent injection.
- MUST NOT store mutation results outside the session (no disk writes unless explicitly required by a spec).

## Workflow Rules

- Feature work follows the SDD flow: PRD → SPEC → TASKS → EXEC → REVIEW.
- No code before `tasks:approved`.
- Verification evidence required before marking a task done.
- Commits scoped to one feature or fix; conventional commit messages preferred.

## Anti-Patterns

- Calling `pi.sendMessage` or `pi.exec` during module load (throws `ExtensionRuntimeNotInitializedError`).
- Using raw `setInterval`/`setTimeout` in extension code — always use `ctx.setInterval`/`ctx.setTimeout`.
- Swallowing subprocess errors silently — surface them as tool `isError` results.
- Inventing a mutation numbering scheme that conflicts with the underlying framework's output.

## Open Questions

- Q-001 (open): Should `src/runners/` use an interface/abstract class or simple duck typing?
