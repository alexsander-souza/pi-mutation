/**
 * Integration smoke tests for runMutations.
 *
 * Requires:
 *   RUN_INTEGRATION_TESTS=1
 *   python3 + pytest on PATH
 *   go + gofmt on PATH
 *
 * Run with:
 *   RUN_INTEGRATION_TESTS=1 bun test src/__tests__/integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import path from "path";
import type { Mutation } from "../types";
import { runMutations } from "../mutation-runner";
import { pythonRunner } from "../runners/python";
import { goRunner } from "../runners/go";

const SKIP = !process.env.RUN_INTEGRATION_TESTS;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function binaryAvailable(bin: string, args: string[] = ["--version"]): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const child = spawn(bin, args, { stdio: "pipe" });
  child.on("error", () => resolve(false));
  child.on("close", () => resolve(true));
  return promise;
}

function makeMutation(id: string, description: string, replacement: string): Mutation {
  return { id, description, hotspot: "body", replacement, explanation: `explanation for ${id}`, suggestion: `test to kill ${id}` };
}

// ─── Python fixtures ──────────────────────────────────────────────────────────

const PY_ORIGINAL = `def calculate_total(items):
    total = 0
    for item in items:
        total += item["price"]
    return total
`;

// Mutation: off-by-one / wrong operator — should be caught by a good test suite
const PY_KILLED_REPLACEMENT = `def calculate_total(items):
    total = 0
    for item in items:
        total -= item["price"]
    return total
`;

// Mutation: remove loop (returns 0 always) — survives a suite that only tests empty input
const PY_SURVIVING_REPLACEMENT = `def calculate_total(items):
    total = 0
    for item in items:
        total += item["price"]
    return total + 0
`;

// Syntactically invalid
const PY_INVALID_REPLACEMENT = `def calculate_total(items:
    total = 0
`;

const PY_TEST = `from calculator import calculate_total

def test_calculate_total_basic():
    assert calculate_total([{"price": 10}, {"price": 20}]) == 30

def test_calculate_total_empty():
    assert calculate_total([]) == 0
`;

// ─── Go fixtures ─────────────────────────────────────────────────────────────

const GO_ORIGINAL = `package calculator

func CalculateTotal(prices []float64) float64 {
	total := 0.0
	for _, p := range prices {
		total += p
	}
	return total
}
`;

const GO_KILLED_REPLACEMENT = `package calculator

func CalculateTotal(prices []float64) float64 {
	total := 0.0
	for _, p := range prices {
		total -= p
	}
	return total
}
`;

const GO_TEST = `package calculator

import "testing"

func TestCalculateTotal(t *testing.T) {
	got := CalculateTotal([]float64{10, 20})
	if got != 30 {
		t.Errorf("got %v, want 30", got)
	}
}
`;

const GO_MOD = `module calculator

go 1.22
`;

// ─── Suite ───────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("integration: runMutations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-mutation-integ-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("python: killed mutation is detected by pytest", async () => {
    if (!(await binaryAvailable("pytest"))) return;

    const srcFile = path.join(dir, "calculator.py");
    const testFile = path.join(dir, "test_calculator.py");
    writeFileSync(srcFile, PY_ORIGINAL, "utf8");
    writeFileSync(testFile, PY_TEST, "utf8");

    const results = await runMutations({
      sourcePath: srcFile,
      language: "python",
      mutations: [makeMutation("m001", "subtraction instead of addition", PY_KILLED_REPLACEMENT)],
      testFiles: [testFile],
      cwd: dir,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      runner: pythonRunner,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("killed");
    // Original restored
    expect(readFileSync(srcFile, "utf8")).toBe(PY_ORIGINAL);
    // Backup deleted
    expect(existsSync(srcFile + ".pi-mutation-bak")).toBe(false);
  });

  it("python: invalid syntax mutation is skipped without running pytest", async () => {
    if (!(await binaryAvailable("pytest"))) return;

    const srcFile = path.join(dir, "calculator.py");
    const testFile = path.join(dir, "test_calculator.py");
    writeFileSync(srcFile, PY_ORIGINAL, "utf8");
    writeFileSync(testFile, PY_TEST, "utf8");

    const results = await runMutations({
      sourcePath: srcFile,
      language: "python",
      mutations: [makeMutation("m001", "broken syntax", PY_INVALID_REPLACEMENT)],
      testFiles: [testFile],
      cwd: dir,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      runner: pythonRunner,
    });

    expect(results[0].outcome).toBe("invalid");
    expect(readFileSync(srcFile, "utf8")).toBe(PY_ORIGINAL);
  });

  it("python: abort mid-run returns partial results and restores original", async () => {
    if (!(await binaryAvailable("pytest"))) return;

    const srcFile = path.join(dir, "calculator.py");
    const testFile = path.join(dir, "test_calculator.py");
    writeFileSync(srcFile, PY_ORIGINAL, "utf8");
    writeFileSync(testFile, PY_TEST, "utf8");

    const controller = new AbortController();
    const mutations = [
      makeMutation("m001", "subtraction instead of addition", PY_KILLED_REPLACEMENT),
      makeMutation("m002", "identity addition", PY_SURVIVING_REPLACEMENT),
    ];

    // Abort after first mutant completes
    const origRunTests = pythonRunner.runTests.bind(pythonRunner);
    let callCount = 0;
    const abortingRunner = {
      language: "python",
      runTests: async (opts: Parameters<typeof origRunTests>[0]) => {
        const result = await origRunTests(opts);
        callCount++;
        if (callCount === 1) controller.abort();
        return result;
      },
    };

    const results = await runMutations({
      sourcePath: srcFile,
      language: "python",
      mutations,
      testFiles: [testFile],
      cwd: dir,
      timeoutMs: 30_000,
      signal: controller.signal,
      runner: abortingRunner,
    });

    expect(results.length).toBeLessThan(mutations.length);
    expect(readFileSync(srcFile, "utf8")).toBe(PY_ORIGINAL);
    expect(existsSync(srcFile + ".pi-mutation-bak")).toBe(false);
  });

  it("go: killed mutation is detected by go test", async () => {
    if (!(await binaryAvailable("go", ["version"]))) return;
    if (!(await binaryAvailable("gofmt", ["--help"]))) return;

    writeFileSync(path.join(dir, "go.mod"), GO_MOD, "utf8");
    const srcFile = path.join(dir, "calculator.go");
    const testFile = path.join(dir, "calculator_test.go");
    writeFileSync(srcFile, GO_ORIGINAL, "utf8");
    writeFileSync(testFile, GO_TEST, "utf8");

    const results = await runMutations({
      sourcePath: srcFile,
      language: "go",
      mutations: [makeMutation("m001", "subtraction instead of addition", GO_KILLED_REPLACEMENT)],
      testFiles: [testFile],
      cwd: dir,
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      runner: goRunner,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("killed");
    expect(readFileSync(srcFile, "utf8")).toBe(GO_ORIGINAL);
    expect(existsSync(srcFile + ".pi-mutation-bak")).toBe(false);
  });
});
