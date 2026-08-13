import { spawn } from "child_process";
import type { TestRunner } from "../types";

export class GoNotFoundError extends Error {
  constructor() {
    super("go not found on $PATH");
  }
}

interface RunResult {
  killed: boolean;
  output: string;
  timedOut?: boolean;
}

export const goRunner: TestRunner = {
  language: "go",
  async runTests({ cwd, timeoutMs, signal }): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn("go", ["test", "./..."], { cwd });
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
        fail(err.code === "ENOENT" ? new GoNotFoundError() : err);
      });

      // "close" fires after stdio streams are flushed, unlike "exit"
      child.on("close", (code: number | null) => {
        finish({ killed: code !== 0, output });
      });
    });
  },
};
