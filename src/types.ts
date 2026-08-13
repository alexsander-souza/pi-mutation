/** What the LLM returns for each hotspot */
export interface Mutation {
  /** e.g. "m001" */
  id: string;
  /** one-sentence natural language description of what the mutation changes */
  description: string;
  /** what code location this targets */
  hotspot: string;
  /**
   * exact snippet copied verbatim from the original source that this mutation
   * replaces. Must appear in the source exactly once. A minimal anchor (an
   * expression, statement, or a few contiguous lines) — never the whole body,
   * which keeps LLM output small.
   */
  original: string;
  /** snippet substituted for `original` — the semantic change */
  mutated: string;
  /** why this mutation is likely to survive without a specific test */
  explanation: string;
  /** concrete test to add that would kill this mutant, using the framework's idioms */
  suggestion: string;
}

/** Verdict from the semantic-equivalence judge for a surviving mutant */
export interface EquivalenceVerdict {
  /** true when the mutant produces identical observable behavior for all inputs */
  equivalent: boolean;
  /** one-sentence rationale for the verdict */
  rationale: string;
}

/** Per-mutant outcome after execution */
export interface MutantResult {
  mutation: Mutation;
  /**
   * killed — a test failed; surviving — tests passed, real gap;
   * invalid — patch did not apply or produced invalid syntax;
   * timeout — the suite hung; equivalent — survivor judged semantically
   * equivalent to the original, so unkillable (excluded from the score).
   */
  outcome: "killed" | "surviving" | "invalid" | "timeout" | "equivalent";
  /** stderr/stdout excerpt on kill; undefined otherwise */
  testOutput?: string;
  /** reason for an invalid patch, or the rationale for an equivalence verdict */
  note?: string;
}

/** Final structured result returned in tool result details */
export interface MutationRunResult {
  cancelled: boolean;
  target: string;
  language: "python" | "go";
  scope: "function" | "file";
  total: number;
  killed: number;
  surviving: number;
  invalid: number;
  timeout: number;
  /** survivors judged semantically equivalent — unkillable, excluded from score */
  equivalent: number;
  /** killed / (killed + surviving) * 100; null when no mutants were tested */
  score: number | null;
  mutants: MutantResult[];
  /** one suggestion per surviving (non-equivalent) mutant */
  suggestions: string[];
}

/** Pluggable test runner — one implementation per language */
export interface TestRunner {
  language: string;
  /**
   * Run the test suite against a mutated source file.
   * Returns killed=true if any test fails.
   * Must respect signal: kill child process and rethrow AbortError on abort.
   * Must kill child process after timeoutMs and resolve with timedOut=true.
   */
  runTests(opts: {
    /** absolute path to the mutated source file */
    sourceFile: string;
    /** absolute paths to test files to run */
    testFiles: string[];
    /** working directory for the subprocess */
    cwd: string;
    /** per-mutation timeout in milliseconds */
    timeoutMs: number;
    /** abort signal from the tool execute call */
    signal: AbortSignal;
  }): Promise<{ killed: boolean; output: string; timedOut?: boolean }>;
}

/** Runner registry entry — one per supported language */
export interface RunnerEntry {
  language: string;
  /** file extensions handled by this runner, e.g. [".py"] */
  extensions: string[];
  runner: TestRunner;
}

/** Resolved target after TargetResolver succeeds */
export interface ResolvedTarget {
  /** absolute path to the source file */
  filePath: string;
  language: "python" | "go";
  /** set when target was resolved from a symbol name */
  symbol?: string;
}

/** Error returned by TargetResolver */
export interface ResolverError {
  kind: "not_found" | "escape" | "unsupported" | "symbol_not_found";
  message: string;
}

/** Error returned by TestDiscovery */
export interface DiscoveryError {
  kind: "not_found";
  message: string;
  /** all paths that were searched — included in error message */
  searchedPaths: string[];
}

/** Error returned by AnalysisEngine */
export interface AnalysisError {
  kind: "parse_error" | "llm_error";
  message: string;
}

/** Options for MutationRunner.runMutations */
export interface RunMutationsOpts {
  sourcePath: string;
  language: "python" | "go";
  mutations: Mutation[];
  testFiles: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onUpdate?: (msg: string) => void;
  /** Resolved runner — caller resolves from RunnerRegistry before calling */
  runner: TestRunner;
  /**
   * Optional semantic-equivalence judge. When a mutant survives, this is called
   * with the mutation; a truthy `equivalent` verdict reclassifies it as
   * `equivalent` (unkillable) so it is excluded from the score and never
   * resurfaced for retesting. Return null to leave the survivor as-is.
   */
  checkEquivalence?: (mutation: Mutation) => Promise<EquivalenceVerdict | null>;
}
