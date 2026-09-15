import { z } from "zod";
import { stringify as yamlStringify } from "yaml";

import { handleApiError, checkBearerToken } from "../utils/api-error-handler.js";
import { lazyGreedySelection, lazyGreedySelectionWithSaturation } from "../utils/submodular-optimization.js";
import { downloadImages } from "../utils/image-downloader.js";
import { applyTokenGuardrail } from "../utils/token-guardrail.js";
import {
	executeParallelSearches,
	executeWebSearch,
	executeWebDeepSearch,
	executeArxivSearch,
	executeSsrnSearch,
	executeImageSearch,
	executeJinaBlogSearch,
	type SearchWebArgs,
	type SearchWebDeepArgs,
	type SearchArxivArgs,
	type SearchSsrnArgs,
	type SearchImageArgs,
	type SearchJinaBlogArgs,
	formatSingleSearchResultToContentItems,
	formatParallelSearchResultsToContentItems
} from "../utils/search.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Wall-clock budget for a parallel batch. Not a caller parameter: a model has
 *  no basis for choosing a millisecond budget, and the old arg only ever got
 *  its default. */
const PARALLEL_TIMEOUT_MS = 30000;
/** Question-grounded reads add a chunk-and-rerank pass after the fetch. */
const QUESTION_READ_TIMEOUT_MS = 60000;
/** Embedding model behind classify_text. An implementation detail, not a choice
 *  the caller should have to make. */
const CLASSIFY_MODEL = "jina-embeddings-v5-text-small";

/**
 * Guess the media type of a raw base64 image from its leading bytes.
 *
 * Caller-supplied base64 is passed through untouched, so labelling it
 * "image/jpeg" (as this used to) mislabels every PNG/GIF/WebP the caller sends.
 */
function sniffBase64ImageMimeType(base64: string): string {
	const head = base64.slice(0, 16);
	if (head.startsWith('iVBORw0KGgo')) return 'image/png';
	if (head.startsWith('R0lGOD')) return 'image/gif';
	if (head.startsWith('UklGR')) return 'image/webp';
	if (head.startsWith('PHN2Zy') || head.startsWith('PD94bW')) return 'image/svg+xml';
	return 'image/jpeg';
}

const SCREENSHOT_TIMEOUT_MS = 60000;
const SCREENSHOT_DOWNLOAD_TIMEOUT_MS = 20000;

