import { describe, it, expect } from "bun:test";
import { buildResult } from "../result-builder";
import type { Mutation, MutantResult } from "../types";

function makeMutation(id: string, over: Partial<Mutation> = {}): Mutation {
  return {
    id,
    description: `mutation ${id} description`,
    hotspot: `hotspot-${id}`,
    replacement: `replacement-${id}`,
    explanation: `explanation-${id}`,
    suggestion: `suggestion-${id}`,
    ...over,
  };
}

function makeMutant(
  id: string,
  outcome: MutantResult["outcome"],
): MutantResult {
  return { mutation: makeMutation(id), outcome };
}

const baseOpts = {
  cancelled: false,
  target: "src/foo.py",
  language: "python" as const,
  scope: "function" as const,
};

describe("buildResult", () => {
  it("computes score 75 for 6 killed / 2 surviving", () => {
    const mutants: MutantResult[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        makeMutant(`k${i}`, "killed"),
      ),
      ...Array.from({ length: 2 }, (_, i) => makeMutant(`s${i}`, "surviving")),
    ];

    const { details } = buildResult({ ...baseOpts, mutants });

    expect(details.total).toBe(8);
    expect(details.killed).toBe(6);
    expect(details.surviving).toBe(2);
    expect(details.invalid).toBe(0);
    expect(details.timeout).toBe(0);
    expect(details.score).toBe(75);
  });

  it("returns null score and N/A content when 0 mutants tested", () => {
    const mutants: MutantResult[] = [
      makeMutant("i1", "invalid"),
      makeMutant("t1", "timeout"),
    ];

    const { content, details } = buildResult({ ...baseOpts, mutants });

    expect(details.score).toBeNull();
    expect(content).toContain("Score: N/A (no mutants tested)");
  });

  it("reports cancelled: true in content and details", () => {
    const mutants: MutantResult[] = [makeMutant("k1", "killed")];

    const { content, details } = buildResult({
      ...baseOpts,
      cancelled: true,
      mutants,
    });

    expect(details.cancelled).toBe(true);
    expect(content).toContain("Cancelled: yes");
  });

  it("reports Cancelled: no when not cancelled", () => {
    const { content } = buildResult({
      ...baseOpts,
      mutants: [makeMutant("k1", "killed")],
    });
    expect(content).toContain("Cancelled: no");
  });

  it("lists surviving mutants before any killed mention in content", () => {
    const mutants: MutantResult[] = [
      makeMutant("k1", "killed"),
      makeMutant("s1", "surviving"),
    ];

    const { content } = buildResult({ ...baseOpts, mutants });

    // Per-mutant listings only exist for surviving mutants; killed mutants
    // appear only as counts. The surviving section must render before the
    // trailer (Cancelled) and must list the surviving mutant's id.
    const survivingIdx = content.indexOf("Surviving mutants:");
    const cancelledIdx = content.indexOf("Cancelled:");
    expect(survivingIdx).toBeGreaterThan(-1);
    expect(survivingIdx).toBeLessThan(cancelledIdx);
    expect(content).toContain("[s1]");
    expect(content).toContain("killed"); // killed count in score line
  });

  it("emits one suggestion per surviving mutant", () => {
    const mutants: MutantResult[] = [
      makeMutant("s1", "surviving"),
      makeMutant("s2", "surviving"),
      makeMutant("k1", "killed"),
    ];

    const { details } = buildResult({ ...baseOpts, mutants });

    expect(details.suggestions).toHaveLength(2);
    expect(details.suggestions[0]).toBe("suggestion-s1");
    expect(details.suggestions[1]).toBe("suggestion-s2");
  });

  it("zero mutants → all counts 0, score null, Surviving mutants: none", () => {
    const { content, details } = buildResult({ ...baseOpts, mutants: [] });

    expect(details.total).toBe(0);
    expect(details.killed).toBe(0);
    expect(details.surviving).toBe(0);
    expect(details.invalid).toBe(0);
    expect(details.timeout).toBe(0);
    expect(details.score).toBeNull();
    expect(details.suggestions).toEqual([]);
    expect(content).toContain("Score: N/A (no mutants tested)");
    expect(content).toContain("Surviving mutants: none");
    expect(content).toContain("Mutation testing complete — 0/0 mutants tested");
  });

  it("content header shows tested/total counts", () => {
    const mutants: MutantResult[] = [
      makeMutant("k1", "killed"),
      makeMutant("s1", "surviving"),
      makeMutant("i1", "invalid"),
      makeMutant("t1", "timeout"),
    ];

    const { content, details } = buildResult({ ...baseOpts, mutants });

    expect(content).toContain("Mutation testing complete — 2/4 mutants tested");
    expect(details.score).toBe(50);
    expect(content).toContain(
      "Score: 50% (1 killed / 1 surviving / 1 invalid / 1 timeout)",
    );
    expect(content).toContain("Target: src/foo.py (python, function scope)");
  });
});
