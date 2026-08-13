import type { AnalysisError, EquivalenceVerdict, Mutation } from "./types";

export interface AnalysisOpts {
	/** full source code of the target file */
	sourceCode: string;
	/** full content of the discovered test file(s) */
	testCode: string;
	/** symbol name or file path being analyzed */
	target: string;
	/** whether a single function or the whole file is being mutated */
	scope: "function" | "file";
	/** maximum number of mutations to generate */
	maxMutations: number;
	language: "python" | "go";
	/** injected LLM call — extension supplies the real one, tests a mock */
	llmCall: (prompt: string) => Promise<string>;
}

const REQUIRED_STRING_FIELDS = [
	"id",
	"description",
	"hotspot",
	"original",
	"mutated",
	"explanation",
	"suggestion",
] as const;

function isMutationItem(item: unknown): item is Mutation {
	if (typeof item !== "object" || item === null) return false;
	const record = item as Record<string, unknown>;
	return REQUIRED_STRING_FIELDS.every(
		(field) => typeof record[field] === "string",
	);
}

/** Extract a JSON payload from an LLM response, tolerating markdown fences */
function extractJson(response: string, open: "[" | "{" = "["): string {
	const fenceMatch = /```(?:json)?[^\S\n]*\n([\s\S]*?)```/.exec(response);
	if (fenceMatch) return fenceMatch[1].trim();
	const close = open === "[" ? "]" : "}";
	const start = response.indexOf(open);
	const end = response.lastIndexOf(close);
	if (start !== -1 && end > start) return response.slice(start, end + 1);
	return response.trim();
}

/** Cap on each embedded code section (source, tests) to bound prompt size. */
const MAX_SECTION_CHARS = 24_000;

function clampSection(code: string, label: string): string {
	if (code.length <= MAX_SECTION_CHARS) return code;
	return `${code.slice(0, MAX_SECTION_CHARS)}\n… [${label} truncated: ${code.length - MAX_SECTION_CHARS} more characters omitted]`;
}

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let from = 0;
	for (;;) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) return count;
		count++;
		from = idx + needle.length;
	}
}

/** Language-specific realistic-bug operators to steer the generator. */
function languageOperators(language: "python" | "go"): string {
	if (language === "go") {
		return `Go-specific bugs to prioritize:
- error handling: flip \`err != nil\` ↔ \`err == nil\`, delete the error check entirely, or omit the \`return\` after an error
- slice/index bounds: \`a[i:]\` vs \`a[i+1:]\`, \`len(a)\` vs \`len(a)-1\`, off-by-one in \`for\` ranges
- nil / zero values: return \`nil\` where a value is expected, or a zero value (\`0\`, \`""\`, empty slice) instead of the computed one
- integer division truncation, \`:=\` shadowing an outer variable, \`>\` vs \`>=\` comparisons`;
	}
	return `Python-specific bugs to prioritize:
- identity vs equality: \`is\` vs \`==\`, mishandled \`is None\`
- division: \`/\` vs \`//\` (true vs floor division), integer vs float result
- slicing/ranges: off-by-one in \`a[i:]\`/\`a[:i]\`, \`range(n)\` vs \`range(n+1)\` bounds
- exception handling: catching the wrong exception type, swallowing an exception, missing \`raise\`
- defaults: \`dict.get(k)\` vs \`dict.get(k, default)\`, mutable default arguments, truthiness of empty containers`;
}

