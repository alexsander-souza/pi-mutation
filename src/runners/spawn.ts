import { spawn } from "child_process";

export interface SpawnRunResult {
  killed: boolean;
  output: string;
  timedOut?: boolean;
}

/**
 * Cap on retained combined stdout+stderr. A chatty or looping test suite can
 * emit unbounded output under the per-mutant timeout; we only surface an
 * excerpt, so keep the tail (where failures/summaries land) and drop the head.
 */
const MAX_OUTPUT_CHARS = 64 * 1024;

export interface SpawnTestsOpts {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Maps an ENOENT spawn error to a typed "binary missing" error. */
  onNotFound: () => Error;
}

/**
 * Spawn a test-runner subprocess and resolve its outcome.
 * - killed = process exited non-zero (a test failed → mutant killed).
 * - Kills the child and resolves `timedOut` after `timeoutMs`.
 * - Kills the child and rejects with AbortError when `signal` aborts.
 * - Rejects with `onNotFound()` when the binary is missing (ENOENT).
 * Retained output is bounded to the last MAX_OUTPUT_CHARS characters.
 */
export function runSpawnedTests(opts: SpawnTestsOpts): Promise<SpawnRunResult> {
  const { bin, args, cwd, timeoutMs, signal, onNotFound } = opts;
  return new Promise<SpawnRunResult>((resolve, reject) => {
    const child = spawn(bin, args, { cwd });
    let output = "";
    let truncated = false;
    let settled = false;

    const append = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(output.length - MAX_OUTPUT_CHARS);
        truncated = true;
      }
    };

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
    const finish = (result: SpawnRunResult): void => {
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

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    child.on("error", (err: NodeJS.ErrnoException) => {
      fail(err.code === "ENOENT" ? onNotFound() : err);
    });

    // "close" fires after stdio streams are flushed, unlike "exit"
    child.on("close", (code: number | null) => {
      finish({
        killed: code !== 0,
        output: truncated ? `…[output truncated to last ${MAX_OUTPUT_CHARS} chars]\n${output}` : output,
      });
    });
  });
}
