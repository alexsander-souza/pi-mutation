import type { TestRunner } from "../types";
import { runSpawnedTests, type SpawnRunResult } from "./spawn";

export class GoNotFoundError extends Error {
  constructor() {
    super("go not found on $PATH");
  }
}

export const goRunner: TestRunner = {
  language: "go",
  runTests({ cwd, timeoutMs, signal }): Promise<SpawnRunResult> {
    // Scope to the source file's own package (cwd), not `./...`: Go requires
    // tests in the same package, and `./...` would recurse into unrelated
    // subpackages — slower and diluting the kill signal with foreign tests.
    return runSpawnedTests({
      bin: "go",
      args: ["test", "."],
      cwd,
      timeoutMs,
      signal,
      onNotFound: () => new GoNotFoundError(),
    });
  },
};