function buildPrompt(opts: AnalysisOpts): string {
	const unit = opts.scope === "function" ? "function" : "file";
	const framework = opts.language === "python" ? "pytest" : "go test";
	return `You are a mutation testing expert for ${opts.language}.

Analyze the ${unit} \`${opts.target}\` and its test code below.

<source>
${clampSection(opts.sourceCode, "source")}
</source>

<tests>
${clampSection(opts.testCode, "tests")}
</tests>

Identify up to ${opts.maxMutations} mutation hotspots in the source code — places where a small semantic change is likely to survive undetected by the existing tests.

Rules for a useful mutant:
- FIRST-ORDER: each mutant makes EXACTLY ONE semantic change. Never bundle several edits into one mutant.
- KILLABLE, NOT TRIVIAL: the mutated code must stay valid, parseable/compilable code that runs. It must NOT fail on every input — a mutant that always crashes, panics, or raises is killed by any test and measures nothing. Aim for a change that behaves identically on most inputs and diverges only on a specific one, exactly what a weak test misses.
- OBSERVABLE: the change must alter observable behavior (return value, side effect, raised error) for SOME reachable input.

Favor realistic, domain-specific bugs a developer could plausibly ship, not mechanical noise:
- off-by-one / wrong boundary (\`<\` vs \`<=\`, \`+1\`/\`-1\`, inclusive vs exclusive range)
- inverted or wrong condition (flipped \`and\`/\`or\`, dropped negation, swapped if/else branches)
- sign or operator swaps (\`+\`↔\`-\`, \`*\`↔\`/\`, \`%\` errors)
- wrong constant, default, or return value (0/1, None/nil, empty vs missing)
- swapped, dropped, or wrong arguments; wrong variable referenced
- statement deletion: remove an assignment, skip a side-effecting call, drop a guard clause or early return, omit an accumulation step (deletion mutants correlate strongly with real faults)
- missing edge-case handling (empty input, null, overflow, boundary rounding)
- incorrect error handling (swallowed exception, wrong error type, missing raise/return)

${languageOperators(opts.language)}

A line being EXECUTED by a test does not mean its result is ASSERTED. Target lines that run under the existing tests but whose effect is never checked — that is where surviving mutants hide.

Do NOT propose semantically-equivalent mutants — they are unkillable and pure noise. These include: changes to dead or unreachable code; a value that is overwritten or clamped before it is used; a boundary that can never occur for any reachable input; algebraic identities (\`x*1\`, \`x+0\`); and cosmetic edits (renaming locals, reordering independent statements, equivalent refactors). If you cannot name a concrete input that would behave differently, do not propose it.

For each hotspot, produce a JSON object with exactly these fields:
- "id": short identifier UNIQUE across this response, e.g. "m001"
- "description": one-sentence description of the injected bug
- "hotspot": the code location this mutation targets (name + line or expression)
- "original": the EXACT code snippet to replace, copied VERBATIM (character-for-character, including indentation) from the source above. It MUST appear in the source exactly once — if the natural target line is not unique, EXPAND it with adjacent lines until it becomes unique rather than skipping the hotspot. Keep it MINIMAL — a single expression, statement, or a few contiguous lines — never the whole ${unit}.
- "mutated": the snippet that replaces "original", preserving surrounding indentation and style. It must differ from "original" by exactly one semantic change.
- "explanation": why this mutation is likely to survive without a specific test
- "suggestion": a concrete ${framework} test that KILLS this mutant, written using ${framework} idioms. Name the test function, give the concrete input, and make an assertion that PASSES on the original code and FAILS on the mutated code — state the expected value versus the mutant's value.

Respond with a JSON array only. No prose, no markdown fences.`;
}

