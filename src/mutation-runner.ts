import { copyFileSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import type { Mutation, MutantResult, RunMutationsOpts } from "./types";

/** Tracks in-progress absolute file paths to prevent concurrent runs on the same file */
const inProgress: Record<string, true> = {};

/**
 * Active runs that must restore their backup if the process receives a
 * catchable termination signal, keyed by absolute source path → backup path.
 * One shared handler restores every active run and re-raises, instead of each
 * concurrent run stacking its own SIGINT/SIGTERM listeners.
 */
const activeBackups = new Map<string, string>();
let signalHandlersInstalled = false;

function restoreAllOnSignal(sig: NodeJS.Signals): void {
  for (const [source, bak] of activeBackups) {
    try {
      copyFileSync(bak, source);
      rmSync(bak, { force: true });
    } catch {
      // best-effort restore
    }
  }
  activeBackups.clear();
  process.off("SIGINT", restoreAllOnSignal);
  process.off("SIGTERM", restoreAllOnSignal);
  signalHandlersInstalled = false;
  // Never call process.exit ourselves — re-raise so the host's own signal
  // handling (or the default action) runs.
  process.kill(process.pid, sig);
}

function trackBackup(source: string, bak: string): void {
  activeBackups.set(source, bak);
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("SIGINT", restoreAllOnSignal);
  process.on("SIGTERM", restoreAllOnSignal);
}

function untrackBackup(source: string): void {
  activeBackups.delete(source);
  if (activeBackups.size > 0 || !signalHandlersInstalled) return;
  process.off("SIGINT", restoreAllOnSignal);
  process.off("SIGTERM", restoreAllOnSignal);
  signalHandlersInstalled = false;
}

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

/**
 * Candidate Python interpreter argv-prefixes to try for a `-c` syntax check,
 * in priority order, derived from the test command when possible. A project
 * that runs tests via `uv run pytest` or a venv `pytest` may have no bare
 * `python`/`python3` on PATH, so prefer the interpreter implied by the command.
 */
function pythonInterpreterCandidates(command?: string): string[][] {
  const candidates: string[][] = [];
  if (command) {
    const parts = command.trim().split(/\s+/);
    const bin = parts[0];
    const base = path.basename(bin);
    if (base.startsWith("python")) {
      candidates.push([bin]);
    } else if (base === "uv" && parts[1] === "run") {
      candidates.push(["uv", "run", "python"]);
    } else if (base === "pytest" || base.endsWith("-pytest")) {
      // e.g. ".venv/bin/pytest" → sibling interpreter ".venv/bin/python3"
      const dir = path.dirname(bin);
      if (dir && dir !== ".") {
        candidates.push([path.join(dir, "python3")], [path.join(dir, "python")]);
      }
    }
  }
  candidates.push(["python3"], ["python"]);
  return candidates;
}

/**
 * Best-effort Python syntax check. Returns false only when an interpreter is
 * found AND the file fails to parse. When no interpreter is available at all we
 * cannot verify — fail OPEN (return true) and let the test run decide, instead
 * of misreporting every patch as a syntax error.
 */
async function checkPythonSyntax(filePath: string, command?: string): Promise<boolean> {
  const script = `import ast; ast.parse(open(${JSON.stringify(filePath)}).read())`;
  for (const prefix of pythonInterpreterCandidates(command)) {
    const { promise, resolve } = Promise.withResolvers<"ok" | "syntax_error" | "not_found">();
    const child = spawn(prefix[0], [...prefix.slice(1), "-c", script], { stdio: "pipe" });
    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "ENOENT" ? "not_found" : "syntax_error");
    });
    child.on("close", (code) => resolve(code === 0 ? "ok" : "syntax_error"));

    const result = await promise;
    if (result === "ok") return true;
    if (result === "syntax_error") return false; // interpreter exists, file is invalid — stop
    // "not_found": try the next candidate
  }
  return true; // no interpreter available — cannot verify, fail open
}

async function checkGoSyntax(filePath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("gofmt", ["-e", filePath], { stdio: "pipe" });
    // gofmt missing → cannot verify; fail open and let `go test` decide.
    child.on("error", (err: NodeJS.ErrnoException) => resolve(err.code === "ENOENT"));
    child.on("close", (code) => resolve(code === 0));
  });
}

function validateSyntax(filePath: string, language: "python" | "go", pythonCommand?: string): Promise<boolean> {
  return language === "python" ? checkPythonSyntax(filePath, pythonCommand) : checkGoSyntax(filePath);
}

/**
 * Run all mutations sequentially against the target file.
 * Original file is backed up to <file>.pi-mutation-bak before the first mutation
 * and restored in a finally block on all exit paths (success, abort, error).
 */
export async function runMutations(opts: RunMutationsOpts): Promise<MutantResult[]> {
  const { sourcePath, language, mutations, testFiles, cwd, timeoutMs, signal, onUpdate, runner, checkEquivalence, pythonCommand } = opts;
  const bakPath = sourcePath + ".pi-mutation-bak";

  if (inProgress[sourcePath]) {
    throw new Error(`A mutation run is already in progress for ${sourcePath}.`);
  }

  inProgress[sourcePath] = true;

  const results: MutantResult[] = [];

  try {
    // Snapshot the pristine source once; every patch applies against this,
    // never against an already-mutated file.
    const originalSource = readFileSync(sourcePath, "utf8");
    // Create backup before touching the source file
    copyFileSync(sourcePath, bakPath);
    trackBackup(sourcePath, bakPath);

    for (let i = 0; i < mutations.length; i++) {
      if (signal.aborted) break;

      const mutation = mutations[i];
      const n = `${i + 1}/${mutations.length}`;

      const applied = applyMutation(originalSource, mutation);
      if (!applied.ok) {
        results.push({ mutation, outcome: "invalid", note: applied.reason });
        onUpdate?.(`${SYMBOLS.invalid} mutant ${n} — "${mutation.description}" — invalid: ${applied.reason}`);
        continue;
      }
      writeFileSync(sourcePath, applied.content, "utf8");

      // Syntax validation — skip test run if the patch produced invalid code
      const syntaxOk = await validateSyntax(sourcePath, language, pythonCommand);
      if (!syntaxOk) {
        copyFileSync(bakPath, sourcePath); // restore before next mutation
        results.push({ mutation, outcome: "invalid", note: "patch produced invalid syntax" });
        onUpdate?.(`${SYMBOLS.invalid} mutant ${n} — "${mutation.description}" — invalid: syntax error after patch`);
        continue;
      }

      // Announce the test run before the (potentially slow) suite so the user is
      // not left without feedback while it executes.
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
    untrackBackup(sourcePath);
    delete inProgress[sourcePath];
  }

  return results;
}
