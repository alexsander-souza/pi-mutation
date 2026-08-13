import { describe, expect, it } from "bun:test";
import { type AnalysisOpts, analyzeAndGenerate, judgeEquivalence } from "../analysis-engine";
import type { AnalysisError, Mutation } from "../types";

function makeOpts(
	llmCall: (prompt: string) => Promise<string>,
	overrides: Partial<AnalysisOpts> = {},
): AnalysisOpts {
	return {
		sourceCode: "def add(a, b):\n    return a + b",
		testCode: "def test_add():\n    assert add(1, 2) == 3",
		target: "add",
		scope: "function",
		maxMutations: 10,
		language: "python",
		llmCall,
		...overrides,
	};
}

function isError(result: Mutation[] | AnalysisError): result is AnalysisError {
	return !Array.isArray(result);
}

function makeItem(index: number): Mutation {
	return {
		id: `m${String(index + 1).padStart(3, "0")}`,
		description: `mutation ${index + 1}`,
		hotspot: `line ${index + 1}`,
		original: `return a + b`,
		mutated: `return a - b  # mutant ${index + 1}`,
		explanation: `reason ${index + 1}`,
		suggestion: `def test_add_${index + 1}(): assert add(1, 2) == 3`,
	};
}

describe("analyzeAndGenerate", () => {
	it("returns Mutation[] for a valid JSON array response", async () => {
		const items = [makeItem(0), makeItem(1)];
		const result = await analyzeAndGenerate(
			makeOpts(async () => JSON.stringify(items)),
		);
		expect(isError(result)).toBe(false);
		if (isError(result)) return;
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual(items[0]);
		expect(result[1]).toEqual(items[1]);
	});

	it("parses JSON wrapped in a ```json markdown fence", async () => {
		const items = [makeItem(0)];
		const response = `Here are the mutations:\n\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\`\n`;
		const result = await analyzeAndGenerate(makeOpts(async () => response));
		expect(isError(result)).toBe(false);
		if (isError(result)) return;
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("m001");
	});

	it("parses a plain ``` fence without a language tag", async () => {
		const items = [makeItem(0)];
		const response = `\`\`\`\n${JSON.stringify(items)}\n\`\`\``;
		const result = await analyzeAndGenerate(makeOpts(async () => response));
		expect(isError(result)).toBe(false);
		if (isError(result)) return;
		expect(result).toHaveLength(1);
	});

	it("returns parse_error for malformed JSON", async () => {
		const result = await analyzeAndGenerate(
			makeOpts(async () => "this is not json at all"),
		);
		expect(isError(result)).toBe(true);
		if (!isError(result)) return;
		expect(result.kind).toBe("parse_error");
		expect(result.message).toBeString();
	});

	it("returns parse_error when JSON parses but is not an array", async () => {
		const result = await analyzeAndGenerate(
			makeOpts(async () => JSON.stringify({ id: "m001" })),
		);
		expect(isError(result)).toBe(true);
		if (!isError(result)) return;
		expect(result.kind).toBe("parse_error");
	});

	it("slices to maxMutations when the LLM returns more items", async () => {
		const items = Array.from({ length: 15 }, (_, i) => makeItem(i));
		const result = await analyzeAndGenerate(
			makeOpts(async () => JSON.stringify(items), { maxMutations: 10 }),
		);
		expect(isError(result)).toBe(false);
		if (isError(result)) return;
		expect(result).toHaveLength(10);
		expect(result[9].id).toBe("m010");
	});

	it("returns [] for an empty array response (not an error)", async () => {
		const result = await analyzeAndGenerate(makeOpts(async () => "[]"));
		expect(isError(result)).toBe(false);
		if (isError(result)) return;
		expect(result).toEqual([]);
	});

	it("drops items missing the mutated field", async () => {
		const valid = makeItem(0);
		const missingMutated = {
			id: "m002",
			description: "no mutated snippet here",
			hotspot: "line 2",
			original: "return a + b",
			explanation: "dropped",
		};
		const result = await analyzeAndGenerate(
			makeOpts(async () => JSON.stringify([valid, missingMutated])),
		);
		expect(isError(result)).toBe(false);
		if (isError(result)) return;
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("m001");
	});

	it("drops non-object items mixed into the array", async () => {
		const valid = makeItem(0);
		const result = await analyzeAndGenerate(
			makeOpts(async () => JSON.stringify([valid, "junk", 42, null])),
		);
		expect(isError(result)).toBe(false);
		if (isError(result)) return;
		expect(result).toHaveLength(1);
	});

	it("drops items whose original snippet is absent from the source", async () => {
		const valid = makeItem(0); // original "return a + b" is present once
		const absent = { ...makeItem(1), original: "return a * b" };
		const result = await analyzeAndGenerate(
			makeOpts(async () => JSON.stringify([valid, absent])),
		);
		expect(isError(result)).toBe(false);
		if (isError(result)) return;
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("m001");
	});

	it("drops items whose original snippet is ambiguous (appears >1 time)", async () => {
		const ambiguous = { ...makeItem(0), original: "a + b" };
		const result = await analyzeAndGenerate(
			makeOpts(async () => JSON.stringify([ambiguous]), {
				sourceCode: "x = a + b\ny = a + b",
			}),
		);
		expect(isError(result)).toBe(true);
		if (!isError(result)) return;
		expect(result.kind).toBe("parse_error");
		expect(result.message).toContain("exactly once");
	});

	it("returns parse_error when every item is structurally invalid", async () => {
		const result = await analyzeAndGenerate(
			makeOpts(async () => JSON.stringify(["junk", 42, null, { id: "m001" }])),
		);
		expect(isError(result)).toBe(true);
		if (!isError(result)) return;
		expect(result.kind).toBe("parse_error");
		expect(result.message).toContain("required fields");
	});

	it("returns llm_error when llmCall rejects", async () => {
		const result = await analyzeAndGenerate(
			makeOpts(async () => {
				throw new Error("provider timeout");
			}),
		);
		expect(isError(result)).toBe(true);
		if (!isError(result)) return;
		expect(result.kind).toBe("llm_error");
		expect(result.message).toContain("provider timeout");
	});

	it("includes language, scope, target, and sources in the prompt", async () => {
		let captured = "";
		await analyzeAndGenerate(
			makeOpts(
				async (prompt) => {
					captured = prompt;
					return "[]";
				},
				{
					target: "add",
					language: "python",
					scope: "function",
					maxMutations: 5,
				},
			),
		);
		expect(captured).toContain("python");
		expect(captured).toContain("add");
		expect(captured).toContain("return a + b");
		expect(captured).toContain("assert add(1, 2) == 3");
		expect(captured).toContain("5");
		expect(captured).toContain("pytest");
		expect(captured).toContain("suggestion");
	});
});

