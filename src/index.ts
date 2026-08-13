import { readFileSync } from "fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { Context, TextContent } from "@oh-my-pi/pi-ai";
import { resolveTarget } from "./target-resolver";
import { discoverTests } from "./test-discovery";
import { analyzeAndGenerate } from "./analysis-engine";
import { runMutations } from "./mutation-runner";
import { buildResult } from "./result-builder";
import { getRunner } from "./runners/index";
import type { MutationRunResult } from "./types";

const DEFAULT_MAX_MUTATIONS: Record<"function" | "file", number> = {
  function: 10,
  file: 20,
};

// Omptype's Static<TSchema> resolves to unknown for JSON-schema (non-arktype) parameters.
// The zod schema above is the authoritative runtime contract; this type matches it exactly.
interface RunMutationTestsParams {
  target: string;
  scope?: "function" | "file";
  max_mutations?: number;
  timeout_ms?: number;
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
          score: null,
          mutants: [],
          suggestions: [],
        };
        return {
          content: [{ type: "text" as const, text: "Cancelled before any mutations ran." }],
          details: empty,
        };
      }

      // FR-016: budget warning when caller raises cap above default
      if (params.max_mutations !== undefined && params.max_mutations > defaultCap) {
        onUpdate?.({
          content: [{
            type: "text" as const,
            text: `⚠ max_mutations=${params.max_mutations} exceeds the default cap of ${defaultCap} for ${scope} scope — this run may be slow.`,
          }],
        });
      }

      // FR-001 / FR-002 / FR-011: resolve target
      const resolved = resolveTarget(params.target, ctx.cwd);
      if ("kind" in resolved) {
        return errorResult(resolved.message, { error: resolved.kind });
      }

      // FR-013: discover test files
      const testFiles = discoverTests(resolved);
      if (!Array.isArray(testFiles)) {
        return errorResult(
          `No test files found for "${params.target}". Looked for:\n${testFiles.searchedPaths.map((p) => `  ${p}`).join("\n")}`,
          { error: "no_tests_found", searchedPaths: testFiles.searchedPaths },
        );
      }

      // NFR-005: runner lookup (always present for python/go — defensive)
      const runner = getRunner(resolved.language);
      if (!runner) {
        return errorResult(
          `No test runner registered for language "${resolved.language}".`,
          { error: "no_runner" },
        );
      }

      // Read source and test file contents for LLM analysis
      const sourceCode = readFileSync(resolved.filePath, "utf8");
      const testCode = testFiles.map((f) => readFileSync(f, "utf8")).join("\n\n");

      // FR-003 / FR-004 / FR-015: hotspot analysis + mutation generation
      const model = ctx.models.current();
      if (!model) {
        return errorResult("No active model in this session. Cannot run mutation analysis.", { error: "no_model" });
      }

      const mutations = await analyzeAndGenerate({
        sourceCode,
        testCode,
        target: params.target,
        scope,
        maxMutations,
        language: resolved.language,
        llmCall: async (prompt) => {
          const context: Context = {
            messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          };
          const response = await completeSimple(model, context);
          return extractText(response.content);
        },
      });

      if (!Array.isArray(mutations)) {
        return errorResult(
          `Failed to parse mutation plan from LLM response. Try a narrower scope or a smaller target. (${mutations.message})`,
          { error: mutations.kind },
        );
      }

      // FR-005–FR-009, FR-012, FR-014: execute mutations
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
    },
  });
}
