import { copyFileSync, rmSync, writeFileSync } from "fs";
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
};

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
  const { sourcePath, language, mutations, testFiles, cwd, timeoutMs, signal, onUpdate, runner } = opts;
  const bakPath = sourcePath + ".pi-mutation-bak";

  if (inProgress[sourcePath]) {
    throw new Error(`A mutation run is already in progress for ${sourcePath}.`);
  }

  inProgress[sourcePath] = true;

  // Register signal handler to restore backup on SIGINT/SIGTERM
  const signalHandler = (): void => {
    try {
      copyFileSync(bakPath, sourcePath);
      rmSync(bakPath, { force: true });
    } finally {
      process.exit(1);
    }
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  const results: MutantResult[] = [];

  try {
    // Create backup before touching the source file
    copyFileSync(sourcePath, bakPath);

    for (let i = 0; i < mutations.length; i++) {
      if (signal.aborted) break;

      const mutation = mutations[i];
      const n = `${i + 1}/${mutations.length}`;

      // Write mutation in-place
      writeFileSync(sourcePath, mutation.replacement, "utf8");

      // Syntax validation — skip test run if invalid
      const syntaxOk = await validateSyntax(sourcePath, language);
      if (!syntaxOk) {
        copyFileSync(bakPath, sourcePath); // restore before next mutation
        const result: MutantResult = { mutation, outcome: "invalid" };
        results.push(result);
        onUpdate?.(`${SYMBOLS.invalid} mutant ${n} — "${mutation.description}" — invalid syntax, skipped`);
        continue;
      }

      // Run tests
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
        outcome = runResult.killed ? "killed" : "surviving";
        if (runResult.killed) testOutput = runResult.output;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Restore before re-throwing so finally block sees clean state
          copyFileSync(bakPath, sourcePath);
          break;
        }
        // Unexpected runner error — treat as timeout
        outcome = "timeout";
      }

      // Restore original before next mutation
      copyFileSync(bakPath, sourcePath);

      if (outcome! === "timeout" && testOutput === undefined) {
        // Distinguish subprocess timeout from other errors
        outcome = "timeout";
      }

      const result: MutantResult = { mutation, outcome: outcome!, testOutput };
      results.push(result);

      const label =
        outcome === "killed"
          ? "killed by test suite"
          : outcome === "surviving"
            ? "survived"
            : outcome === "timeout"
              ? "timed out"
              : "invalid";
      onUpdate?.(`${SYMBOLS[outcome!]} mutant ${n} — "${mutation.description}" — ${label}`);
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
