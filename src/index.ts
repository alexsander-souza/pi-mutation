import { readFileSync, existsSync } from "fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { Context, TextContent } from "@oh-my-pi/pi-ai";
import { resolveTarget } from "./target-resolver";
import { discoverTests } from "./test-discovery";
import { analyzeAndGenerate, judgeEquivalence } from "./analysis-engine";
import { runMutations } from "./mutation-runner";
import { buildResult } from "./result-builder";
import { getRunner } from "./runners/index";
import { makePythonRunner } from "./runners/python";
import type { Mutation, MutationRunResult } from "./types";

const DEFAULT_MAX_MUTATIONS: Record<"function" | "file", number> = {
  function: 10,
  file: 20,
};

// Absolute ceiling on retested prior mutants — scope/max_mutations are ignored
// on the retest path, so this bounds a caller-supplied prior_mutants array.
const MAX_RETEST_MUTANTS = DEFAULT_MAX_MUTATIONS.file * 2;

// Omptype's Static<TSchema> resolves to unknown for JSON-schema (non-arktype) parameters.
interface RunMutationTestsParams {
  target: string;
  scope?: "function" | "file";
  max_mutations?: number;
  timeout_ms?: number;
  test_files?: string[];
  test_command?: string;
  prior_mutants?: Mutation[];
}

function errorResult(message: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    details,
  };
}

// TextContent from pi-ai is currently { type: "text"; text: string }.
// If pi-ai adds required fields to TextContent, this guard may pass objects
// that don't satisfy the full interface — check pi-ai's own guards on upgrade.
function extractText(content: unknown[]): string {
  return content
    .filter((c): c is TextContent => typeof c === "object" && c !== null && "type" in c && c.type === "text")
    .map((c) => c.text)
    .join("");
}

// Emit an elapsed-time heartbeat while a long single-shot async step runs, so
// the user gets steady feedback during the otherwise-silent LLM analysis call.
// Uses the host's managed timer (ctx.setInterval / ctx.clearTimer): a throw from
// the tick callback is contained by the host instead of escaping as a
// process-fatal uncaughtException, and the handle is cleared on session teardown.
async function withHeartbeat<T>(
  timers: Pick<ExtensionContext, "setInterval" | "clearTimer">,
  tick: ((text: string) => void) | null,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!tick) return work();
  const start = Date.now();
  const timer = timers.setInterval(() => {
    tick(`${label} — ${Math.round((Date.now() - start) / 1000)}s elapsed…`);
  }, 4000);
  try {
    return await work();
  } finally {
    timers.clearTimer(timer);
  }
}

