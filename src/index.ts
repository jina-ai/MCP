import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJinaTools } from "./tools/jina-tools.js";
import { stringify as yamlStringify } from "yaml";

// Build-time constants (can be replaced by build tools)
const SERVER_VERSION = "1.9.0";
const SERVER_NAME = "jina-mcp";

// Tool tags mapping for filtering
const TOOL_TAGS: Record<string, string[]> = {
	search: ["search_web", "search_arxiv", "search_ssrn", "search_images", "search_jina_blog"],
	read: ["read_url", "capture_screenshot_url"],
	utility: ["primer", "guess_datetime_url", "extract_pdf"],
	rerank: ["sort_by_relevance", "deduplicate_strings"],
};

// All available tools
const ALL_TOOLS = [
	"primer", "read_url", "capture_screenshot_url", "guess_datetime_url",
	"search_web", "search_arxiv", "search_ssrn", "search_images", "search_jina_blog",
	"sort_by_relevance", "deduplicate_strings", "extract_pdf"
];
// Parse tool filter from query parameters
function parseToolFilter(url: URL): Set<string> | null {
	const includeTools = url.searchParams.get("include_tools");
	const excludeTools = url.searchParams.get("exclude_tools");
	const includeTags = url.searchParams.get("include_tags");
	const excludeTags = url.searchParams.get("exclude_tags");

	// If no filters specified, return null (all tools enabled)
	if (!includeTools && !excludeTools && !includeTags && !excludeTags) {
		return null;
	}

	// Start with all tools, unless include_tags or include_tools is specified (then start empty)
	let enabledTools = (includeTags || includeTools)
		? new Set<string>()
		: new Set<string>(ALL_TOOLS);

	// Apply include_tags first (lowest priority) - add tagged tools
	if (includeTags) {
		const tags = includeTags.split(",").map(t => t.trim().toLowerCase());
		for (const tag of tags) {
			if (TOOL_TAGS[tag]) {
				for (const tool of TOOL_TAGS[tag]) {
					enabledTools.add(tool);
				}
			}
		}
	}

	// Apply include_tools - add specific tools
	if (includeTools) {
		const tools = includeTools.split(",").map(t => t.trim());
		for (const tool of tools) {
			if (ALL_TOOLS.includes(tool)) {
				enabledTools.add(tool);
			}
		}
	}

	// Apply exclude_tags - remove tagged tools
	if (excludeTags) {
		const tags = excludeTags.split(",").map(t => t.trim().toLowerCase());
		for (const tag of tags) {
			if (TOOL_TAGS[tag]) {
				for (const tool of TOOL_TAGS[tag]) {
					enabledTools.delete(tool);
				}
			}
		}
	}

	// Apply exclude_tools last (highest priority) - remove specific tools
	if (excludeTools) {
		const tools = excludeTools.split(",").map(t => t.trim());
		for (const tool of tools) {
			enabledTools.delete(tool);
		}
	}

	return enabledTools;
}


// Server instructions for MCP tool discovery (SEO for LLM tool search).
// Kept to what actually routes a request: which tool, and the distinctions
// between near-identical ones. The phrase lists this replaced restated the tool
// names in a dozen ways each and were paid for on every request.
const SERVER_INSTRUCTIONS = `Web access: search the live web, read URLs, search academic papers, and run Jina embedding/reranker utilities.

Use for anything online - current events, a URL the user pasted, a claim needing a source. Not for local files, code execution, or databases.

Picking a tool:
- search_web returns titles, URLs and engine snippets. For page-level passages, pass \`question\` to read_url on the results you chose. A snippet is not a source for exact values: verify version numbers, commands and error strings against the page.
- read_url fetches one page as markdown. Pass its \`question\` to get only the answering passages instead of the whole body; this is much cheaper than reading a full page into context.
- \`search_web\`, \`search_arxiv\`, \`search_ssrn\` and \`read_url\` accept an array on \`query\`/\`url\`; pass an array to run them concurrently instead of repeating single calls.
- search_arxiv for preprints, search_ssrn for social science and finance, search_jina_blog for Jina's own models and releases.
- primer supplies the current time and user location; call it before answering anything time- or location-dependent.`;