const mutation: Mutation = {
	id: "m001",
	description: "swap operands",
	hotspot: "line 2",
	original: "return a + b",
	mutated: "return b + a",
	explanation: "commutative",
	suggestion: "assert add(1, 2) == 3",
};

describe("judgeEquivalence", () => {
	it("returns the verdict for a well-formed equivalent response", async () => {
		const verdict = await judgeEquivalence({
			mutation,
			language: "python",
			llmCall: async () => JSON.stringify({ equivalent: true, rationale: "commutative" }),
		});
		expect(verdict).toEqual({ equivalent: true, rationale: "commutative" });
	});

	it("returns equivalent:false with rationale", async () => {
		const verdict = await judgeEquivalence({
			mutation,
			language: "python",
			llmCall: async () => `{"equivalent": false, "rationale": "differs"}`,
		});
		expect(verdict?.equivalent).toBe(false);
	});

	it("parses a verdict wrapped in a markdown fence", async () => {
		const verdict = await judgeEquivalence({
			mutation,
			language: "python",
			llmCall: async () => "```json\n{\"equivalent\": true, \"rationale\": \"x\"}\n```",
		});
		expect(verdict?.equivalent).toBe(true);
	});

	it("returns null when the response is not valid JSON", async () => {
		const verdict = await judgeEquivalence({
			mutation,
			language: "python",
			llmCall: async () => "I think it is equivalent",
		});
		expect(verdict).toBeNull();
	});

	it("returns null when 'equivalent' is missing or non-boolean", async () => {
		const verdict = await judgeEquivalence({
			mutation,
			language: "python",
			llmCall: async () => JSON.stringify({ rationale: "no verdict" }),
		});
		expect(verdict).toBeNull();
	});

	it("returns null when llmCall rejects", async () => {
		const verdict = await judgeEquivalence({
			mutation,
			language: "python",
			llmCall: async () => {
				throw new Error("provider down");
			},
		});
		expect(verdict).toBeNull();
	});
});