export default function piMutation(pi: ExtensionAPI): void {
  pi.setLabel("pi-mutation");

  const z = pi.zod;

  pi.registerTool({
    name: "run_mutation_tests",
    label: "Run Mutation Tests",
    description: `Run LLM-guided mutation tests against a Python or Go function or file.
Generates targeted mutations at identified hotspots, runs the native test suite
for each, and returns a structured mutation score with improvement suggestions.
Note: LLM-guided mutation testing is not exhaustive — it targets high-signal
locations only. Pair with line coverage tools for complete verification.
If the OMP process is killed with SIGKILL mid-run, restore the original file
with: mv <file>.pi-mutation-bak <file>`,
    parameters: z.object({
      target: z.string().describe(
        "File path (e.g. 'src/utils.py') or function/symbol name (e.g. 'calculate_total'). " +
        "Language is auto-detected from the file extension.",
      ),
      scope: z.enum(["function", "file"]).optional().describe(
        "'function' (default): analyze the named function only. " +
        "'file': analyze all functions in the file.",
      ),
      max_mutations: z.number().int().positive().optional().describe(
        "Maximum mutations to run. Defaults: 10 for function scope, 20 for file scope.",
      ),
      timeout_ms: z.number().int().positive().optional().describe(
        "Per-mutation subprocess timeout in milliseconds. Default: 60000.",
      ),
      test_files: z.array(z.string()).optional().describe(
        "Explicit test file paths. Skips auto-discovery. Paths are resolved relative to the working directory.",
      ),
      test_command: z.string().optional().describe(
        "Command used to invoke the Python test suite. Whitespace-separated: the first token is the " +
        "binary, the rest are prepended as arguments before the test files. " +
        "Examples: '.venv/bin/pytest', 'uv run pytest', 'python -m pytest'. " +
        "Defaults to 'pytest'. Consult AGENTS.md or the project README to find the correct invocation.",
      ),
      prior_mutants: z.array(z.object({
        id: z.string(),
        description: z.string(),
        hotspot: z.string(),
        original: z.string(),
        mutated: z.string(),
        explanation: z.string(),
        suggestion: z.string(),
      })).optional().describe(
        "Surviving mutants from a previous run (pass details.mutants filtered to outcome='surviving'). " +
        "When provided the LLM analysis step is skipped and these exact mutations are retested — " +
        "use this after adding tests to prove the gaps are closed. " +
        "scope and max_mutations are ignored when prior_mutants is supplied.",
      ),
    }),

    async execute(_id, rawParams, signal, onUpdate, ctx) {
      // Static<TSchema> = unknown for JSON-schema params; schema above is the runtime contract.
      const params = rawParams as RunMutationTestsParams;
      const scope = params.scope ?? "function";
      const defaultCap = DEFAULT_MAX_MUTATIONS[scope];
      const maxMutations = Math.min(params.max_mutations ?? defaultCap, defaultCap * 2);
      const timeoutMs = params.timeout_ms ?? 60_000;

      // FR-009: pre-aborted — return immediately without touching the filesystem
      if (signal?.aborted) {
        const empty: MutationRunResult = {
          cancelled: true,
          target: params.target,
          language: "python",
          scope,
          total: 0,
          killed: 0,
          surviving: 0,
          invalid: 0,
          timeout: 0,
          equivalent: 0,
          score: null,
          mutants: [],
          suggestions: [],
        };
        return {
          content: [{ type: "text" as const, text: "Cancelled before any mutations ran." }],
          details: empty,
        };
      }

      // FR-016: budget warning when caller raises cap above default. maxMutations
      // is clamped to defaultCap*2, so report the effective count that will run.
      if (params.max_mutations !== undefined && params.max_mutations > defaultCap) {
        const clamped = maxMutations < params.max_mutations ? ` (hard cap ${defaultCap * 2})` : "";
        onUpdate?.({
          content: [{
            type: "text" as const,
            text: `⚠ max_mutations=${params.max_mutations} exceeds the default cap of ${defaultCap} for ${scope} scope — running ${maxMutations} mutation${maxMutations === 1 ? "" : "s"}${clamped}. This run may be slow.`,
          }],
        });
      }

      // FR-001 / FR-002 / FR-011: resolve target
      const resolved = resolveTarget(params.target, ctx.cwd);
      if ("kind" in resolved) {
        return errorResult(resolved.message, { error: resolved.kind });
      }

      // Symbol targets resolve to the first match in a deterministic walk;
      // surface the resolution so an ambiguous symbol is not opaque.
      if (resolved.symbol) {
        onUpdate?.({ content: [{ type: "text" as const, text: `Resolved symbol "${resolved.symbol}" → ${path.relative(ctx.cwd, resolved.filePath)}` }] });
      }

      // FR-013: discover test files (or use caller-supplied paths)
      let testFiles: string[];
      if (params.test_files && params.test_files.length > 0) {
        const resolvedPaths = params.test_files.map((f) => path.resolve(ctx.cwd, f));
        const missing = resolvedPaths.filter((p) => !existsSync(p));
        if (missing.length > 0) {
          return errorResult(
            `test_files: path(s) not found:\n${missing.map((p) => `  ${p}`).join("\n")}`,
            { error: "test_files_not_found", missing },
          );
        }
        testFiles = resolvedPaths;
      } else {
        const discovery = discoverTests(resolved, ctx.cwd);
        if (!Array.isArray(discovery)) {
          return errorResult(
            `No test files found for "${params.target}". Looked for:\n${discovery.searchedPaths.map((p) => `  ${p}`).join("\n")}`,
            { error: "no_tests_found", searchedPaths: discovery.searchedPaths },
          );
        }
        testFiles = discovery;
      }

      // NFR-005: runner lookup — Python uses a command-specific runner, Go uses the registry.
      // test_command lets the caller specify a venv path or wrapper (e.g. "uv run pytest").
      const runner =
        resolved.language === "python"
          ? makePythonRunner(params.test_command)
          : getRunner(resolved.language);
      if (!runner) {
        return errorResult(
          `No test runner registered for language "${resolved.language}".`,
          { error: "no_runner" },
        );
      }

      // Shared LLM-call closure — drives both mutation generation and the
      // survivor equivalence judge. Null when the session has no active model.
      const model = ctx.models.current();
      // Fetch the API key once per run (lazily, on first LLM call) and reuse it
      // for every mutation-generation and equivalence-judge call.
      let apiKeyPromise: Promise<string | undefined> | undefined;
      const llmCall = model
        ? async (prompt: string): Promise<string> => {
            apiKeyPromise ??= ctx.modelRegistry.authStorage.getApiKey(
              model.provider,
              undefined,
              { modelId: model.id, signal },
            );
            const apiKey = await apiKeyPromise;
            const context: Context = {
              messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
            };
            const response = await completeSimple(model, context, { apiKey, signal });
            return extractText(response.content);
          }
        : null;
      const tick = onUpdate
        ? (text: string): void => onUpdate({ content: [{ type: "text" as const, text }] })
        : null;

      // FR-003 / FR-004 / FR-015: hotspot analysis + mutation generation,
      // OR retest prior survivors without calling the LLM.
      let mutations: Mutation[];

      if (params.prior_mutants && params.prior_mutants.length > 0) {
        mutations = params.prior_mutants.slice(0, MAX_RETEST_MUTANTS);
        const capped = params.prior_mutants.length - mutations.length;
        onUpdate?.({
          content: [{ type: "text" as const, text: `Retesting ${mutations.length} prior mutant${mutations.length === 1 ? "" : "s"}${capped > 0 ? ` (capped from ${params.prior_mutants.length})` : ""} — skipping LLM analysis…` }],
        });
      } else {
        if (!llmCall) {
          return errorResult("No active model in this session. Cannot run mutation analysis.", { error: "no_model" });
        }

        // Read source and test file contents for LLM analysis
        const sourceCode = readFileSync(resolved.filePath, "utf8");
        const testCode = testFiles.map((f) => readFileSync(f, "utf8")).join("\n\n");

        const label = `Analyzing ${resolved.filePath} — generating mutation plan`;
        tick?.(`${label} (this may take a moment)…`);

        const generated = await withHeartbeat(ctx, tick, label, () =>
          analyzeAndGenerate({
            sourceCode,
            testCode,
            target: params.target,
            scope,
            maxMutations,
            language: resolved.language,
            llmCall,
          }),
        );

        if (!Array.isArray(generated)) {
          return errorResult(
            `Failed to parse mutation plan from LLM response. Try a narrower scope or a smaller target. (${generated.message})`,
            { error: generated.kind },
          );
        }

        mutations = generated;
        onUpdate?.({
          content: [{ type: "text" as const, text: `Generated ${mutations.length} mutation${mutations.length === 1 ? "" : "s"} — running test suite for each…` }],
        });
      }

      // Equivalence judge for survivors — filters unkillable false positives and
      // gives the fix-and-retest loop a terminating condition. Skipped when no
      // model is available (e.g. prior_mutants retest in a headless session).
      const checkEquivalence = llmCall
        ? (mutation: Mutation) =>
            judgeEquivalence({ mutation, language: resolved.language, llmCall })
        : undefined;

      // FR-005–FR-009, FR-012, FR-014: execute mutations and build result.
      // runMutations may throw on the concurrent-run guard, a missing test
      // runner binary, or an unexpected runner failure — surface as a named
      // error result, never thrown to the caller (conventions.md).
      try {
        const mutants = await runMutations({
          sourcePath: resolved.filePath,
          language: resolved.language,
          mutations,
          testFiles,
          cwd: ctx.cwd,
          timeoutMs,
          signal: signal ?? new AbortController().signal,
          runner,
          onUpdate: (msg) => onUpdate?.({ content: [{ type: "text" as const, text: msg }] }),
          checkEquivalence,
          pythonCommand: resolved.language === "python" ? params.test_command : undefined,
        });

        // FR-008: build and return final result
        const { content, details } = buildResult({
          mutants,
          cancelled: signal?.aborted ?? false,
          target: params.target,
          language: resolved.language,
          scope,
        });

        return {
          content: [{ type: "text" as const, text: content }],
          details,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(
          `Mutation run failed for "${params.target}": ${message}`,
          { error: "run_failed" },
        );
      }
    },
  });
}
