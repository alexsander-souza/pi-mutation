import type { AnalysisError, Mutation } from "./types";

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
	"replacement",
	"explanation",
] as const;

function isMutationItem(item: unknown): item is Mutation {
	if (typeof item !== "object" || item === null) return false;
	const record = item as Record<string, unknown>;
	return REQUIRED_STRING_FIELDS.every(
		(field) => typeof record[field] === "string",
	);
}

/** Extract a JSON payload from an LLM response, tolerating markdown fences */
function extractJson(response: string): string {
	const fenceMatch = /```(?:json)?[^\S\n]*\n([\s\S]*?)```/.exec(response);
	if (fenceMatch) return fenceMatch[1].trim();
	const start = response.indexOf("[");
	const end = response.lastIndexOf("]");
	if (start !== -1 && end > start) return response.slice(start, end + 1);
	return response.trim();
}

function buildPrompt(opts: AnalysisOpts): string {
	const unit = opts.scope === "function" ? "function" : "file";
	return `You are a mutation testing expert for ${opts.language}.

Analyze the ${unit} \`${opts.target}\` and its test code below.

<source>
${opts.sourceCode}
</source>

<tests>
${opts.testCode}
</tests>

Identify up to ${opts.maxMutations} mutation hotspots in the source code — places where a small semantic change is likely to survive undetected by the existing tests.

For each hotspot, produce a JSON object with exactly these fields:
- "id": short unique identifier, e.g. "m001"
- "description": one-sentence natural language description of what the mutation changes
- "hotspot": the code location this mutation targets
- "replacement": the FULL mutated ${unit} body, not a diff — it replaces the original entirely
- "explanation": why this mutation is likely to survive without a specific test

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
				replacement: item.replacement,
				explanation: item.explanation,
			});
		}
	}

	return mutations.slice(0, opts.maxMutations);
}
