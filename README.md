# pi-mutation

LLM-guided mutation testing plugin for [Oh My Pi](https://github.com/can1357/oh-my-pi).

Instead of wrapping a traditional operator-based mutation engine, pi-mutation uses
the session LLM as the mutation engine: it analyzes source and tests, identifies the
code locations most likely to expose test gaps, and generates a small set of
semantically meaningful mutations. The native test runner (`pytest` or `go test`)
verifies each mutant, and results stream back in real time with actionable
suggestions for missing tests.

> LLM-guided mutation testing is **not exhaustive** — it targets high-signal
> locations only. Pair it with line-coverage tools for complete verification.

## Features

- **LLM-backed hotspot analysis** — targets risky logic and boundary conditions
  rather than generating hundreds of mechanical mutations.
- **Targeted mutation generation** — a small, meaningful set of patches per run.
- **Patch validation** — syntactically invalid patches are skipped and reported,
  never executed.
- **Native test runners** — Python (`pytest`) and Go (`go test`); no external
  mutation tool required.
- **Pluggable runner architecture** — add a language by implementing a runner,
  without touching the LLM analysis layer.
- **Streaming results** — per-mutant progress emitted as each test run completes,
  plus a final structured mutation score and improvement suggestions.

## Installation

Install directly from this repository with the Oh My Pi plugin manager:

```sh
omp plugin install github:alexsander-souza/pi-mutation
```

`omp plugin install` accepts any git spec, so the full-URL forms also work:

```sh
omp plugin install https://github.com/alexsander-souza/pi-mutation
omp plugin install git@github.com:alexsander-souza/pi-mutation.git
```

The manager reads the plugin manifest from `package.json`, which declares the
extension entry point:

```json
{
  "omp": {
    "extensions": ["./src/index.ts"]
  }
}
```

Restart the session after installing so the new tool is loaded.

### Local development

For a local checkout, point `omp plugin install` at the directory — a local path
is symlinked (linked) into your plugin root rather than fetched:

```sh
bun install
omp plugin install ./pi-mutation
```

## Usage

The plugin registers a single LLM-callable tool, `run_mutation_tests`.

| Parameter       | Type                     | Default                          | Description |
|-----------------|--------------------------|----------------------------------|-------------|
| `target`        | `string`                 | —                                | File path (e.g. `src/utils.py`) or function/symbol name (e.g. `calculate_total`). Language is auto-detected from the file extension. |
| `scope`         | `"function" \| "file"`   | `"function"`                     | Analyze the named function only, or all functions in the file. |
| `max_mutations` | `number`                 | `10` (function) / `20` (file)    | Maximum mutations to run. Capped at twice the default. |
| `timeout_ms`    | `number`                 | `60000`                          | Per-mutation subprocess timeout in milliseconds. |

The tool returns a structured result: total mutations, counts of killed / surviving /
invalid / timed-out mutants, the overall mutation score, the surviving mutant list,
and test-improvement suggestions.

### Bundled skill

The package also ships a `mutation-testing` skill under `skills/`. OMP's
`omp-plugins` provider discovers it automatically when the plugin is installed, so
the assistant knows *when* to run mutation testing and drives the
surviving-mutant → write-test loop rather than just reporting a score. It is
model-selected by task context and also invocable with `/skill:mutation-testing`.

### Recovery

Mutations are applied in place and the original file is backed up to
`<file>.pi-mutation-bak`, restored on every exit path. If the OMP process is killed
with `SIGKILL` mid-run, restore the original manually:

```sh
mv <file>.pi-mutation-bak <file>
```

## Development

```sh
bun run typecheck             # tsc --noEmit
bun test src/__tests__/       # unit tests
bun run test:integration      # integration tests (requires pytest / go installed)
```

Project layout:

- `src/index.ts` — extension factory and tool registration.
- `src/target-resolver.ts` — resolve a target to a file + language.
- `src/test-discovery.ts` — locate test files for a target.
- `src/analysis-engine.ts` — LLM hotspot analysis and mutation generation.
- `src/mutation-runner.ts` — apply mutations, run tests, restore backups.
- `src/result-builder.ts` — assemble the final structured result.
- `src/runners/` — pluggable per-language test runners.
- `skills/mutation-testing/SKILL.md` — bundled OMP workflow skill.

## License

[MIT](./LICENSE) © Alexsander Silva de Souza
