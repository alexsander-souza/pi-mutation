import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverTests } from "../test-discovery";
import type { DiscoveryError, ResolvedTarget } from "../types";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mutation-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function pythonTarget(...rel: string[]): ResolvedTarget {
  return { filePath: path.join(root, ...rel), language: "python" };
}

function touch(...rel: string[]): string {
  const p = path.join(root, ...rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
  return p;
}

describe("discoverTests — python", () => {
  it("finds same-dir test_<name>.py", () => {
    const testFile = touch("pkg", "test_utils.py");
    const result = discoverTests(pythonTarget("pkg", "utils.py"));
    expect(result).toEqual([testFile]);
  });

  it("finds same-dir <name>_test.py", () => {
    const testFile = touch("pkg", "utils_test.py");
    const result = discoverTests(pythonTarget("pkg", "utils.py"));
    expect(result).toEqual([testFile]);
  });

  it("finds tests/test_<name>.py sibling of the source parent dir", () => {
    const testFile = touch("tests", "test_utils.py");
    const result = discoverTests(pythonTarget("pkg", "utils.py"));
    expect(result).toEqual([testFile]);
  });

  it("returns all matches when multiple conventions hit", () => {
    const a = touch("pkg", "test_utils.py");
    const b = touch("pkg", "utils_test.py");
    const c = touch("tests", "test_utils.py");
    const result = discoverTests(pythonTarget("pkg", "utils.py"));
    expect(result).toEqual([a, b, c]);
  });

  it("ignores directories that match a candidate name", () => {
    fs.mkdirSync(path.join(root, "pkg", "test_utils.py"), { recursive: true });
    const result = discoverTests(pythonTarget("pkg", "utils.py")) as DiscoveryError;
    expect(result.kind).toBe("not_found");
  });
});

describe("discoverTests — go", () => {
  it("finds same-dir <name>_test.go", () => {
    const testFile = touch("pkg", "utils_test.go");
    const result = discoverTests({ filePath: path.join(root, "pkg", "utils.go"), language: "go" });
    expect(result).toEqual([testFile]);
  });
});

describe("discoverTests — not found", () => {
  it("returns every searched path for python", () => {
    const target = pythonTarget("pkg", "utils.py");
    const result = discoverTests(target) as DiscoveryError;
    expect(result.kind).toBe("not_found");
    expect(result.message).toContain("utils.py");
    expect(result.searchedPaths).toEqual([
      path.join(root, "pkg", "test_utils.py"),
      path.join(root, "pkg", "utils_test.py"),
      path.join(root, "tests", "test_utils.py"),
    ]);
  });

  it("returns every searched path for go", () => {
    const result = discoverTests({
      filePath: path.join(root, "pkg", "utils.go"),
      language: "go",
    }) as DiscoveryError;
    expect(result.kind).toBe("not_found");
    expect(result.searchedPaths).toEqual([path.join(root, "pkg", "utils_test.go")]);
  });
});
