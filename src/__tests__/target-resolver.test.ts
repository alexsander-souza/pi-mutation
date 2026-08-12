import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTarget } from "../target-resolver";
import type { ResolvedTarget, ResolverError } from "../types";

let tmp: string;

function expectTarget(r: ResolvedTarget | ResolverError): ResolvedTarget {
  if ("kind" in r) throw new Error(`expected ResolvedTarget, got error: ${r.kind}`);
  return r;
}

function expectError(r: ResolvedTarget | ResolverError): ResolverError {
  if (!("kind" in r)) throw new Error(`expected ResolverError, got target: ${r.filePath}`);
  return r;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "target-resolver-"));
  fs.mkdirSync(path.join(tmp, "pkg"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "pkg", "calc.py"),
    "def calculate_total(items):\n    return sum(items)\n",
  );
  fs.writeFileSync(
    path.join(tmp, "main.go"),
    "package main\n\nfunc main() {}\n",
  );
  fs.writeFileSync(path.join(tmp, "script.js"), "console.log(1);\n");
  // Decoy symbol only reachable through a skipped directory
  fs.mkdirSync(path.join(tmp, "node_modules", "decoy"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "node_modules", "decoy", "decoy.py"),
    "def hidden_decoy():\n    pass\n",
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveTarget file paths", () => {
  it("resolves a .py path to language python", () => {
    const r = expectTarget(resolveTarget("pkg/calc.py", tmp));
    expect(r.language).toBe("python");
    expect(r.filePath).toBe(path.join(tmp, "pkg", "calc.py"));
    expect(r.symbol).toBeUndefined();
  });

  it("resolves a .go path to language go", () => {
    const r = expectTarget(resolveTarget("main.go", tmp));
    expect(r.language).toBe("go");
    expect(r.filePath).toBe(path.join(tmp, "main.go"));
    expect(r.symbol).toBeUndefined();
  });

  it("rejects a path escaping cwd", () => {
    const r = expectError(resolveTarget("../escape.py", tmp));
    expect(r.kind).toBe("escape");
    expect(r.message).toContain(path.resolve(tmp, "../escape.py"));
  });

  it("rejects a missing file", () => {
    const r = expectError(resolveTarget("missing.py", tmp));
    expect(r.kind).toBe("not_found");
    expect(r.message).toContain(path.join(tmp, "missing.py"));
  });

  it("rejects an unsupported extension, naming the extension", () => {
    const r = expectError(resolveTarget("script.js", tmp));
    expect(r.kind).toBe("unsupported");
    expect(r.message).toContain(".js");
  });
});

describe("resolveTarget symbol names", () => {
  it("finds a python symbol in a nested directory", () => {
    const r = expectTarget(resolveTarget("calculate_total", tmp));
    expect(r.filePath).toBe(path.join(tmp, "pkg", "calc.py"));
    expect(r.language).toBe("python");
    expect(r.symbol).toBe("calculate_total");
  });

  it("returns symbol_not_found for an unknown symbol, naming it", () => {
    const r = expectError(resolveTarget("nonexistent_fn", tmp));
    expect(r.kind).toBe("symbol_not_found");
    expect(r.message).toContain("nonexistent_fn");
  });

  it("skips node_modules during symbol search", () => {
    const r = expectError(resolveTarget("hidden_decoy", tmp));
    expect(r.kind).toBe("symbol_not_found");
    expect(r.message).toContain("hidden_decoy");
  });
});