// Create the MCP server instance with request-scoped props
// Note: We create a fresh server per request to avoid race conditions with concurrent requests
// The props are captured in the closure at creation time, ensuring each request has its own context
function createServer(enabledTools: Set<string> | null, props: Record<string, unknown>) {
	const server = new McpServer(
		{
			name: "Jina AI Official MCP Server",
			version: SERVER_VERSION,
		},
		{
			instructions: SERVER_INSTRUCTIONS,
		}
	);

	// Register all Jina AI tools with props captured in closure (request-scoped)
	registerJinaTools(server, () => props, enabledTools);

	return server;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const cf = request.cf;

		// Parse tool filter from query parameters
		const enabledTools = parseToolFilter(url);

		// Build props for this request
		const props: Record<string, unknown> = { enabledTools };

		// Extract bearer token from Authorization header
		const authHeader = request.headers.get("Authorization");
		if (authHeader?.startsWith("Bearer ")) {
			props.bearerToken = authHeader.substring(7);
		}

		// Remember whether the credential came from the caller, so tools that echo
		// it back can tell it apart from the deployment fallback applied below.
		props.bearerTokenFromRequest = Boolean(props.bearerToken);

		// if no bearer token add a debug one from env
		if (!props.bearerToken && env.JINA_API_KEY) {
			props.bearerToken = env.JINA_API_KEY;
		}

		// Add Ghost API key for Jina blog search
		props.ghostApiKey = env.VITE_GHOST_API_KEY;

		// API base URL for embedding/reranker endpoints (bypasses Cloudflare proxy issues)
		props.apiBaseUrl = env.API_BASE_URL || 'https://api.jina.ai';

		// Client identity for the response-size guardrail. This server is stateless -
		// createMcpHandler gets no `storage`, so WorkerTransport never replays the
		// `initialize` params into the per-request server and
		// server.getClientVersion() is undefined during `tools/call`. Pass the
		// transport User-Agent as a fallback hint, and let any client state its own
		// budget explicitly with ?max_tokens= (0 disables truncation).
		props.clientHint = request.headers.get("User-Agent") || undefined;

		const maxTokensParam = url.searchParams.get("max_tokens");
		if (maxTokensParam !== null) {
			const parsed = Number.parseInt(maxTokensParam, 10);
			if (Number.isFinite(parsed) && parsed >= 0) {
				props.maxResponseTokens = parsed;
			}
		}

		// Extract context information for the primer tool
		const context: any = {};

		// Add timestamp info
		context.timestamp = {
			utc: new Date().toISOString(),
		};
		if (cf?.timezone) {
			context.timestamp.userTimezone = cf.timezone;
			context.timestamp.userLocalTime = new Date().toLocaleString('en-US', { timeZone: cf.timezone as string });
		}

		// Add client info (only if values exist)
		const client: any = {};
		const clientIp = request.headers.get('CF-Connecting-IP');
		const userAgent = request.headers.get('User-Agent');
		const acceptLanguage = request.headers.get('Accept-Language');

		if (clientIp) client.ip = clientIp;
		if (userAgent) client.userAgent = userAgent;
		if (acceptLanguage) client.acceptLanguage = acceptLanguage;
		if (Object.keys(client).length > 0) context.client = client;

		// Add location info (only if values exist)
		const location: any = {};
		if (cf?.country) location.country = cf.country;
		if (cf?.city) location.city = cf.city;
		if (cf?.region) location.region = cf.region;
		if (cf?.regionCode) location.regionCode = cf.regionCode;
		if (cf?.continent) location.continent = cf.continent;
		if (cf?.postalCode) location.postalCode = cf.postalCode;
		if (cf?.metroCode) location.metroCode = cf.metroCode;
		if (cf?.timezone) location.timezone = cf.timezone;
		if (cf?.latitude && cf?.longitude) {
			location.coordinates = {
				lat: cf.latitude,
				lon: cf.longitude
			};
		}
		if (cf?.isEUCountry === "1") location.isEU = true;
		if (Object.keys(location).length > 0) context.location = location;

		// Add network info (only if values exist)
		const network: any = {};
		if (cf?.asn) network.asn = cf.asn;
		if (cf?.asOrganization) network.organization = cf.asOrganization;
		if (cf?.colo) network.datacenter = cf.colo;
		if (cf?.httpProtocol) network.protocol = cf.httpProtocol;
		if (cf?.tlsVersion) network.tlsVersion = cf.tlsVersion;
		if (Object.keys(network).length > 0) context.network = network;

		// Add context to props
		props.context = context;

		// Create server with request-scoped props (fresh per request to avoid race conditions)
		const server = createServer(enabledTools, props);

		// Handle MCP endpoints using createMcpHandler (stateless, no Durable Objects)
		// /v1 is the primary endpoint, /sse is kept for backward compatibility
		if (url.pathname === "/v1" || url.pathname === "/sse" || url.pathname === "/sse/message") {
			const route = url.pathname === "/v1" ? "/v1" : "/sse";
			const handler = createMcpHandler(server, {
				route,
				corsOptions: {
					origin: "*",
					methods: "GET, POST, DELETE, OPTIONS",
					headers: "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version",
					exposeHeaders: "mcp-session-id",
				}
			});

			return handler(request, env, ctx);
		}

		// Handle root path with helpful information
		if (url.pathname === "/") {
			const info = {
				name: "Jina AI Official MCP Server",
				source_code: "https://github.com/jina-ai/MCP",
				description: "Official Model Context Protocol server for Jina AI APIs",
				version: SERVER_VERSION,
				package_name: SERVER_NAME,
				usage: `
{
	"mcpServers": {
	"jina-mcp-server": {
		"url": "https://mcp.jina.ai/v1",
		"headers": {
		"Authorization": "Bearer \${JINA_API_KEY}" // optional
		}
	}
	}
}
`,
				get_api_key: "https://jina.ai/api-dashboard/",
				endpoints: {
					v1: "/v1 - Primary endpoint",
					sse: "/sse - Alias for /v1 (backward compatibility)"
				},
				tool_filtering: {
					description: "Reduce token usage by filtering tools via query parameters",
					parameters: {
						exclude_tools: "Comma-separated tool names to exclude (e.g., search_web,search_arxiv)",
						include_tools: "Comma-separated tool names to include",
						exclude_tags: "Comma-separated tags to exclude (e.g., search,read)",
						include_tags: "Comma-separated tags to include",
						max_tokens: "Cap the size of read_url responses in tokens (0 disables truncation)"
					},
					tags: TOOL_TAGS,
					examples: [
						"/v1?exclude_tags=search - Exclude all search tools",
						"/v1?include_tags=search,read - Only include search and read tools",
						"/v1?exclude_tools=search_ssrn,search_images - Exclude specific tools"
					],
					precedence: "exclude_tools > exclude_tags > include_tools > include_tags"
				},
				tools: [
					"primer - Current time, user timezone, location and client context",
					"read_url - Read a web page or PDF as markdown; pass question for passages instead of the full body",
					"capture_screenshot_url - Capture a screenshot of a web page",
					"guess_datetime_url - Guess a page publish or last-update datetime with a confidence score",
					"search_web - Search the web; returns titles, URLs and engine snippets; query accepts an array",
					"search_arxiv - Search arXiv preprints; query accepts an array",
					"search_ssrn - Search SSRN working papers; query accepts an array",
					"search_images - Search the web for images",
					"search_jina_blog - Search Jina AI news at jina.ai/news",
					"sort_by_relevance - Rerank documents by relevance to a query",
					"deduplicate_strings - Select top-k semantically distinct strings",
					"extract_pdf - Extract figures, tables and equations from a PDF"
				]
			};

			return new Response(yamlStringify(info), {
				headers: { "Content-Type": "text/yaml" },
				status: 200
			});
		}

		// Return helpful 404 for unknown paths
		return new Response(yamlStringify({
			error: "Endpoint not found",
			message: `Path '${url.pathname}' is not available`,
			available_endpoints: ["/", "/v1", "/sse"],
			suggestion: "Use /v1 for MCP client connections"
		}), {
			headers: { "Content-Type": "text/yaml" },
			status: 404
		});
	},
};
