import * as fs from "node:fs";
import * as path from "node:path";
import type { DiscoveryError, ResolvedTarget } from "./types";

/**
 * Discover test files for a resolved target using language conventions.
 * Returns all matching paths, or a DiscoveryError listing every searched path.
 */
export function discoverTests(target: ResolvedTarget): string[] | DiscoveryError {
  const dir = path.dirname(target.filePath);
  const base = path.basename(target.filePath, path.extname(target.filePath));

  // Candidate paths in priority order.
  const searchedPaths =
    target.language === "python"
      ? [
          // same dir, test_ prefix
          path.join(dir, `test_${base}.py`),
          // same dir, _test suffix
          path.join(dir, `${base}_test.py`),
          // tests/ sibling of the source file's parent dir
          path.join(path.dirname(dir), "tests", `test_${base}.py`),
        ]
      : // go: same package, _test.go suffix
        [path.join(dir, `${base}_test.go`)];

  const found = searchedPaths.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });

  if (found.length > 0) return found;

  return {
    kind: "not_found",
    message: `No test files found for ${target.filePath}. Searched: ${searchedPaths.join(", ")}`,
    searchedPaths,
  };
}
