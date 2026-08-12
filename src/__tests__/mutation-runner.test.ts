import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import path from "path";
import type { Mutation, TestRunner } from "../types";
import { runMutations } from "../mutation-runner";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMutation(id: string, replacement: string): Mutation {
  return { id, description: `mutation ${id}`, hotspot: "line 1", replacement, explanation: `explanation for ${id}` };
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
      mutations: [makeMutation("m001", "def add(a, b):\n    return a - b\n")],
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
      mutations: [makeMutation("m001", "def add(a, b):\n    return a - b\n")],
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
      mutations: [makeMutation("m001", "def add(a, b):\n    return a - b\n")],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      runner,
    });

    expect(results[0].outcome).toBe("surviving");
    expect(results[0].testOutput).toBeUndefined();
  });

  it("records invalid and skips test run for syntactically invalid mutation", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: false, output: "" }));

    const results = await runMutations({
      sourcePath,
      language: "python",
      mutations: [makeMutation("m001", "def add(a, b:\n    return a + b\n")],
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
        makeMutation("m001", "def add(a, b):\n    return a - b\n"),
        makeMutation("m002", "def add(a, b):\n    return a * b\n"),
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

    const mutations = [makeMutation("m001", "def add(a, b):\n    return a - b\n")];
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

  it("calls onUpdate once per mutant with running count and outcome", async () => {
    if (!(await python3Available())) return;
    const runner = makeMockRunner(async () => ({ killed: true, output: "" }));

    const updates: string[] = [];
    await runMutations({
      sourcePath,
      language: "python",
      mutations: [
        makeMutation("m001", "def add(a, b):\n    return a - b\n"),
        makeMutation("m002", "def add(a, b):\n    return a * b\n"),
      ],
      testFiles: [],
      cwd: dir,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      onUpdate: (msg) => updates.push(msg),
      runner,
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain("1/2");
    expect(updates[1]).toContain("2/2");
    expect(updates[0]).toContain("killed");
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
});
