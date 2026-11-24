import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type DeepResearchResult,
	executeDeepResearch,
} from "../src/utils/deep-research.js";
import { DEEP_RESEARCH_TIMEOUT_MS } from "../src/utils/limits.js";
import { respond, stubFetch } from "./helpers.js";

test("executeDeepResearch sends query to deepsearch.jina.ai with proper auth and model", async () => {
	const { calls, restore } = stubFetch((call) => {
		assert.equal(call.url, "https://deepsearch.jina.ai/v1/chat/completions");
		assert.equal(call.timeoutMs, DEEP_RESEARCH_TIMEOUT_MS);
		assert.equal(call.body.model, "jina-deepsearch-v1");
		assert.equal(
			call.body.messages[0].content,
			"quantum computing developments",
		);
		assert.equal(call.body.stream, false);

		return respond(call.url, 200, {
			id: "chatcmpl-test",
			model: "jina-deepsearch-v1",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content:
							"<think>Analyzing recent breakthroughs...</think>\n\nQuantum processors have reached 1000+ physical qubits [^1].",
					},
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 50,
				completion_tokens: 150,
				total_tokens: 200,
			},
		});
	});

	try {
		const result = await executeDeepResearch(
			{ query: "quantum computing developments" },
			"jina_test_token",
		);

		if ("error" in result) {
			assert.fail(`Expected success but got error: ${result.error}`);
		}

		const data = result as DeepResearchResult;
		assert.equal(data.query, "quantum computing developments");
		assert.equal(data.reasoning, "Analyzing recent breakthroughs...");
		assert.ok(data.content.includes("<think>"));
		assert.ok(data.content.includes("1000+ physical qubits"));
		assert.equal(data.usage?.total_tokens, 200);
		assert.equal(calls.length, 1);
	} finally {
		restore();
	}
});

test("executeDeepResearch strips <think> blocks when simplify is true", async () => {
	const { calls, restore } = stubFetch((call) => {
		return respond(call.url, 200, {
			model: "jina-deepsearch-v1",
			choices: [
				{
					message: {
						role: "assistant",
						content:
							"<think>Step 1: Check sources.\nStep 2: Synthesize.</think>\n\nThis is the clean final answer.",
					},
				},
			],
		});
	});

	try {
		const result = await executeDeepResearch(
			{ query: "summarize topic", simplify: true },
			"jina_test_token",
		);

		if ("error" in result) {
			assert.fail(`Expected success but got error: ${result.error}`);
		}

		const data = result as DeepResearchResult;
		assert.equal(data.content, "This is the clean final answer.");
		assert.equal(data.reasoning, "Step 1: Check sources.\nStep 2: Synthesize.");
		assert.ok(!data.content.includes("<think>"));
	} finally {
		restore();
	}
});

test("executeDeepResearch returns clean error description on API failure", async () => {
	const { restore } = stubFetch((call) => {
		return respond(call.url, 401, {
			error: "Invalid API key provided",
		});
	});

	try {
		const result = await executeDeepResearch(
			{ query: "test failure" },
			"invalid_token",
		);

		assert.ok("error" in result);
		if ("error" in result) {
			assert.ok(result.error.includes("Deep research failed"));
		}
	} finally {
		restore();
	}
});
