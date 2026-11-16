/**
 * Pull whatever explanation the API put in the error body.
 *
 * Without this the caller only ever saw the status line, so a 422 "input exceeds
 * the maximum length" was indistinguishable from any other 422 and the model had
 * nothing to act on. Bounded, and never throws.
 */
async function readErrorDetail(response: Response): Promise<{ text: string; fromApi: boolean }> {
	try {
		const body = (await response.text()).slice(0, 500).trim();
		if (!body) return { text: "", fromApi: false };

		try {
			const parsed = JSON.parse(body) as Record<string, any>;
			const detail =
				parsed?.detail ??
				parsed?.message ??
				parsed?.error?.message ??
				(typeof parsed?.error === "string" ? parsed.error : undefined);
			if (detail) {
				return { text: typeof detail === "string" ? detail : JSON.stringify(detail), fromApi: true };
			}
		} catch {
			// not JSON, fall through to the raw body
		}

		// Whatever stood in front of the API wrote this (a proxy's error page, a
		// platform's plain-text notice). Useful next to a bare status line, but
		// not something to quote as the API's reason.
		return { text: body, fromApi: false };
	} catch {
		return { text: "", fromApi: false };
	}
}

const AUTH_FAILED_MESSAGE = "Authentication failed. Please set your API key in the Jina AI MCP settings. You can get a free API key by visiting https://jina.ai and signing up for an account.";
const OUT_OF_QUOTA_MESSAGE = "This key is out of quota. Please top up this key at https://jina.ai";
const RATE_LIMITED_MESSAGE = "Rate limit exceeded. Please upgrade your API key to get higher rate limits. Visit https://jina.ai to manage your subscription and increase your usage limits.";
const SVIP_AT_CAPACITY_MESSAGE = "The search service is temporarily at capacity. This is not a limit on your API key, so upgrading it will not help.";

/** Statuses about the caller's key rather than the request, answered with a fixed message */
const ACCOUNT_ERROR_MESSAGES: Record<number, string> = {
	401: AUTH_FAILED_MESSAGE,
	402: OUT_OF_QUOTA_MESSAGE,
	429: RATE_LIMITED_MESSAGE,
};

/**
 * When the service said to come back, for the statuses where waiting helps.
 *
 * Retry-After was read by nothing, so a model told "rate limited" or "at
 * capacity" had no way to know whether to try again in a second or a minute
 * and usually tried at once.
 */
function retryHint(response: Response): string {
	if (response.status !== 429 && response.status !== 503) return "";

	const header = response.headers.get("retry-after");
	if (!header) return "";

	const asSeconds = Number(header);
	const wait = Number.isFinite(asSeconds) ? asSeconds : (Date.parse(header) - Date.now()) / 1000;
	if (!Number.isFinite(wait) || wait <= 0) return "";

	return ` Retry after ${Math.ceil(wait)}s.`;
}

/**
 * Whether the response came from svip.jina.ai (search, question reads,
 * extract_pdf) rather than api.jina.ai or r.jina.ai.
 *
 * Read off the response instead of passed in by each caller, so a new svip
 * call cannot forget to say so.
 */
function isFromSvip(response: Response): boolean {
	try {
		return new URL(response.url).hostname === "svip.jina.ai";
	} catch {
		return false;
	}
}

/**
 * Describe why a Jina API call failed, in words a model can act on.
 *
 * Shared by handleApiError and the search tools, which return per-query errors
 * as strings. Those used to carry only the status line ("Unauthorized"), so an
 * expired key or an exhausted quota looked like any other failure.
 *
 * The fixed messages for 401, 402 and 429 used to replace whatever the API had
 * said, which lost two distinctions:
 *
 * - svip rejects a key for more than one reason (unknown to the auth service,
 *   refused by billing) and says which in the body. All of them came out as
 *   "please set your API key", to a caller who had set one. The API's own
 *   reason is now appended.
 * - A 429 from svip is never about the key: svip has no per-key rate limit,
 *   so the status only comes from the platform in front of it running out of
 *   instances. Telling the caller to upgrade their key sent them to fix
 *   something that was not broken.
 */
export async function describeApiError(response: Response): Promise<string> {
	const detail = await readErrorDetail(response);
	const reason = detail.fromApi ? ` Reason given: ${detail.text}` : "";
	const retry = retryHint(response);

	if (response.status === 429 && isFromSvip(response)) {
		return `${SVIP_AT_CAPACITY_MESSAGE}${retry || " Retry in a few seconds."}${reason}`;
	}

	const accountError = ACCOUNT_ERROR_MESSAGES[response.status];
	if (accountError) return `${accountError}${retry}${reason}`;

	const statusLine = `${response.status} ${response.statusText}${detail.text ? ` - ${detail.text}` : ""}`;
	// The detail may or may not end its own sentence.
	return retry ? `${statusLine.replace(/[.\s]+$/, "")}.${retry}` : statusLine;
}

/**
 * Utility function to handle common API errors for Jina AI services
 * Returns a standardized error response object for MCP tools
 */
export async function handleApiError(response: Response, context: string = "API request") {
	const description = await describeApiError(response);
	return {
		content: [
			{
				type: "text" as const,
				// The account messages are complete sentences about the key, not
				// about this request, so they are not prefixed with the context.
				text: response.status in ACCOUNT_ERROR_MESSAGES
					? description
					: `Error: ${context} failed - ${description}`,
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
