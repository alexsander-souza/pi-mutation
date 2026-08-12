import type { MutantResult, MutationRunResult } from "./types";

/**
 * Build the final MutationRunResult plus human-readable content text
 * from executed mutant results. Pure function — no I/O.
 */
export function buildResult(opts: {
  mutants: MutantResult[];
  cancelled: boolean;
  target: string;
  language: "python" | "go";
  scope: "function" | "file";
}): { content: string; details: MutationRunResult } {
  const { mutants, cancelled, target, language, scope } = opts;

  const total = mutants.length;
  const killed = mutants.filter((m) => m.outcome === "killed").length;
  const surviving = mutants.filter((m) => m.outcome === "surviving").length;
  const invalid = mutants.filter((m) => m.outcome === "invalid").length;
  const timeout = mutants.filter((m) => m.outcome === "timeout").length;

  const tested = killed + surviving;
  const score = tested === 0 ? null : Math.round((killed / tested) * 100);

  const survivingMutants = mutants.filter((m) => m.outcome === "surviving");
  const suggestions = survivingMutants.map(
    (m) => `→ Suggested test: based on "${m.mutation.explanation}"`,
  );

  const details: MutationRunResult = {
    cancelled,
    target,
    language,
    scope,
    total,
    killed,
    surviving,
    invalid,
    timeout,
    score,
    mutants,
    suggestions,
  };

  const content = renderContent(details, survivingMutants);
  return { content, details };
}

function renderContent(
  details: MutationRunResult,
  survivingMutants: MutantResult[],
): string {
  const {
    cancelled,
    target,
    language,
    scope,
    total,
    killed,
    surviving,
    invalid,
    timeout,
    score,
  } = details;

  const tested = killed + surviving;
  const lines: string[] = [];

  lines.push(
    `Mutation testing complete — ${tested}/${total} mutants tested`,
  );
  lines.push(`Target: ${target} (${language}, ${scope} scope)`);
  if (score === null) {
    lines.push("Score: N/A (no mutants tested)");
  } else {
    lines.push(
      `Score: ${score}% (${killed} killed / ${surviving} surviving / ${invalid} invalid / ${timeout} timeout)`,
    );
  }
  lines.push("");

  if (survivingMutants.length === 0) {
    lines.push("Surviving mutants: none");
  } else {
    lines.push("Surviving mutants:");
    survivingMutants.forEach((m, i) => {
      lines.push(
        `  ${i + 1}. [${m.mutation.id}] ${m.mutation.description} — ${m.mutation.explanation}`,
      );
      lines.push(`     → Suggested test: based on "${m.mutation.explanation}"`);
    });
  }
  lines.push("");

  lines.push(`Cancelled: ${cancelled ? "yes" : "no"}`);

  return lines.join("\n");
}
