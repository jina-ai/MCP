import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJinaTools } from "./tools/jina-tools.js";
import { stringify as yamlStringify } from "yaml";

// Build-time constants (can be replaced by build tools)
const SERVER_VERSION = "1.2.0"; // This could be replaced by CI/CD
const SERVER_NAME = "jina-mcp";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Jina AI Official MCP Server",
		description: "Official MCP for Jina AI API.",
		version: SERVER_VERSION,
	});


	async init() {
		// Register all Jina AI tools
		registerJinaTools(this.server, () => this.props);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const cf = request.cf;

		// Extract bearer token from Authorization header
		const authHeader = request.headers.get("Authorization");
		if (authHeader?.startsWith("Bearer ")) {
			ctx.props = { bearerToken: authHeader.substring(7) };
		}

		// if no bearer token add a debug one from env 
		if (!ctx.props.bearerToken && env.JINA_API_KEY) {
			ctx.props.bearerToken = env.JINA_API_KEY;
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
		ctx.props = { ...ctx.props, context };

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
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
		"url": "https://mcp.jina.ai/sse",
		"headers": {
		"Authorization": "Bearer \${JINA_API_KEY}" // optional
		}
	}
	}
}
`,
				get_api_key: "https://jina.ai/api-dashboard/",
				endpoints: {
					sse: "/sse - Server-Sent Events endpoint (recommended)",
					mcp: "/mcp - Standard JSON-RPC endpoint"
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
			available_endpoints: ["/", "/sse", "/mcp"],
			suggestion: "Use /sse for MCP client connections"
		}), {
			headers: { "Content-Type": "text/yaml" },
			status: 404
		});
	},
};
