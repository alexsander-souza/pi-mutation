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

function buildPrompt(opts: AnalysisOpts): string {
	const unit = opts.scope === "function" ? "function" : "file";
	const framework = opts.language === "python" ? "pytest" : "go test";
	return `You are a mutation testing expert for ${opts.language}.

Analyze the ${unit} \`${opts.target}\` and its test code below.

<source>
${opts.sourceCode}
</source>

<tests>
${opts.testCode}
</tests>

Identify up to ${opts.maxMutations} mutation hotspots in the source code — places where a small semantic change is likely to survive undetected by the existing tests.

Favor realistic, domain-specific bugs a developer could plausibly ship, not mechanical noise:
- off-by-one / wrong boundary (\`<\` vs \`<=\`, \`+1\`/\`-1\`, inclusive vs exclusive range)
- inverted or wrong condition (flipped \`and\`/\`or\`, dropped negation, swapped if/else branches)
- sign or operator swaps (\`+\`↔\`-\`, \`*\`↔\`/\`, \`%\` errors)
- wrong constant, default, or return value (0/1, None/nil, empty vs missing)
- swapped, dropped, or wrong arguments; wrong variable referenced
- missing edge-case handling (empty input, null, overflow, boundary rounding)
- incorrect error handling (swallowed exception, wrong error type, missing raise/return)
Prefer mutations that change observable behavior for SOME input. Do NOT propose no-op or cosmetic changes (renaming locals, reordering independent statements, equivalent refactors) — those are semantically equivalent and no test can kill them.

For each hotspot, produce a JSON object with exactly these fields:
- "id": short unique identifier, e.g. "m001"
- "description": one-sentence description of the injected bug
- "hotspot": the code location this mutation targets (name + line or expression)
- "original": the EXACT code snippet to replace, copied VERBATIM (character-for-character, including indentation) from the source above. It MUST appear in the source exactly once. Keep it MINIMAL — a single expression, statement, or a few contiguous lines — never the whole ${unit}.
- "mutated": the snippet that replaces "original", preserving surrounding indentation and style. It must differ from "original".
- "explanation": why this mutation is likely to survive without a specific test
- "suggestion": a concrete ${framework} test to add that would kill this mutant, written using ${framework} idioms (name the test function and the assertion it makes)

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
	for (const item of parsed) {
		if (isMutationItem(item)) {
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
	}

	return mutations.slice(0, opts.maxMutations);
}

export interface EquivalenceOpts {
	mutation: Mutation;
	language: "python" | "go";
	/** injected LLM call — extension supplies the real one, tests a mock */
	llmCall: (prompt: string) => Promise<string>;
}

function buildEquivalencePrompt(mutation: Mutation, language: string): string {
	return `You are a ${language} mutation testing expert judging semantic equivalence.

A mutant was injected by replacing the original snippet with the mutated snippet, and the existing test suite still PASSED (the mutant "survived").

<original>
${mutation.original}
</original>

<mutated>
${mutation.mutated}
</mutated>

Decide whether the mutated snippet is SEMANTICALLY EQUIVALENT to the original: it produces identical observable behavior for every possible input, so NO test could ever distinguish them. Such a mutant is unkillable and must be filtered out. If ANY input would yield different behavior, it is NOT equivalent — it is a genuine test gap.

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
		response = await opts.llmCall(buildEquivalencePrompt(opts.mutation, opts.language));
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
