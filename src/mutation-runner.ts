import { copyFileSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import type { Mutation, MutantResult, RunMutationsOpts } from "./types";

/** Tracks in-progress absolute file paths to prevent concurrent runs on the same file */
const inProgress: Record<string, true> = {};

/** Outcome symbols for streamed progress lines */
const SYMBOLS: Record<MutantResult["outcome"], string> = {
  killed: "✓",
  surviving: "✗",
  invalid: "~",
  timeout: "⏱",
  equivalent: "≡",
};

type ApplyResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * Apply a search/replace mutation against the pristine source. The mutation's
 * `original` anchor must occur exactly once, keeping the patch unambiguous.
 * A miss, ambiguity, or no-op is reported so the caller marks it `invalid`.
 */
function applyMutation(source: string, mutation: Mutation): ApplyResult {
  if (mutation.original === mutation.mutated) {
    return { ok: false, reason: "no-op patch (original == mutated)" };
  }
  const first = source.indexOf(mutation.original);
  if (first === -1) {
    return { ok: false, reason: "original snippet not found in source" };
  }
  if (source.indexOf(mutation.original, first + 1) !== -1) {
    return { ok: false, reason: "original snippet is ambiguous (matches multiple locations)" };
  }
  const content =
    source.slice(0, first) + mutation.mutated + source.slice(first + mutation.original.length);
  return { ok: true, content };
}

async function checkPythonSyntax(filePath: string): Promise<boolean> {
  for (const bin of ["python3", "python"]) {
    const { promise, resolve } = Promise.withResolvers<"ok" | "syntax_error" | "not_found">();
    const child = spawn(
      bin,
      ["-c", `import ast; ast.parse(open(${JSON.stringify(filePath)}).read())`],
      { stdio: "pipe" },
    );
    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "ENOENT" ? "not_found" : "syntax_error");
    });
    child.on("close", (code) => resolve(code === 0 ? "ok" : "syntax_error"));

    const result = await promise;
    if (result === "ok") return true;
    if (result === "syntax_error") return false; // binary exists, file is invalid — stop
    // "not_found": try next binary
  }
  return false;
}

async function checkGoSyntax(filePath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("gofmt", ["-e", filePath], { stdio: "pipe" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function validateSyntax(filePath: string, language: "python" | "go"): Promise<boolean> {
  return language === "python" ? checkPythonSyntax(filePath) : checkGoSyntax(filePath);
}

/**
 * Run all mutations sequentially against the target file.
 * Original file is backed up to <file>.pi-mutation-bak before the first mutation
 * and restored in a finally block on all exit paths (success, abort, error).
 */
export async function runMutations(opts: RunMutationsOpts): Promise<MutantResult[]> {
  const { sourcePath, language, mutations, testFiles, cwd, timeoutMs, signal, onUpdate, runner, checkEquivalence } = opts;
  const bakPath = sourcePath + ".pi-mutation-bak";

  if (inProgress[sourcePath]) {
    throw new Error(`A mutation run is already in progress for ${sourcePath}.`);
  }

  inProgress[sourcePath] = true;

  // Safety net for catchable termination signals: restore the original file,
  // remove our listeners, then re-raise so the host's own signal handling (or
  // the default action) runs. We never call process.exit ourselves — doing so
  // would hijack the host's shutdown. Cancellation of a normal run flows through
  // the AbortSignal, not through these handlers.
  const signalHandler = (sig: NodeJS.Signals): void => {
    try {
      copyFileSync(bakPath, sourcePath);
      rmSync(bakPath, { force: true });
    } catch {
      // best-effort restore
    }
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    process.kill(process.pid, sig);
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  const results: MutantResult[] = [];

  try {
    // Snapshot the pristine source once; every patch applies against this,
    // never against an already-mutated file.
    const originalSource = readFileSync(sourcePath, "utf8");
    // Create backup before touching the source file
    copyFileSync(sourcePath, bakPath);

    for (let i = 0; i < mutations.length; i++) {
      if (signal.aborted) break;

      const mutation = mutations[i];
      const n = `${i + 1}/${mutations.length}`;

      // Apply the search/replace patch against the pristine source
      const applied = applyMutation(originalSource, mutation);
      if (!applied.ok) {
        results.push({ mutation, outcome: "invalid", note: applied.reason });
        onUpdate?.(`${SYMBOLS.invalid} mutant ${n} — "${mutation.description}" — invalid: ${applied.reason}`);
        continue;
      }
      writeFileSync(sourcePath, applied.content, "utf8");

      // Syntax validation — skip test run if the patch produced invalid code
      const syntaxOk = await validateSyntax(sourcePath, language);
      if (!syntaxOk) {
        copyFileSync(bakPath, sourcePath); // restore before next mutation
        results.push({ mutation, outcome: "invalid", note: "patch produced invalid syntax" });
        onUpdate?.(`${SYMBOLS.invalid} mutant ${n} — "${mutation.description}" — invalid: syntax error after patch`);
        continue;
      }

      // FR-progress: announce the test run before the (potentially slow) suite
      // so the user is not left without feedback while it executes.
      onUpdate?.(`▶ mutant ${n} — "${mutation.description}" — running tests…`);

      let outcome: MutantResult["outcome"];
      let testOutput: string | undefined;

      try {
        const runResult = await runner.runTests({
          sourceFile: sourcePath,
          testFiles,
          cwd: path.dirname(sourcePath),
          timeoutMs,
          signal,
        });
        if (runResult.timedOut) {
          outcome = "timeout";
        } else {
          outcome = runResult.killed ? "killed" : "surviving";
          if (runResult.killed) testOutput = runResult.output;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          break; // finally restores the original
        }
        // Fatal (e.g. test runner not on PATH) — propagate; finally restores + cleans up
        throw err;
      }

      // Restore original before next mutation
      copyFileSync(bakPath, sourcePath);

      // Equivalence gate: a survivor may be semantically equivalent to the
      // original (unkillable). Reclassify it so it is excluded from the score
      // and never resurfaced for retesting — this is what lets the fix-and-
      // retest loop terminate instead of chasing an unkillable mutant forever.
      let note: string | undefined;
      if (outcome === "surviving" && checkEquivalence && !signal.aborted) {
        onUpdate?.(`? mutant ${n} — "${mutation.description}" — checking equivalence…`);
        const verdict = await checkEquivalence(mutation);
        if (verdict?.equivalent) {
          outcome = "equivalent";
          note = verdict.rationale;
        }
      }

      results.push({ mutation, outcome, testOutput, note });

      const label =
        outcome === "killed"
          ? "killed by test suite"
          : outcome === "surviving"
            ? "survived"
            : outcome === "timeout"
              ? "timed out"
              : outcome === "equivalent"
                ? "equivalent (unkillable, excluded)"
                : "invalid";
      onUpdate?.(`${SYMBOLS[outcome]} mutant ${n} — "${mutation.description}" — ${label}`);
    }
  } finally {
    // Always restore original and clean up backup
    try {
      copyFileSync(bakPath, sourcePath);
    } catch {
      // Backup may not exist if copyFileSync failed at the start
    }
    try {
      rmSync(bakPath, { force: true });
    } catch {
      // Best-effort cleanup
    }
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    delete inProgress[sourcePath];
  }

  return results;
}
