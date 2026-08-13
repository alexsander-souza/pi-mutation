import type { TestRunner } from "../types";
import { runSpawnedTests, type SpawnRunResult } from "./spawn";

export class PythonNotFoundError extends Error {
  constructor(command: string) {
    super(`test command not found on $PATH: ${command}`);
  }
}

/**
 * Create a Python test runner that invokes the given command.
 * `command` is split on whitespace: "uv run pytest" → spawn("uv", ["run", "pytest", ...testFiles, ...flags]).
 * Defaults to "pytest" when omitted.
 */
export function makePythonRunner(command: string = "pytest"): TestRunner {
  const parts = command.trim().split(/\s+/);
  const bin = parts[0];
  const prefixArgs = parts.slice(1);

  return {
    language: "python",
    runTests({ testFiles, cwd, timeoutMs, signal }): Promise<SpawnRunResult> {
      return runSpawnedTests({
        bin,
        args: [...prefixArgs, ...testFiles, "--tb=short", "-q"],
        cwd,
        timeoutMs,
        signal,
        onNotFound: () => new PythonNotFoundError(command),
      });
    },
  };
}

export const pythonRunner: TestRunner = makePythonRunner();