export function registerJinaTools(server: McpServer, getProps: () => any, enabledTools: Set<string> | null = null) {
	// Helper to get client name for guardrail check
	// getClientVersion() only has a value on the server instance that handled
	// `initialize`; this deployment builds a fresh server per request, so it is
	// undefined at tool-call time. props.clientHint (the transport User-Agent,
	// set in index.ts) is the fallback that keeps the guardrail reachable.
	const getClientName = () => server.server.getClientVersion()?.name ?? (getProps().clientHint as string | undefined);
	// Helper function to create error responses
	const createErrorResponse = (message: string) => ({
		content: [{ type: "text" as const, text: message }],
		isError: true,
	});
	// Helper to check if a tool is enabled
	const isToolEnabled = (toolName: string) => enabledTools === null || enabledTools.has(toolName);

	// Show API key tool - returns the bearer token from request headers
	if (isToolEnabled("show_api_key")) {
		server.tool(
			"show_api_key",
			"Return the bearer token from MCP settings. For debugging.",
			{},
			async () => {
				const props = getProps();
				// props.bearerToken is not necessarily the caller's own credential -
				// index.ts falls back to the deployment's configured key. This tool
				// exists to echo back what the caller sent, so gate on that.
				if (!props.bearerTokenFromRequest) {
					return createErrorResponse("No bearer token found in request");
				}
				return {
					content: [{ type: "text" as const, text: props.bearerToken as string }],
				};
			},
		);
	}

	// Primer tool - provides current world knowledge for LLMs
	if (isToolEnabled("primer")) {
		server.tool(
			"primer",
			"Current time, user location and network environment for the session. Use before answering anything time- or location-dependent.",
			{},
			async () => {
				try {
					const props = getProps();
					const context = props.context;

					if (!context) {
						throw new Error("No context information available");
					}

					return {
						content: [{ type: "text" as const, text: yamlStringify(context) }],
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Guess datetime from URL tool - analyzes web pages for datetime information
	if (isToolEnabled("guess_datetime_url")) {
		server.tool(
			"guess_datetime_url",
			"Guess when a page was published or last updated, with a confidence score. Checks HTTP headers, metadata, Schema.org, visible dates, feeds and sitemaps.",
			{
				url: z.string().url()
			},
			async ({ url }: { url: string }) => {
				try {
					// Import the utility function
					const { guessDatetimeFromUrl } = await import("../utils/guess-datetime.js");

					// Analyze the URL for datetime information
					const result = await guessDatetimeFromUrl(url);

					return {
						content: [{ type: "text" as const, text: yamlStringify(result) }],
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Screenshot tool - captures web page screenshots
	if (isToolEnabled("capture_screenshot_url")) {
		server.tool(
			"capture_screenshot_url",
			"Screenshot a page as base64 JPEG. Use when the page must be seen rather than read.",
			{
				url: z.string().url(),
				firstScreenOnly: z.boolean().default(false).describe("Capture only the first screen instead of the full page. Faster."),
				return_url: z.boolean().default(false).describe("Return URLs instead of base64 images.")
			},
			async ({ url, firstScreenOnly, return_url }: { url: string; firstScreenOnly: boolean; return_url: boolean }) => {
				try {
					const props = getProps();
					const headers: Record<string, string> = {
						'Accept': 'application/json',
						'Content-Type': 'application/json',
						'X-Return-Format': firstScreenOnly === true ? 'screenshot' : 'pageshot',
					};

					// Add Authorization header if bearer token is available
					if (props.bearerToken) {
						headers['Authorization'] = `Bearer ${props.bearerToken}`;
					}

					const response = await fetch('https://r.jina.ai/', {
						method: 'POST',
						signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS),
						headers,
						body: JSON.stringify({ url }),
					});

					if (!response.ok) {
						return handleApiError(response, "Screenshot capture");
					}

					const data = await response.json() as any;

					// Get the screenshot URL from the response. An unexpected payload used
					// to surface as "Cannot read properties of undefined" rather than
					// anything a caller could act on.
					const imageUrl = data?.data?.screenshotUrl || data?.data?.pageshotUrl;
					if (!imageUrl) {
						throw new Error("No screenshot URL received from API");
					}

					// Prepare response content - always return as list structure for consistency
					const contentItems: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

					if (return_url) {
						// Return the URL as text
						contentItems.push({
							type: "text" as const,
							text: imageUrl,
						});
					} else {
						// Download and process the image. A pageshot is a full-page capture
						// (often 1280x20000); fitting that inside an 800x800 box left a
						// ~51px-wide sliver in which nothing was legible. Constrain the
						// width only and let the height follow.
						const processedResults = await downloadImages(imageUrl, 1, SCREENSHOT_DOWNLOAD_TIMEOUT_MS, {
							width: 1024,
							height: firstScreenOnly === true ? 1024 : null,
						});
						const processedResult = processedResults[0];

						if (!processedResult?.success) {
							throw new Error(`Failed to process screenshot: ${processedResult?.error ?? 'download timed out'}`);
						}

						contentItems.push({
							type: "image" as const,
							data: processedResult.data!,
							mimeType: "image/jpeg",
						});
					}

					return {
						content: contentItems,
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Read URL tool - converts any URL to markdown via r.jina.ai
	if (isToolEnabled("read_url")) {
		server.tool(
			"read_url",
			"Fetch a URL (page or PDF) as clean markdown. Pass `question` to get only the passages answering it instead of the whole page - far cheaper than reading the full body into context.",
			{
				url: z.union([z.string().url(), z.array(z.string().url()).min(1).max(5)]).describe("Page or PDF URL, or up to 5 URLs to read in parallel."),
				withAllLinks: z.boolean().optional().describe("Also return every link on the page."),
				withAllImages: z.boolean().optional().describe("Also return every image on the page."),
				question: z.string().optional().describe("Return only the passages answering this question, instead of the full body. Omit for the whole page."),
				chunk_size: z.number().int().min(1).max(4096).optional().describe("Passage size in words, default 100. Larger gives more surrounding context, smaller pinpoints the answer. Comparable across scripts. Needs `question`."),
				topk: z.number().int().min(1).max(50).optional().describe("Passages to return, default 1. Needs `question`."),
				ocr: z.boolean().optional().describe("Read the rendered page as an image with jina-ocr-v1 instead of its HTML. Use for scanned documents and PDFs whose text is not in the markup, and to keep formulas and table structure. Parses ONE page per call, page 1 unless `page` says otherwise, and costs about 40x the tokens per page, so leave off unless the HTML path has failed you."),
				page: z.number().int().min(1).optional().describe("Which page the OCR pass should parse, 1-based. Needs `ocr`; the HTML path returns the whole document at once.")
			},
			async ({ url, withAllLinks, withAllImages, question, chunk_size, topk, ocr, page }: { url: string | string[]; withAllLinks?: boolean; withAllImages?: boolean; question?: string; chunk_size?: number; topk?: number; ocr?: boolean; page?: number }) => {
				try {
					const props = getProps();

					// Chunking and reranking happen after the page has been fetched, so a
					// question-grounded read needs headroom beyond the plain read budget.
					const readTimeout = question ? 60000 : 30000;

					// Handle single URL or single-element array
					if (typeof url === 'string' || (Array.isArray(url) && url.length === 1)) {
						const singleUrl = typeof url === 'string' ? url : url[0];

						// Import the utility function
						const { readUrlFromConfig } = await import("../utils/read.js");

						// Use the shared utility function
						const result = await readUrlFromConfig({ url: singleUrl, withAllLinks: withAllLinks || false, withAllImages: withAllImages || false, question, chunk_size, topk, ocr, page }, props.bearerToken);

						if ('error' in result) {
							return createErrorResponse(result.error);
						}

						return applyTokenGuardrail({
							content: [{
								type: "text" as const,
								text: yamlStringify(result.structuredData),
							}],
						}, props.bearerToken, getClientName(), props.apiBaseUrl, props.maxResponseTokens);
					}

					// Handle multiple URLs with parallel reading
					if (Array.isArray(url) && url.length > 1) {
						const urls = url.map(u => ({ url: u, withAllLinks: withAllLinks || false, withAllImages: withAllImages || false, question, chunk_size, topk, ocr, page }));

						const uniqueUrls = urls.filter((urlConfig, index, self) =>
							index === self.findIndex(u => u.url === urlConfig.url)
						);

						// Import the utility functions
						const { executeParallelUrlReads } = await import("../utils/read.js");

						// Execute parallel URL reads using the utility
						const results = await executeParallelUrlReads(uniqueUrls, props.bearerToken, readTimeout);

						// Format results for consistent output
						const contentItems: Array<{ type: 'text'; text: string }> = [];

						for (const result of results) {
							if ('success' in result && result.success) {
								contentItems.push({
									type: "text" as const,
									text: yamlStringify(result.structuredData),
								});
							} else if ('error' in result) {
								contentItems.push({
									type: "text" as const,
									text: `Error reading ${result.url}: ${result.error}`,
								});
							}
						}

						return applyTokenGuardrail({
							content: contentItems,
						}, props.bearerToken, getClientName(), props.apiBaseUrl, props.maxResponseTokens);
					}

					return createErrorResponse("Invalid URL format");
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Search Web tool - search the web using Jina Search API
	if (isToolEnabled("search_web")) {
		server.tool(
			"search_web",
			"Search the web. Returns titles, URLs and search-engine snippets.",
			{
				query: z.union([z.string(), z.array(z.string()).min(1).max(5)]),
				num: z.number().int().min(1).max(100).default(30),
				tbs: z.string().optional().describe("Age limit: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y (hour to year)."),
				location: z.string().optional(),
				gl: z.string().optional().describe("Country code, e.g. 'de'."),
				hl: z.string().optional().describe("Language code, e.g. 'zh-cn'.")
			},
			async ({ query, num, tbs, location, gl, hl }: { query: string | string[]; num: number; tbs?: string; location?: string; gl?: string; hl?: string }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					// Handle single query or single-element array
					if (typeof query === 'string' || (Array.isArray(query) && query.length === 1)) {
						const singleQuery = typeof query === 'string' ? query : query[0];
						const searchResult = await executeWebSearch({ query: singleQuery, num, tbs, location, gl, hl }, props.bearerToken);

						return {
							content: formatSingleSearchResultToContentItems(searchResult),
						};
					}

					// Handle multiple queries with parallel search
					if (Array.isArray(query) && query.length > 1) {
						const searches = query.map(q => ({ query: q, num, tbs, location, gl, hl }));

						const uniqueSearches = searches.filter((search, index, self) =>
							index === self.findIndex(s => s.query === search.query)
						);

						const webSearchFunction = async (searchArgs: SearchWebArgs) => {
							return executeWebSearch(searchArgs, props.bearerToken);
						};

						const results = await executeParallelSearches(uniqueSearches, webSearchFunction, { timeout: 30000 });

						return {
							content: formatParallelSearchResultsToContentItems(results),
						};
					}

					return createErrorResponse("Invalid query format");
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Search Web Deep tool - deep web search with content-grounded snippets
	if (isToolEnabled("search_web_deep")) {
		server.tool(
			"search_web_deep",
			"Search the web, then read each result page and return the passage that best answers the query. Use when the answer is in page text rather than in titles or snippets. Slower than search_web (2-20s).",
			{
				query: z.string(),
				num: z.number().int().min(1).max(10).default(5).describe("Results to return, 1-10. Each is a fully-read page, so higher is slower."),
				snippet_source: z.enum(["auto", "content"]).default("auto").describe("'auto' keeps whichever is better, the page passage or the engine snippet. 'content' returns only page passages and omits unreadable pages, so you may get fewer than num."),
			},
			async ({ query, num, snippet_source }: { query: string; num: number; snippet_source: 'auto' | 'content' }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					const searchResult = await executeWebDeepSearch(
						{ query, num, snippet_source } as SearchWebDeepArgs,
						props.bearerToken as string
					);

					// snippet_source=content omits pages it could not read rather than
					// padding from the SERP, so an empty result set is a legitimate
					// outcome. Say why instead of returning a bare empty content array,
					// which reads as a malfunction and tells the caller nothing.
					if (!('error' in searchResult) && searchResult.results.length === 0) {
						return {
							content: [{
								type: "text" as const,
								text: snippet_source === 'content'
									? `No content-grounded results for "${query}": no result page could be read and extracted in time. Retry with snippet_source='auto' to allow search-engine snippets, or use search_web.`
									: `No results for "${query}".`,
							}],
						};
					}

					return {
						content: formatSingleSearchResultToContentItems(searchResult),
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Expand Query tool - expand search queries using Jina Search API
	if (isToolEnabled("expand_query")) {
		server.tool(
			"expand_query",
			"Rewrite one query into several diverse queries, for broader search coverage.",
			{
				query: z.string()
			},
			async ({ query }: { query: string }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					const response = await fetch('https://svip.jina.ai/', {
						method: 'POST',
						headers: {
							'Accept': 'application/json',
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${props.bearerToken}`,
						},
						body: JSON.stringify({
							q: query,
							query_expansion: true
						}),
					});

					if (!response.ok) {
						return handleApiError(response, "Query expansion");
					}

					const data = await response.json() as any;

					// Return each result as individual text items for consistency
					const contentItems: Array<{ type: 'text'; text: string }> = [];

					if (data.results && Array.isArray(data.results)) {
						for (const result of data.results) {
							contentItems.push({
								type: "text" as const,
								text: result,
							});
						}
					}

					return {
						content: contentItems,
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Search Arxiv tool - search arxiv papers using Jina Search API
	if (isToolEnabled("search_arxiv")) {
		server.tool(
			"search_arxiv",
			"Search arXiv preprints (physics, maths, CS, quantitative biology and finance).",
			{
				query: z.union([z.string(), z.array(z.string()).min(1).max(5)]),
				num: z.number().int().min(1).max(100).default(30),
				tbs: z.string().optional().describe("Age limit: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y (hour to year).")
			},
			async ({ query, num, tbs }: { query: string | string[]; num: number; tbs?: string }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					// Handle single query or single-element array
					if (typeof query === 'string' || (Array.isArray(query) && query.length === 1)) {
						const singleQuery = typeof query === 'string' ? query : query[0];
						const searchResult = await executeArxivSearch({ query: singleQuery, num, tbs }, props.bearerToken);

						return {
							content: formatSingleSearchResultToContentItems(searchResult),
						};
					}

					// Handle multiple queries with parallel search
					if (Array.isArray(query) && query.length > 1) {
						const searches = query.map(q => ({ query: q, num, tbs }));

						const uniqueSearches = searches.filter((search, index, self) =>
							index === self.findIndex(s => s.query === search.query)
						);

						const arxivSearchFunction = async (searchArgs: SearchArxivArgs) => {
							return executeArxivSearch(searchArgs, props.bearerToken);
						};

						const results = await executeParallelSearches(uniqueSearches, arxivSearchFunction, { timeout: 30000 });

						return {
							content: formatParallelSearchResultsToContentItems(results),
						};
					}

					return createErrorResponse("Invalid query format");
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Search SSRN tool - search SSRN papers using Jina Search API
	if (isToolEnabled("search_ssrn")) {
		server.tool(
			"search_ssrn",
			"Search SSRN working papers (social science, economics, law, finance, management).",
			{
				query: z.union([z.string(), z.array(z.string()).min(1).max(5)]),
				num: z.number().int().min(1).max(100).default(30),
				tbs: z.string().optional().describe("Age limit: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y (hour to year).")
			},
			async ({ query, num, tbs }: { query: string | string[]; num: number; tbs?: string }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					// Handle single query or single-element array
					if (typeof query === 'string' || (Array.isArray(query) && query.length === 1)) {
						const singleQuery = typeof query === 'string' ? query : query[0];
						const searchResult = await executeSsrnSearch({ query: singleQuery, num, tbs }, props.bearerToken);

						return {
							content: formatSingleSearchResultToContentItems(searchResult),
						};
					}

					// Handle multiple queries with parallel search
					if (Array.isArray(query) && query.length > 1) {
						const searches = query.map(q => ({ query: q, num, tbs }));

						const uniqueSearches = searches.filter((search, index, self) =>
							index === self.findIndex(s => s.query === search.query)
						);

						const ssrnSearchFunction = async (searchArgs: SearchSsrnArgs) => {
							return executeSsrnSearch(searchArgs, props.bearerToken);
						};

						const results = await executeParallelSearches(uniqueSearches, ssrnSearchFunction, { timeout: 30000 });

						return {
							content: formatParallelSearchResultsToContentItems(results),
						};
					}

					return createErrorResponse("Invalid query format");
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Search Jina Blog tool - search Jina AI news/blog posts using Ghost Content API
	if (isToolEnabled("search_jina_blog")) {
		server.tool(
			"search_jina_blog",
			"Search Jina AI's news and blog at jina.ai/news: product announcements, model releases, technical write-ups.",
			{
				query: z.union([z.string(), z.array(z.string()).min(1).max(5)]),
				num: z.number().int().min(1).max(100).default(30),
				tbs: z.string().optional().describe("Age limit: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y (hour to year).")
			},
			async ({ query, num, tbs }: { query: string | string[]; num: number; tbs?: string }) => {
				try {
					const props = getProps();

					// Get Ghost API key from props (set in index.ts from env)
					const ghostApiKey = props.ghostApiKey;
					if (!ghostApiKey) {
						return createErrorResponse("Ghost API key not configured");
					}

					// Optional semantic reordering of the lexically matched posts
					const rerankConfig = { bearerToken: props.bearerToken, apiBaseUrl: props.apiBaseUrl };

					// Handle single query or single-element array
					if (typeof query === 'string' || (Array.isArray(query) && query.length === 1)) {
						const singleQuery = typeof query === 'string' ? query : query[0];
						const searchResult = await executeJinaBlogSearch({ query: singleQuery, num, tbs }, ghostApiKey, rerankConfig);

						return {
							content: formatSingleSearchResultToContentItems(searchResult),
						};
					}

					// Handle multiple queries with parallel search
					if (Array.isArray(query) && query.length > 1) {
						const searches = query.map(q => ({ query: q, num, tbs }));

						const uniqueSearches = searches.filter((search, index, self) =>
							index === self.findIndex(s => s.query === search.query)
						);

						const jinaBlogSearchFunction = async (searchArgs: SearchJinaBlogArgs) => {
							return executeJinaBlogSearch(searchArgs, ghostApiKey, rerankConfig);
						};

						const results = await executeParallelSearches(uniqueSearches, jinaBlogSearchFunction, { timeout: 30000 });

						return {
							content: formatParallelSearchResultsToContentItems(results),
						};
					}

					return createErrorResponse("Invalid query format");
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Search Images tool - search for images on the web using Jina Search API
	if (isToolEnabled("search_images")) {
		server.tool(
			"search_images",
			"Search the web for images. Returns base64 JPEGs by default.",
			{
				query: z.string(),
				num: z.number().int().min(1).max(30).default(10),
				return_url: z.boolean().default(false).describe("Return URLs and metadata instead of base64 images."),
				tbs: z.string().optional().describe("Age limit: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y (hour to year)."),
				location: z.string().optional(),
				gl: z.string().optional().describe("Country code, e.g. 'de'."),
				hl: z.string().optional().describe("Language code, e.g. 'zh-cn'.")
			},
			async ({ query, num, return_url, tbs, location, gl, hl }: SearchImageArgs & { num: number }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					const searchResult = await executeImageSearch({ query, return_url, tbs, location, gl, hl }, props.bearerToken);

					if ('error' in searchResult) {
						return createErrorResponse(searchResult.error);
					}

					// The result set was previously used whole: every image the upstream
					// returned was downloaded and inlined as base64, so a single call could
					// push megabytes of image data into the model's context.
					const data = { results: (searchResult.results || []).slice(0, num) };

					// Prepare response content - always return as list structure for consistency
					const contentItems: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

					if (return_url) {
						// Return each result as individual text items
						if (data.results && Array.isArray(data.results)) {
							for (const result of data.results) {
								contentItems.push({
									type: "text" as const,
									text: yamlStringify(result),
								});
							}
						}
					} else {
						// Extract image URLs from search results
						const imageUrls: string[] = [];
						if (data.results && Array.isArray(data.results)) {
							for (const result of data.results) {
								if (result.imageUrl) {
									imageUrls.push(result.imageUrl);
								}
							}
						}

						if (imageUrls.length === 0) {
							throw new Error("No image URLs found in search results");
						}

						// Download and process images (resize to max 800px, convert to JPEG)
						// 15 second timeout - returns partial results if timeout occurs
						const downloadResults = await downloadImages(imageUrls, 3, 15000);

						// Add successful downloads as images
						const failures: string[] = [];
						for (const result of downloadResults) {
							if (result.success && result.data) {
								contentItems.push({
									type: "image" as const,
									data: result.data,
									mimeType: result.mimeType,
								});
							} else {
								failures.push(`${result.url}: ${result.error || 'unknown error'}`);
							}
						}

						// Failures used to be dropped silently, so a query whose results were
						// all SVG or all hotlink-protected returned an empty *successful*
						// response - indistinguishable from "no images found".
						if (contentItems.length === 0) {
							return createErrorResponse(
								`Found ${downloadResults.length} image(s) but none could be fetched:\n${failures.join('\n')}`
							);
						}
						if (failures.length > 0) {
							contentItems.push({
								type: "text" as const,
								text: `${failures.length} of ${downloadResults.length} image(s) could not be fetched:\n${failures.join('\n')}`,
							});
						}
					}

					return {
						content: contentItems,
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Parallel Search Web tool - execute multiple web searches in parallel
	if (isToolEnabled("parallel_search_web")) {
		server.tool(
			"parallel_search_web",
			"Run several web searches at once. Give queries covering different angles of the topic; expand_query can generate them.",
			{
				searches: z.array(z.object({
					query: z.string(),
					num: z.number().int().min(1).max(100).default(30),
					tbs: z.string().optional().describe("Age limit: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y (hour to year)."),
					location: z.string().optional(),
					gl: z.string().optional().describe("Country code, e.g. 'de'."),
					hl: z.string().optional().describe("Language code, e.g. 'zh-cn'.")
				})).max(5).describe("Searches to run, up to 5.")
			},
			async ({ searches }: { searches: SearchWebArgs[] }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					const uniqueSearches = searches.filter((search, index, self) =>
						index === self.findIndex(s => s.query === search.query)
					);

					// Use the common web search function
					const webSearchFunction = async (searchArgs: SearchWebArgs) => {
						return executeWebSearch(searchArgs, props.bearerToken);
					};

					// Execute parallel searches using utility
					const results = await executeParallelSearches(uniqueSearches, webSearchFunction, { timeout: PARALLEL_TIMEOUT_MS });

					return {
						content: formatParallelSearchResultsToContentItems(results),
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Parallel Search Arxiv tool - execute multiple arXiv searches in parallel
	if (isToolEnabled("parallel_search_arxiv")) {
		server.tool(
			"parallel_search_arxiv",
			"Run several arXiv searches at once. Give queries covering different research angles.",
			{
				searches: z.array(z.object({
					query: z.string(),
					num: z.number().int().min(1).max(100).default(30),
					tbs: z.string().optional().describe("Age limit: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y (hour to year).")
				})).max(5).describe("Searches to run, up to 5.")
			},
			async ({ searches }: { searches: SearchArxivArgs[] }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					const uniqueSearches = searches.filter((search, index, self) =>
						index === self.findIndex(s => s.query === search.query)
					);

					// Use the common arXiv search function
					const arxivSearchFunction = async (searchArgs: SearchArxivArgs) => {
						return executeArxivSearch(searchArgs, props.bearerToken);
					};

					// Execute parallel searches using utility
					const results = await executeParallelSearches(uniqueSearches, arxivSearchFunction, { timeout: PARALLEL_TIMEOUT_MS });

					return {
						content: formatParallelSearchResultsToContentItems(results),
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Parallel Search SSRN tool - execute multiple SSRN searches in parallel
	if (isToolEnabled("parallel_search_ssrn")) {
		server.tool(
			"parallel_search_ssrn",
			"Run several SSRN searches at once. Give queries covering different research angles.",
			{
				searches: z.array(z.object({
					query: z.string(),
					num: z.number().int().min(1).max(100).default(30),
					tbs: z.string().optional().describe("Age limit: qdr:h, qdr:d, qdr:w, qdr:m, qdr:y (hour to year).")
				})).max(5).describe("Searches to run, up to 5.")
			},
			async ({ searches }: { searches: SearchSsrnArgs[] }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					const uniqueSearches = searches.filter((search, index, self) =>
						index === self.findIndex(s => s.query === search.query)
					);

					// Use the common SSRN search function
					const ssrnSearchFunction = async (searchArgs: SearchSsrnArgs) => {
						return executeSsrnSearch(searchArgs, props.bearerToken);
					};

					// Execute parallel searches using utility
					const results = await executeParallelSearches(uniqueSearches, ssrnSearchFunction, { timeout: PARALLEL_TIMEOUT_MS });

					return {
						content: formatParallelSearchResultsToContentItems(results),
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Parallel Read URL tool - execute multiple URL reads in parallel
	if (isToolEnabled("parallel_read_url")) {
		server.tool(
			"parallel_read_url",
			"Read several URLs at once.",
			{
				urls: z.array(z.object({
					url: z.string().url(),
					withAllLinks: z.boolean().default(false).describe("Also return every link on the page."),
					withAllImages: z.boolean().default(false).describe("Also return every image on the page."),
					question: z.string().optional().describe("Return only the passages answering this question, instead of the full body."),
					chunk_size: z.number().int().min(1).max(4096).optional().describe("Passage size in words, default 100. Needs `question`."),
					topk: z.number().int().min(1).max(50).optional().describe("Passages to return, default 1. Needs `question`."),
					ocr: z.boolean().optional().describe("Read the rendered page as an image with jina-ocr-v1 instead of its HTML. Use for scanned documents and PDFs. Parses one page per entry and costs about 40x the tokens per page."),
					page: z.number().int().min(1).optional().describe("Which page the OCR pass should parse, 1-based. Needs `ocr`.")
				})).max(5).describe("URLs to read, up to 5. To OCR several pages of one document, repeat the same url with different `page` values.")
			},
			async ({ urls }: { urls: Array<{ url: string; withAllLinks: boolean; withAllImages: boolean; question?: string; chunk_size?: number; topk?: number; ocr?: boolean; page?: number }> }) => {
				try {
					const props = getProps();

					const uniqueUrls = urls.filter((urlConfig, index, self) =>
						index === self.findIndex(u => u.url === urlConfig.url)
					);

					// Import the utility functions
					const { executeParallelUrlReads } = await import("../utils/read.js");

					// Question-grounded reads add a chunking and rerank pass after the
					// fetch, which the plain budget predates and would cut off mid-rerank.
					const effectiveTimeout = uniqueUrls.some(u => u.question)
						? QUESTION_READ_TIMEOUT_MS
						: PARALLEL_TIMEOUT_MS;

					// Execute parallel URL reads using the utility
					const results = await executeParallelUrlReads(uniqueUrls, props.bearerToken, effectiveTimeout);

					// Format results for consistent output
					const contentItems: Array<{ type: 'text'; text: string }> = [];

					for (const result of results) {
						if ('success' in result && result.success) {
							contentItems.push({
								type: "text" as const,
								text: yamlStringify(result.structuredData),
							});
						} else if ('error' in result) {
							contentItems.push({
								type: "text" as const,
								text: `Error reading ${result.url}: ${result.error}`,
							});
						}
					}

					return applyTokenGuardrail({
						content: contentItems,
					}, props.bearerToken, getClientName(), props.apiBaseUrl, props.maxResponseTokens);
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Classify text tool - classify texts into labels using Jina classify API
	if (isToolEnabled("classify_text")) {
		server.tool(
			"classify_text",
			"Classify texts into labels you supply, using Jina embeddings. Zero-shot: no training data needed.",
			{
				texts: z.array(z.string()).min(1).max(1024).describe("Texts to classify, up to 1024."),
				labels: z.array(z.string()).min(2).max(256).describe("Labels to classify into, e.g. ['positive','negative'].")
			},
			async ({ texts, labels }: { texts: string[]; labels: string[] }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					if (texts.length === 0) {
						throw new Error("No texts provided for classification");
					}

					if (labels.length < 2) {
						throw new Error("At least two labels are required for classification");
					}

					const response = await fetch(`${props.apiBaseUrl}/v1/classify`, {
						method: 'POST',
						headers: {
							'Accept': 'application/json',
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${props.bearerToken}`,
						},
						body: JSON.stringify({
							model: CLASSIFY_MODEL,
							input: texts,
							labels,
						}),
					});

					if (!response.ok) {
						return handleApiError(response, "Text classification");
					}

					const data = await response.json() as any;

					const contentItems: Array<{ type: 'text'; text: string }> = [];

					if (data.data && Array.isArray(data.data)) {
						for (const result of data.data) {
							contentItems.push({
								type: "text" as const,
								text: yamlStringify(result),
							});
						}
					}

					return {
						content: contentItems,
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Sort by relevance tool - rerank documents using Jina reranker API
	if (isToolEnabled("sort_by_relevance")) {
		server.tool(
			"sort_by_relevance",
			"Rerank documents by relevance to a query, using Jina Reranker.",
			{
				query: z.string(),
				documents: z.array(z.string()).min(1).max(1024).describe("Documents to rank, up to 1024."),
				top_n: z.number().int().min(1).optional()
			},
			async ({ query, documents, top_n }: { query: string; documents: string[]; top_n?: number }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					if (documents.length === 0) {
						throw new Error("No documents provided for reranking");
					}

					const response = await fetch(`${props.apiBaseUrl}/v1/rerank`, {
						method: 'POST',
						headers: {
							'Accept': 'application/json',
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${props.bearerToken}`,
						},
						body: JSON.stringify({
							model: 'jina-reranker-v3.5',
							query,
							top_n: top_n || documents.length,
							documents
						}),
					});

					if (!response.ok) {
						return handleApiError(response, "Document reranking");
					}

					const data = await response.json() as any;

					// Return each result as individual text items for consistency
					const contentItems: Array<{ type: 'text'; text: string }> = [];

					if (data.results && Array.isArray(data.results)) {
						for (const result of data.results) {
							contentItems.push({
								type: "text" as const,
								text: yamlStringify(result),
							});
						}
					}

					return {
						content: contentItems,
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Deduplicate strings tool - get top-k unique strings using embeddings and submodular optimization
	if (isToolEnabled("deduplicate_strings")) {
		server.tool(
			"deduplicate_strings",
			"Select the top-k semantically distinct strings from a list, dropping near-duplicates.",
			{
				strings: z.array(z.string()).min(1).max(1000).describe("Strings to deduplicate, up to 1000."),
				k: z.number().int().min(1).optional().describe("How many to keep. Omit to pick k automatically from diminishing returns.")
			},
			async ({ strings, k }: { strings: string[]; k?: number }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					if (strings.length === 0) {
						throw new Error("No strings provided for deduplication");
					}

					if (k !== undefined && (k <= 0 || k > strings.length)) {
						throw new Error(`Invalid k value: ${k}. Must be between 1 and ${strings.length}`);
					}

					// Get embeddings from Jina API
					const response = await fetch(`${props.apiBaseUrl}/v1/embeddings`, {
						method: 'POST',
						headers: {
							'Accept': 'application/json',
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${props.bearerToken}`,
						},
						body: JSON.stringify({
							model: 'jina-embeddings-v5-text-small',
							task: 'text-matching',
							input: strings
						}),
					});

					if (!response.ok) {
						return handleApiError(response, "Getting embeddings");
					}

					const data = await response.json() as any;

					if (!data.data || !Array.isArray(data.data)) {
						throw new Error("Invalid response format from embeddings API");
					}

					// Extract embeddings
					const embeddings = data.data.map((item: any) => item.embedding);

					// Use submodular optimization to select diverse strings
					let selectedIndices: number[];

					if (k !== undefined) {
						selectedIndices = lazyGreedySelection(embeddings, k);
					} else {
						const result = lazyGreedySelectionWithSaturation(embeddings);
						selectedIndices = result.selected;
					}

					// Get the selected strings
					const selectedStrings = selectedIndices.map(idx => ({
						index: idx,
						text: strings[idx]
					}));

					// Return each deduplicated string as individual text items for consistency
					const contentItems: Array<{ type: 'text'; text: string }> = [];

					for (const selectedString of selectedStrings) {
						contentItems.push({
							type: "text" as const,
							text: yamlStringify(selectedString),
						});
					}

					return {
						content: contentItems,
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Deduplicate images tool - get top-k unique images using image embeddings and submodular optimization
	if (isToolEnabled("deduplicate_images")) {
		server.tool(
			"deduplicate_images",
			"Select the top-k visually distinct images (URLs or base64) from a list, dropping near-duplicates.",
			{
				images: z.array(z.string()).min(1).max(200).describe("Images to deduplicate, up to 200. Each is an http(s) URL or raw base64."),
				k: z.number().int().min(1).optional().describe("How many to keep. Omit to pick k automatically from diminishing returns."),
			},
			async ({ images, k }: { images: string[]; k?: number }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					if (images.length === 0) {
						throw new Error("No images provided for deduplication");
					}

					if (k !== undefined && (k <= 0 || k > images.length)) {
						throw new Error(`Invalid k value: ${k}. Must be between 1 and ${images.length}`);
					}

					// Prepare input for image embeddings API
					const embeddingInput = images.map((img) => ({ image: img }));

					// Get image embeddings from Jina API using CLIP v2
					const response = await fetch(`${props.apiBaseUrl}/v1/embeddings`, {
						method: 'POST',
						headers: {
							'Accept': 'application/json',
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${props.bearerToken}`,
						},
						body: JSON.stringify({
							model: 'jina-clip-v2',
							input: embeddingInput,
						}),
					});

					if (!response.ok) {
						return handleApiError(response, "Getting image embeddings");
					}

					const data = await response.json() as any;

					if (!data.data || !Array.isArray(data.data)) {
						throw new Error("Invalid response format from embeddings API");
					}

					// Extract embeddings
					const embeddings = data.data.map((item: any) => item.embedding);

					// Use submodular optimization to select diverse images
					let selectedIndices: number[];

					if (k !== undefined) {
						selectedIndices = lazyGreedySelection(embeddings, k);
					} else {
						const result = lazyGreedySelectionWithSaturation(embeddings);
						selectedIndices = result.selected;
					}

					// Get the selected images
					const selectedImages = selectedIndices.map((idx) => ({ index: idx, source: images[idx] }));

					const isUrl = (source: string) => /^https?:\/\//i.test(source);

					// Use our consolidated downloadImages utility for consistency
					const urlEntries = selectedImages.filter(({ source }) => isUrl(source));
					const downloadResults = urlEntries.length > 0
						? await downloadImages(urlEntries.map(({ source }) => source), 3, 15000)
						: [];

					const contentItems: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];

					// Emit in selection order (most-diverse first) rather than grouping
					// all URLs ahead of all base64 inputs, and map each download back to
					// its entry by position - looking it up by URL string resolved every
					// duplicate URL to the first occurrence's index.
					let urlPosition = 0;
					for (const { index, source } of selectedImages) {
						if (!isUrl(source)) {
							contentItems.push({
								type: 'image' as const,
								data: source,
								mimeType: sniffBase64ImageMimeType(source),
							});
							continue;
						}

						// downloadImages returns partial results when it hits its own
						// timeout, so trailing entries can legitimately be missing
						const result = downloadResults[urlPosition++];

						if (result?.success && result.data) {
							contentItems.push({
								type: 'image' as const,
								data: result.data,
								mimeType: result.mimeType,
							});
						} else {
							contentItems.push({
								type: 'text' as const,
								text: `Failed to download image at index ${index}: ${result?.error || 'Download timed out'}`,
							});
						}
					}

					if (contentItems.length === 0) {
						throw new Error("No images to return after deduplication");
					}

					return { content: contentItems };
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Search BibTeX tool - search for academic papers and return BibTeX citations
	if (isToolEnabled("search_bibtex")) {
		server.tool(
			"search_bibtex",
			"Find papers and return ready-to-use BibTeX entries. Searches DBLP and Semantic Scholar.",
			{
				query: z.string(),
				num: z.number().min(1).max(50).default(10),
				year: z.number().optional().describe("Earliest publication year."),
				author: z.string().optional().describe("Author surname.")
			},
			async ({ query, num, year, author }: { query: string; num: number; year?: number; author?: string }) => {
				try {
					// Import the utility function
					const { searchBibtex } = await import("../utils/bibtex.js");

					// Execute search. `warnings` carries partial-coverage failures - one
					// provider rate-limiting used to silently halve the results.
					const warnings: string[] = [];
					const results = await searchBibtex({ query, num, year, author }, warnings);

					if (results.length === 0) {
						return {
							content: [{
								type: "text" as const,
								text: warnings.length > 0
									? `No results found (${warnings.join("; ")}). Try different search terms or broader keywords.`
									: "No results found. Try different search terms or broader keywords."
							}]
						};
					}

					// Format results
					const formattedResults = results.map(entry => ({
						title: entry.title,
						authors: entry.authors,
						year: entry.year,
						venue: entry.venue,
						doi: entry.doi,
						arxiv_id: entry.arxiv_id,
						citations: entry.citations,
						bibtex: entry.bibtex,
					}));

					return {
						content: [{
							type: "text" as const,
							text: yamlStringify(warnings.length > 0
								? { warnings, results: formattedResults }
								: { results: formattedResults })
						}]
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}

	// Extract PDF tool - extract figures, tables, and equations from PDF documents
	if (isToolEnabled("extract_pdf")) {
		server.tool(
			"extract_pdf",
			"Extract figures, tables and equations from a PDF as images, by arXiv id or URL.",
			{
				id: z.string().optional().describe("arXiv id, e.g. '2301.12345'. Give id or url."),
				url: z.string().url().optional().describe("PDF URL. Give id or url."),
				max_edge: z.number().default(1024).describe("Longest image edge in pixels, default 1024."),
				type: z.string().optional().describe("Comma-separated types to keep: figure, table, equation. Default all.")
			},
			async ({ id, url, max_edge, type }: { id?: string; url?: string; max_edge: number; type?: string }) => {
				try {
					const props = getProps();

					const tokenError = checkBearerToken(props.bearerToken);
					if (tokenError) {
						return tokenError;
					}

					if (!id && !url) {
						return createErrorResponse("Either 'id' (arXiv paper ID) or 'url' (PDF URL) is required");
					}

					// Build request body
					const requestBody: Record<string, any> = {};
					if (id) requestBody.id = id;
					if (url) requestBody.url = url;
					if (max_edge) requestBody.max_edge = max_edge;
					if (type) requestBody.type = type;

					const response = await fetch('https://svip.jina.ai/extract-pdf', {
						method: 'POST',
						headers: {
							'Accept': 'application/json',
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${props.bearerToken}`,
						},
						body: JSON.stringify(requestBody),
					});

					if (!response.ok) {
						return handleApiError(response, "PDF extraction");
					}

					const data = await response.json() as {
						id: string;
						floats: Array<{
							type: string;
							number: string;
							caption: string;
							page: number;
							image: string;
							width: number;
							height: number;
						}>;
						meta: {
							latency: number;
							num_floats: number;
							num_pages: number;
							total_bytes: number;
							credits: number;
							tokens: number;
						};
					};

					// Limit floats to prevent large responses
					const maxFloats = 20;
					const floats = Array.isArray(data?.floats) ? data.floats : [];
					const totalFloats = floats.length;
					const floatsToReturn = floats.slice(0, maxFloats);

					// Return each float as an image with metadata
					const contentItems: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

					// Add summary metadata. `floats`/`meta` are read defensively: an
					// error-shaped 200 response used to throw a TypeError here and the
					// caller only saw "Cannot read properties of undefined".
					const summaryMeta: Record<string, any> = {
						id: data?.id,
						num_floats: data?.meta?.num_floats ?? totalFloats,
						num_pages: data?.meta?.num_pages,
						latency_ms: data?.meta?.latency
					};
					if (totalFloats > maxFloats) {
						summaryMeta.returned_floats = maxFloats;
						summaryMeta.truncated = true;
						summaryMeta.note = `Showing first ${maxFloats} of ${totalFloats} floats. Use 'type' parameter to filter by specific types.`;
					}
					contentItems.push({
						type: "text" as const,
						text: yamlStringify(summaryMeta),
					});

					// Add each float as an image with its metadata
					for (const float of floatsToReturn) {
						// Add metadata for this float
						contentItems.push({
							type: "text" as const,
							text: yamlStringify({
								type: float.type,
								number: float.number,
								caption: float.caption,
								page: float.page,
								dimensions: `${float.width}x${float.height}`
							}),
						});

						// Add the image
						contentItems.push({
							type: "image" as const,
							data: float.image,
							mimeType: "image/png",
						});
					}

					return {
						content: contentItems,
					};
				} catch (error) {
					return createErrorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		);
	}
}
