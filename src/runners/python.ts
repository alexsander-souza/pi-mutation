import { spawn } from "child_process";
import type { TestRunner } from "../types";

export class PythonNotFoundError extends Error {
  constructor(command: string) {
    super(`test command not found on $PATH: ${command}`);
  }
}

interface RunResult {
  killed: boolean;
  output: string;
  timedOut?: boolean;
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
    async runTests({ testFiles, cwd, timeoutMs, signal }): Promise<RunResult> {
      return new Promise<RunResult>((resolve, reject) => {
        const args = [...prefixArgs, ...testFiles, "--tb=short", "-q"];
        const child = spawn(bin, args, { cwd });
        let output = "";
        let settled = false;

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ killed: false, output: "timeout", timedOut: true });
        }, timeoutMs);

        const onAbort = (): void => {
          child.kill("SIGKILL");
          fail(new DOMException("Aborted", "AbortError"));
        };

        const cleanup = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        };
        const finish = (result: RunResult): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };

        signal.addEventListener("abort", onAbort);

        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });

        child.on("error", (err: NodeJS.ErrnoException) => {
          fail(err.code === "ENOENT" ? new PythonNotFoundError(command) : err);
        });

        // "close" fires after stdio streams are flushed, unlike "exit"
        child.on("close", (code: number | null) => {
          finish({ killed: code !== 0, output });
        });
      });
    },
  };
}

export const pythonRunner: TestRunner = makePythonRunner();
