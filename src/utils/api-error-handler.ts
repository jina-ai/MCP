/**
 * Pull whatever explanation the API put in the error body.
 *
 * Without this the caller only ever saw the status line, so a 422 "input exceeds
 * the maximum length" was indistinguishable from any other 422 and the model had
 * nothing to act on. Bounded, and never throws.
 */
async function readErrorDetail(response: Response): Promise<string> {
	try {
		const body = (await response.text()).slice(0, 500).trim();
		if (!body) return "";

		try {
			const parsed = JSON.parse(body) as Record<string, any>;
			const detail =
				parsed?.detail ??
				parsed?.message ??
				parsed?.error?.message ??
				(typeof parsed?.error === "string" ? parsed.error : undefined);
			if (detail) return typeof detail === "string" ? detail : JSON.stringify(detail);
		} catch {
			// not JSON, fall through to the raw body
		}

		return body;
	} catch {
		return "";
	}
}

/**
 * Utility function to handle common API errors for Jina AI services
 * Returns a standardized error response object for MCP tools
 */
export async function handleApiError(response: Response, context: string = "API request") {
	if (response.status === 401) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Authentication failed. Please set your API key in the Jina AI MCP settings. You can get a free API key by visiting https://jina.ai and signing up for an account.",
				},
			],
			isError: true,
		};
	}
	if (response.status === 402) {
		return {
			content: [
				{
					type: "text" as const,
					text: "This key is out of quota. Please top up this key at https://jina.ai",
				},
			],
			isError: true,
		};
	}
	
	if (response.status === 429) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Rate limit exceeded. Please upgrade your API key to get higher rate limits. Visit https://jina.ai to manage your subscription and increase your usage limits.",
				},
			],
			isError: true,
		};
	}
	
	// Default error message for other HTTP errors
	const detail = await readErrorDetail(response);
	return {
		content: [
			{
				type: "text" as const,
				text: `Error: ${context} failed - ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
			},
		],
		isError: true,
	};
}

/**
 * Check if bearer token is available and return appropriate error message if not
 */
export function checkBearerToken(bearerToken: string | undefined) {
	if (!bearerToken) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Please set your API key in the Jina AI MCP settings. You can get a free API key by visiting https://jina.ai and signing up for an account.",
				},
			],
			isError: true,
		};
	}
	return null; // No error, token is available
}
