import { describeApiError } from "./api-error-handler.js";
import { DEEP_RESEARCH_TIMEOUT_MS } from "./limits.js";

export interface DeepResearchArgs {
	query: string;
	simplify?: boolean;
	budget_tokens?: number;
	temperature?: number;
}

export interface DeepResearchResult {
	query: string;
	content: string;
	reasoning?: string;
	model: string;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

export interface DeepResearchError {
	error: string;
}

export type DeepResearchResultOrError = DeepResearchResult | DeepResearchError;

/**
 * Execute a deep research query using Jina DeepSearch API (deepsearch.jina.ai).
 * Performs iterative search, read, reflect, and answer loops.
 */
export async function executeDeepResearch(
	args: DeepResearchArgs,
	bearerToken: string,
	baseUrl = "https://deepsearch.jina.ai",
): Promise<DeepResearchResultOrError> {
	try {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			signal: AbortSignal.timeout(DEEP_RESEARCH_TIMEOUT_MS),
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${bearerToken}`,
			},
			body: JSON.stringify({
				model: "jina-deepsearch-v1",
				messages: [
					{
						role: "user",
						content: args.query,
					},
				],
				stream: false,
				...(args.budget_tokens && { max_tokens: args.budget_tokens }),
				...(args.temperature !== undefined && {
					temperature: args.temperature,
				}),
			}),
		});

		if (!response.ok) {
			return {
				error: `Deep research failed for query "${args.query}": ${await describeApiError(response)}`,
			};
		}

		const data = (await response.json()) as any;
		const rawContent: string = data.choices?.[0]?.message?.content || "";

		// Extract reasoning trace if <think> exists
		const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/);
		const reasoning = thinkMatch ? thinkMatch[1].trim() : undefined;
		let content = rawContent;

		if (args.simplify) {
			content = rawContent.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
		}

		return {
			query: args.query,
			content,
			reasoning,
			model: data.model || "jina-deepsearch-v1",
			usage: data.usage,
		};
	} catch (error) {
		return {
			error: `Deep research failed for query "${args.query}": ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
