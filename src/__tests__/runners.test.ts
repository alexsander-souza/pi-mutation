import { describe, it, expect, mock, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { TestRunner } from "../types";
import { pythonRunner, PythonNotFoundError } from "../runners/python";
import { goRunner, GoNotFoundError } from "../runners/go";
import { getRunner, registerRunner } from "../runners/index";

interface SpawnOptions {
  cwd?: string;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killSignals: Array<string | undefined> = [];

  kill(signal?: string): boolean {
    this.killSignals.push(signal);
    return true;
  }

  pushStdout(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }

  pushStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }

  closeWith(code: number): void {
    this.emit("close", code);
  }
}

let spawnedChildren: FakeChildProcess[];
let spawnCalls: SpawnCall[];
let spawnError: NodeJS.ErrnoException | null;

mock.module("child_process", () => ({
  spawn: (command: string, args: string[], options: SpawnOptions) => {
    spawnCalls.push({ command, args, options });
    const child = new FakeChildProcess();
    spawnedChildren.push(child);
    if (spawnError) {
      const err = spawnError;
      queueMicrotask(() => child.emit("error", err));
    }
    return child;
  },
}));

function lastChild(): FakeChildProcess {
  return spawnedChildren[spawnedChildren.length - 1];
}

function lastSpawnCall(): SpawnCall {
  return spawnCalls[spawnCalls.length - 1];
}

function baseOpts(overrides: { timeoutMs?: number; signal?: AbortSignal } = {}): {
  sourceFile: string;
  testFiles: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
} {
  return {
    sourceFile: "/repo/src/foo.py",
    testFiles: ["/repo/tests/test_foo.py"],
    cwd: "/repo",
    timeoutMs: 1000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  spawnedChildren = [];
  spawnCalls = [];
  spawnError = null;
});

describe("pythonRunner", () => {
  it("spawns pytest with the test files and quiet short-traceback flags", async () => {
    const pending = pythonRunner.runTests(baseOpts());
    lastChild().closeWith(0);
    await pending;

    const call = lastSpawnCall();
    expect(call.command).toBe("pytest");
    expect(call.args).toEqual(["/repo/tests/test_foo.py", "--tb=short", "-q"]);
    expect(call.options.cwd).toBe("/repo");
  });

  it("reports killed=false when pytest exits with code 0", async () => {
    const pending = pythonRunner.runTests(baseOpts());
    lastChild().pushStdout("1 passed in 0.01s");
    lastChild().closeWith(0);

    expect(await pending).toEqual({ killed: false, output: "1 passed in 0.01s" });
  });

  it("reports killed=true with combined output when pytest exits non-zero", async () => {
    const pending = pythonRunner.runTests(baseOpts());
    lastChild().pushStdout("=== FAILURES ===\n");
    lastChild().pushStderr("E   assert mutated() == expected\n");
    lastChild().closeWith(1);

    expect(await pending).toEqual({
      killed: true,
      output: "=== FAILURES ===\nE   assert mutated() == expected\n",
    });
  });

  it("kills the child and reports timeout after timeoutMs", async () => {
    const pending = pythonRunner.runTests(baseOpts({ timeoutMs: 25 }));
    const child = lastChild();

    expect(await pending).toEqual({ killed: false, output: "timeout", timedOut: true });
    expect(child.killSignals).toContain("SIGKILL");
  });

  it("kills the child and throws AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = pythonRunner.runTests(baseOpts({ signal: controller.signal }));
    const child = lastChild();

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DOMException);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(child.killSignals).toContain("SIGKILL");
  });

  it("throws PythonNotFoundError when pytest is not on PATH", async () => {
    spawnError = Object.assign(new Error("spawn pytest ENOENT"), { code: "ENOENT" });

    const pending = pythonRunner.runTests(baseOpts());
    await expect(pending).rejects.toBeInstanceOf(PythonNotFoundError);
    await expect(pending).rejects.toThrow("pytest not found on $PATH");
  });
});

describe("goRunner", () => {
  it("spawns go test ./... in the working directory", async () => {
    const pending = goRunner.runTests(baseOpts());
    lastChild().closeWith(0);
    await pending;

    const call = lastSpawnCall();
    expect(call.command).toBe("go");
    expect(call.args).toEqual(["test", "./..."]);
    expect(call.options.cwd).toBe("/repo");
  });

  it("reports killed=false when go test exits with code 0", async () => {
    const pending = goRunner.runTests(baseOpts());
    lastChild().pushStdout("ok  \texample.com/repo\t0.012s");
    lastChild().closeWith(0);

    expect(await pending).toEqual({ killed: false, output: "ok  \texample.com/repo\t0.012s" });
  });

  it("reports killed=true with combined output when go test exits non-zero", async () => {
    const pending = goRunner.runTests(baseOpts());
    lastChild().pushStdout("--- FAIL: TestMutated\n");
    lastChild().pushStderr("FAIL\texample.com/repo\n");
    lastChild().closeWith(1);

    expect(await pending).toEqual({
      killed: true,
      output: "--- FAIL: TestMutated\nFAIL\texample.com/repo\n",
    });
  });

  it("kills the child and reports timeout after timeoutMs", async () => {
    const pending = goRunner.runTests(baseOpts({ timeoutMs: 25 }));
    const child = lastChild();

    expect(await pending).toEqual({ killed: false, output: "timeout", timedOut: true });
    expect(child.killSignals).toContain("SIGKILL");
  });

  it("kills the child and throws AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = goRunner.runTests(baseOpts({ signal: controller.signal }));
    const child = lastChild();

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DOMException);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(child.killSignals).toContain("SIGKILL");
  });

  it("throws GoNotFoundError when go is not on PATH", async () => {
    spawnError = Object.assign(new Error("spawn go ENOENT"), { code: "ENOENT" });

    const pending = goRunner.runTests(baseOpts());
    await expect(pending).rejects.toBeInstanceOf(GoNotFoundError);
    await expect(pending).rejects.toThrow("go not found on $PATH");
  });
});

describe("runner registry", () => {
  it("returns the pre-registered python and go runners", () => {
    expect(getRunner("python")).toBe(pythonRunner);
    expect(getRunner("go")).toBe(goRunner);
  });

  it("returns undefined for unregistered languages", () => {
    expect(getRunner("rust")).toBeUndefined();
  });

  it("returns runners added via registerRunner", () => {
    const rubyRunner: TestRunner = {
      language: "ruby",
      runTests: async () => ({ killed: false, output: "" }),
    };
    registerRunner({ language: "ruby", extensions: [".rb"], runner: rubyRunner });

    expect(getRunner("ruby")).toBe(rubyRunner);
  });
});
