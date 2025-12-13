import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJinaTools } from "./tools/jina-tools.js";
import { stringify as yamlStringify } from "yaml";

// Build-time constants (can be replaced by build tools)
const SERVER_VERSION = "1.4.0"; // Bumped version for stateless rewrite
const SERVER_NAME = "jina-mcp";

// Tool tags mapping for filtering
const TOOL_TAGS: Record<string, string[]> = {
	search: ["search_web", "search_arxiv", "search_ssrn", "search_images", "search_jina_blog"],
	parallel: ["parallel_search_web", "parallel_search_arxiv", "parallel_search_ssrn", "parallel_read_url"],
	read: ["read_url", "parallel_read_url", "capture_screenshot_url"],
	utility: ["primer", "show_api_key", "expand_query", "guess_datetime_url"],
	rerank: ["sort_by_relevance", "deduplicate_strings", "deduplicate_images"],
};

// All available tools
const ALL_TOOLS = [
	"primer", "show_api_key", "read_url", "capture_screenshot_url", "guess_datetime_url",
	"search_web", "search_arxiv", "search_ssrn", "search_images", "search_jina_blog", "expand_query",
	"parallel_search_web", "parallel_search_arxiv", "parallel_search_ssrn", "parallel_read_url",
	"sort_by_relevance", "deduplicate_strings", "deduplicate_images"
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

// Props storage for the current request (used by tools)
let currentProps: Record<string, unknown> = {};

// Create the MCP server instance
function createServer(enabledTools: Set<string> | null) {
	const server = new McpServer({
		name: "Jina AI Official MCP Server",
		version: SERVER_VERSION,
	});

	// Register all Jina AI tools with optional filtering
	registerJinaTools(server, () => currentProps, enabledTools);

	return server;
}

// Cache servers by their enabled tools configuration
const serverCache = new Map<string, McpServer>();

function getOrCreateServer(enabledTools: Set<string> | null): McpServer {
	const cacheKey = enabledTools ? Array.from(enabledTools).sort().join(",") : "all";

	if (!serverCache.has(cacheKey)) {
		serverCache.set(cacheKey, createServer(enabledTools));
	}

	return serverCache.get(cacheKey)!;
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

		// if no bearer token add a debug one from env
		if (!props.bearerToken && env.JINA_API_KEY) {
			props.bearerToken = env.JINA_API_KEY;
		}

		// Add Ghost API key for Jina blog search
		props.ghostApiKey = env.VITE_GHOST_API_KEY;

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

		// Set current props for tools to access
		currentProps = props;

		// Get or create server with the appropriate tool filter
		const server = getOrCreateServer(enabledTools);

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
						exclude_tags: "Comma-separated tags to exclude (e.g., parallel,search)",
						include_tags: "Comma-separated tags to include"
					},
					tags: TOOL_TAGS,
					examples: [
						"/v1?exclude_tags=parallel - Exclude all parallel_* tools",
						"/v1?include_tags=search,read - Only include search and read tools",
						"/v1?exclude_tools=search_images,deduplicate_images - Exclude specific tools"
					],
					precedence: "exclude_tools > exclude_tags > include_tools > include_tags"
				},
				tools: [
					"primer - Provide timezone-aware timestamps, user location, network details, and client context",
					"read_url - Extract clean content from web pages",
					"capture_screenshot_url - Capture high-quality screenshots of web pages",
					"guess_datetime_url - Analyze web pages for last update/publish datetime",
					"search_web - Search the web for current information",
					"search_arxiv - Search academic papers on arXiv",
					"search_ssrn - Search academic papers on SSRN (Social Science Research Network)",
					"search_images - Search for images across the web (similar to Google Images)",
					"search_jina_blog - Search Jina AI news at jina.ai/news for articles, tutorials, and announcements",
					"expand_query - Expand and rewrite search queries based on the query expansion model",
					"parallel_read_url - Read multiple web pages in parallel for content extraction",
					"parallel_search_web - Run multiple web searches in parallel for topic coverage and diverse perspectives",
					"parallel_search_arxiv - Run multiple arXiv searches in parallel for research coverage and diverse academic angles",
					"parallel_search_ssrn - Run multiple SSRN searches in parallel for social science research coverage",
					"sort_by_relevance - Rerank documents by relevance to a query",
					"deduplicate_strings - Get top-k semantically unique strings",
					"deduplicate_images - Get top-k semantically unique images"
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
