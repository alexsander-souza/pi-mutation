import * as fs from "node:fs";
import * as path from "node:path";
import type { DiscoveryError, ResolvedTarget } from "./types";

/**
 * Discover test files for a resolved target using language conventions.
 * Returns all matching paths, or a DiscoveryError listing every searched path.
 */
export function discoverTests(target: ResolvedTarget, cwd?: string): string[] | DiscoveryError {
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

  // Walk-up heuristic: Python only, bounded by cwd.
  // At each ancestor walks the directory tree checking for a mirrored
  // tests/ subtree: ancestor/tests/{rel-from-ancestor-to-srcdir}/test_{base}.py
  // This catches project layouts like src/tests/…/test_foo.py mirroring src/…/foo.py.
  if (target.language === "python" && cwd) {
    const stop = path.resolve(cwd);
    const walkSearched: string[] = [];
    let ancestor = dir;

    for (;;) {
      // rel is "." at the first iteration (ancestor === dir), then the
      // path component(s) from ancestor down to the source directory.
      const rel = path.relative(ancestor, dir);
      const c1 = path.join(ancestor, "tests", rel, `test_${base}.py`);
      const c2 = path.join(ancestor, "tests", rel, `${base}_test.py`);
      walkSearched.push(c1, c2);

      for (const candidate of [c1, c2]) {
        try {
          if (fs.statSync(candidate).isFile()) return [candidate];
        } catch {
          // not found — continue
        }
      }

      if (ancestor === stop) break;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break; // filesystem root
      ancestor = parent;
    }

    const allSearched = [...searchedPaths, ...walkSearched];
    return {
      kind: "not_found",
      message: `No test files found for ${target.filePath}. Searched: ${allSearched.join(", ")}`,
      searchedPaths: allSearched,
    };
  }

  return {
    kind: "not_found",
    message: `No test files found for ${target.filePath}. Searched: ${searchedPaths.join(", ")}`,
    searchedPaths,
  };
}
