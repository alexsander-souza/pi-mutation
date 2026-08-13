import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import path from "path";
import type { Mutation, TestRunner } from "../types";
import { runMutations } from "../mutation-runner";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMutation(id: string, original: string, mutated: string): Mutation {
  return { id, description: `mutation ${id}`, hotspot: "line 1", original, mutated, explanation: `explanation for ${id}`, suggestion: `def test_${id}(): pass` };
}

function makeMockRunner(impl: TestRunner["runTests"]): TestRunner {
  return { language: "python", runTests: mock(impl) };
}

async function python3Available(): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const child = spawn("python3", ["--version"], { stdio: "pipe" });
  child.on("error", () => resolve(false));
  child.on("close", () => resolve(true));
  return promise;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runMutations", () => {
  let dir: string;
  let sourcePath: string;
  let bakPath: string;
  const originalContent = "def add(a, b):\n    return a + b\n";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-mutation-test-"));
    sourcePath = path.join(dir, "calculator.py");
    bakPath = sourcePath + ".pi-mutation-bak";
    writeFileSync(sourcePath, originalContent, "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores original file and deletes backup after successful run", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: true, output: "1 failed" }));

    await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "return a + b", "return a - b")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(readFileSync(sourcePath, "utf8")).toBe(originalContent);
    expect(existsSync(bakPath)).toBe(false);
  });

  it("records killed outcome with testOutput when runner reports killed", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: true, output: "FAILED" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "return a + b", "return a - b")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("killed");
    expect(results[0].testOutput).toBe("FAILED");
  });

  it("records surviving outcome without testOutput when runner reports not killed", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: false, output: "1 passed" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "return a + b", "return a - b")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(results[0].outcome).toBe("surviving");
    expect(results[0].testOutput).toBeUndefined();
  });

  it("records timeout outcome when runner reports timedOut", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: false, output: "timeout", timedOut: true }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "return a + b", "return a - b")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(results[0].outcome).toBe("timeout");
    expect(results[0].testOutput).toBeUndefined();
  });

  it("records invalid and skips test run for syntactically invalid mutation", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: false, output: "" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "return a + b", "return a + b:")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(results[0].outcome).toBe("invalid");
    expect(runner.runTests).not.toHaveBeenCalled();
    expect(readFileSync(sourcePath, "utf8")).toBe(originalContent);
  });

  it("stops at abort signal and returns partial results with original restored", async () => {
    if (!(await python3Available())) return;

    const controller = new AbortController();
    const runner = makeMockRunner(async () => {
      controller.abort();
      return { killed: true, output: "FAILED" };
    });

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [
        makeMutation("m001", "return a + b", "return a - b"),
        makeMutation("m002", "return a + b", "return a * b"),
      ],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: controller.signal,
      runner,
    });

    expect(results).toHaveLength(1);
    expect(readFileSync(sourcePath, "utf8")).toBe(originalContent);
    expect(existsSync(bakPath)).toBe(false);
  });

  it("rejects concurrent runs on the same file", async () => {
    if (!(await python3Available())) return;

    const { promise: slowResult, resolve: resolveSlow } =
      Promise.withResolvers<{ killed: boolean; output: string }>();
    const runner = makeMockRunner(() => slowResult);

    const mutations = [makeMutation("m001", "return a + b", "return a - b")];
    const opts = {
      sourcePath,
      language: "python" as const,
      mutations,
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    };

    const first = runMutations(opts);
    await new Promise((r) => setImmediate(r)); // let first call register inProgress

    await expect(runMutations(opts)).rejects.toThrow(
      `A mutation run is already in progress for ${sourcePath}`,
    );

    resolveSlow({ killed: true, output: "" });
    await first;
  });

  it("emits a running line then an outcome line per mutant", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: true, output: "" }));

    const updates: string[] = [];
    await runMutations({
      sourcePath,
      language: "python",
      mutations: [
        makeMutation("m001", "return a + b", "return a - b"),
        makeMutation("m002", "return a + b", "return a * b"),
      ],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      onUpdate: (msg) => updates.push(msg),
      runner,
    });

    // Each mutant emits a "running tests…" line then an outcome line.
    expect(updates).toHaveLength(4);
    expect(updates[0]).toContain("1/2");
    expect(updates[0]).toContain("running tests");
    expect(updates[1]).toContain("1/2");
    expect(updates[1]).toContain("killed");
    expect(updates[3]).toContain("2/2");
    expect(updates[3]).toContain("killed");
  });

  it("returns empty array and cleans up when mutations list is empty", async () => {
    const runner = makeMockRunner(async () => ({ killed: false, output: "" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(results).toHaveLength(0);
    expect(existsSync(bakPath)).toBe(false);
  });

  it("records invalid without running tests when the original snippet is not found", async () => {
    const runner = makeMockRunner(async () => ({ killed: false, output: "" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "return x - y", "return x + y")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(results[0].outcome).toBe("invalid");
    expect(results[0].note).toContain("not found");
    expect(runner.runTests).not.toHaveBeenCalled();
    expect(readFileSync(sourcePath, "utf8")).toBe(originalContent);
  });

  it("records invalid without running tests when the original snippet is ambiguous", async () => {
    writeFileSync(sourcePath, "x = 1\nx = 1\n", "utf8");
    const runner = makeMockRunner(async () => ({ killed: false, output: "" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "x = 1", "x = 2")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(results[0].outcome).toBe("invalid");
    expect(results[0].note).toContain("ambiguous");
    expect(runner.runTests).not.toHaveBeenCalled();
  });

  it("reclassifies a survivor as equivalent when checkEquivalence agrees", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: false, output: "1 passed" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "return a + b", "return b + a")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
      checkEquivalence: async () => ({ equivalent: true, rationale: "addition is commutative" }),
    });

    expect(results[0].outcome).toBe("equivalent");
    expect(results[0].note).toBe("addition is commutative");
  });

  it("keeps a survivor surviving when checkEquivalence disagrees", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: false, output: "1 passed" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "return a + b", "return a - b")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
      checkEquivalence: async () => ({ equivalent: false, rationale: "differs for b != 0" }),
    });

    expect(results[0].outcome).toBe("surviving");
  });
});