export async function analyzeAndGenerate(
	opts: AnalysisOpts,
): Promise<Mutation[] | AnalysisError> {
	let response: string;
	try {
		response = await opts.llmCall(buildPrompt(opts));
	} catch (err) {
		return {
			kind: "llm_error",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJson(response));
	} catch (err) {
		return {
			kind: "parse_error",
			message: `failed to parse LLM response as JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (!Array.isArray(parsed)) {
		return {
			kind: "parse_error",
			message: "LLM response JSON is not an array",
		};
	}

	const mutations: Mutation[] = [];
	let dropped = 0;
	for (const item of parsed) {
		if (!isMutationItem(item)) {
			dropped++;
			continue;
		}
		// The runner applies each mutant by a literal find-and-replace, so
		// `original` must anchor to exactly one site — 0 (hallucinated / reworded)
		// or >1 (ambiguous) occurrences would misapply or fail. Drop early with a
		// clear signal rather than surfacing an opaque "invalid patch" downstream.
		if (occurrences(opts.sourceCode, item.original) !== 1) {
			dropped++;
			continue;
		}
		mutations.push({
			id: item.id,
			description: item.description,
			hotspot: item.hotspot,
			original: item.original,
			mutated: item.mutated,
			explanation: item.explanation,
			suggestion: item.suggestion,
		});
	}

	// All items were structurally invalid — surface it rather than returning an
	// empty plan that looks like "the LLM found nothing".
	if (mutations.length === 0 && dropped > 0) {
		return {
			kind: "parse_error",
			message: `LLM returned ${dropped} item${dropped === 1 ? "" : "s"}, none usable (missing required fields, or the "original" snippet was not found exactly once in the source)`,
		};
	}

	return mutations.slice(0, opts.maxMutations);
}

export interface EquivalenceOpts {
	mutation: Mutation;
	language: "python" | "go";
	/**
	 * Enclosing source (the mutated function or whole file) that the snippet
	 * lives in. Equivalence is contextual — reachability, later overwrites, and
	 * feasible value ranges are invisible in the bare snippet — so the judge
	 * needs this to avoid confident but unfounded verdicts.
	 */
	context?: string;
	/** injected LLM call — extension supplies the real one, tests a mock */
	llmCall: (prompt: string) => Promise<string>;
}

function buildEquivalencePrompt(
	mutation: Mutation,
	language: string,
	context?: string,
): string {
	const contextBlock = context
		? `
Here is the surrounding source the snippet lives in. Use it to reason about REACHABILITY — which inputs actually reach the snippet, what values are feasible there, and whether the result is later overwritten or clamped:

<context>
${clampSection(context, "context")}
</context>
`
		: "";
	return `You are a ${language} mutation testing expert judging semantic equivalence.

A mutant was injected by replacing the original snippet with the mutated snippet, and the existing test suite still PASSED (the mutant "survived").

Location: ${mutation.hotspot}
Intended change: ${mutation.description}

<original>
${mutation.original}
</original>

<mutated>
${mutation.mutated}
</mutated>
${contextBlock}
Decide whether the mutated snippet is SEMANTICALLY EQUIVALENT to the original: it produces identical observable behavior for EVERY input that can actually reach it, so NO test could ever distinguish them. Such a mutant is unkillable and must be filtered out.

Be conservative. Equivalence is a strong, all-inputs claim. Answer true ONLY if you can justify that every reachable input yields identical observable behavior. If any input would differ — or if you lack the context to prove identity for ALL inputs — answer false. A false "equivalent" silently discards a genuine test gap, so when unsure, answer false.

Respond with a JSON object only, no prose or fences: {"equivalent": <true|false>, "rationale": "<one sentence>"}`;
}

/**
 * Ask the LLM whether a surviving mutant is semantically equivalent to the
 * original. Best-effort: returns null on any LLM/parse failure so the caller
 * falls back to treating the mutant as a genuine survivor.
 */
export async function judgeEquivalence(
	opts: EquivalenceOpts,
): Promise<EquivalenceVerdict | null> {
	let response: string;
	try {
		response = await opts.llmCall(
			buildEquivalencePrompt(opts.mutation, opts.language, opts.context),
		);
	} catch {
		return null;
	}

	try {
		const parsed = JSON.parse(extractJson(response, "{")) as unknown;
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			if (typeof record.equivalent === "boolean") {
				return {
					equivalent: record.equivalent,
					rationale: typeof record.rationale === "string" ? record.rationale : "",
				};
			}
		}
	} catch {
		// fall through
	}
	return null;
}
