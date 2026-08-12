import { stringify as yamlStringify } from "yaml";
import { withDeadline } from "./timeout.js";

// A single search/read had no client-side deadline at all: a hung upstream held
// the Worker invocation open until the platform killed it. Every outbound call
// now carries an AbortSignal so the request is actually cancelled, not abandoned.
const SEARCH_REQUEST_TIMEOUT_MS = 30000;

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

export interface SearchWebArgs {
    query: string;
    num?: number;
    tbs?: string;
    location?: string;
    gl?: string;
    hl?: string;
}

export interface SearchArxivArgs {
    query: string;
    num?: number;
    tbs?: string;
}

export interface SearchSsrnArgs {
    query: string;
    num?: number;
    tbs?: string;
}

export interface SearchJinaBlogArgs {
    query: string;
    num?: number;
    tbs?: string;
}

export interface SearchImageArgs {
    query: string;
    return_url?: boolean;
    tbs?: string;
    location?: string;
    gl?: string;
    hl?: string;
}

export interface SearchResult {
    query: string;
    results: any[];
}

export interface SearchError {
    error: string;
}

export type SearchResultOrError = SearchResult | SearchError;

export type ParallelSearchResult = SearchResultOrError;

export interface ParallelSearchOptions {
    timeout?: number;
}

// ============================================================================
// SEARCH OPERATIONS
// ============================================================================

/**
 * Execute a single web search
 */
export async function executeWebSearch(
    searchArgs: SearchWebArgs,
    bearerToken: string
): Promise<SearchResultOrError> {
    try {
        const response = await fetch('https://svip.jina.ai/', {
            method: 'POST',
            signal: AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS),
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({
                q: searchArgs.query,
                num: searchArgs.num || 30,
                ...(searchArgs.tbs && { tbs: searchArgs.tbs }),
                ...(searchArgs.location && { location: searchArgs.location }),
                ...(searchArgs.gl && { gl: searchArgs.gl }),
                ...(searchArgs.hl && { hl: searchArgs.hl })
            }),
        });

        if (!response.ok) {
            return { error: `Search failed for query "${searchArgs.query}": ${response.statusText}` };
        }

        const data = await response.json() as any;
        return { query: searchArgs.query, results: data.results || [] };
    } catch (error) {
        return { error: `Search failed for query "${searchArgs.query}": ${error instanceof Error ? error.message : String(error)}` };
    }
}

/**
 * Execute a single arXiv search
 */
export async function executeArxivSearch(
    searchArgs: SearchArxivArgs,
    bearerToken: string
): Promise<SearchResultOrError> {
    try {
        const response = await fetch('https://svip.jina.ai/', {
            method: 'POST',
            signal: AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS),
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({
                q: searchArgs.query,
                domain: 'arxiv',
                num: searchArgs.num || 30,
                ...(searchArgs.tbs && { tbs: searchArgs.tbs })
            }),
        });

        if (!response.ok) {
            return { error: `arXiv search failed for query "${searchArgs.query}": ${response.statusText}` };
        }

        const data = await response.json() as any;
        return { query: searchArgs.query, results: data.results || [] };
    } catch (error) {
        return { error: `arXiv search failed for query "${searchArgs.query}": ${error instanceof Error ? error.message : String(error)}` };
    }
}

/**
 * Execute a single SSRN search
 */
export async function executeSsrnSearch(
    searchArgs: SearchSsrnArgs,
    bearerToken: string
): Promise<SearchResultOrError> {
    try {
        const response = await fetch('https://svip.jina.ai/', {
            method: 'POST',
            signal: AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS),
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({
                q: searchArgs.query,
                domain: 'ssrn',
                num: searchArgs.num || 30,
                ...(searchArgs.tbs && { tbs: searchArgs.tbs })
            }),
        });

        if (!response.ok) {
            return { error: `SSRN search failed for query "${searchArgs.query}": ${response.statusText}` };
        }

        const data = await response.json() as any;
        return { query: searchArgs.query, results: data.results || [] };
    } catch (error) {
        return { error: `SSRN search failed for query "${searchArgs.query}": ${error instanceof Error ? error.message : String(error)}` };
    }
}

// ============================================================================
// JINA BLOG SEARCH
// ============================================================================

// Ghost's Content API has no full-text search: `filter` only does substring
// matching on a handful of fields. Any multi-word query therefore matched
// nothing. Instead we pull the whole (small) post catalog once, cache it, and
// rank it locally, optionally reordering the top candidates with the reranker.

const GHOST_POSTS_ENDPOINT = 'https://cms.jina.ai/ghost/api/content/posts/';
const BLOG_CACHE_TTL_MS = 10 * 60 * 1000;
const BLOG_RERANK_CANDIDATES = 50;

interface BlogPostResult {
    title: string;
    url: string;
    snippet?: string;
    date?: string;
    reading_time?: number;
}

interface IndexedBlogPost {
    post: BlogPostResult;
    publishedAt: number;
    titleText: string;
    titleTokens: Set<string>;
    bodyTokens: Set<string>;
}

export interface JinaBlogRerankConfig {
    bearerToken?: string;
    apiBaseUrl?: string;
}

let blogPostCache: { fetchedAt: number; posts: IndexedBlogPost[] } | null = null;
// Concurrent cold requests used to each pull the whole catalog; they now share
// one in-flight fetch.
let blogPostCacheInFlight: Promise<IndexedBlogPost[]> | null = null;

const BLOG_STOPWORDS = new Set([
    'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does',
    'for', 'from', 'how', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'not', 'of',
    'on', 'or', 'our', 'so', 'than', 'that', 'the', 'their', 'then', 'there',
    'these', 'they', 'this', 'those', 'to', 'us', 'use', 'using', 'via', 'was',
    'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'work',
    'you', 'your'
]);

/** Crude singular folding so "embeddings" and "embedding" collide */
function stemBlogToken(token: string): string {
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
        return token.slice(0, -1);
    }
    return token;
}

function tokenizeBlogText(text: string): string[] {
    return (text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length > 1 && !BLOG_STOPWORDS.has(token))
        .map(stemBlogToken);
}

/** Ghost CMS URLs are not the public ones the blog is served from */
function toPublicBlogUrl(post: any): string {
    let url = post.url || `https://jina.ai/news/${post.slug}`;
    if (url.includes('cms.jina.ai')) {
        url = url.replace('https://cms.jina.ai/', 'https://jina.ai/news/');
    } else if (url.includes('jina-ai-gmbh.ghost.io')) {
        url = url.replace('https://jina-ai-gmbh.ghost.io/podcast/', 'https://jina.ai/news/');
        url = url.replace('https://jina-ai-gmbh.ghost.io/', 'https://jina.ai/news/');
    }
    return url;
}

/** Fetch and index the full post catalog, memoized per isolate */
async function fetchIndexedBlogPosts(ghostApiKey: string): Promise<IndexedBlogPost[]> {
    if (blogPostCache && Date.now() - blogPostCache.fetchedAt < BLOG_CACHE_TTL_MS) {
        return blogPostCache.posts;
    }

    // Single-flight: a burst of requests arriving on a cold isolate (or a
    // parallel_search over N queries, which calls this N times at once) would
    // otherwise each download the entire post catalog.
    if (blogPostCacheInFlight) {
        return blogPostCacheInFlight;
    }

    blogPostCacheInFlight = fetchAndIndexBlogPosts(ghostApiKey).finally(() => {
        blogPostCacheInFlight = null;
    });

    return blogPostCacheInFlight;
}

async function fetchAndIndexBlogPosts(ghostApiKey: string): Promise<IndexedBlogPost[]> {
    const params = new URLSearchParams({
        key: ghostApiKey,
        limit: 'all',
        fields: 'id,title,slug,excerpt,published_at,url,reading_time',
        order: 'published_at desc'
    });

    const response = await fetch(`${GHOST_POSTS_ENDPOINT}?${params.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS),
        headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`Ghost Content API returned ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    const posts: IndexedBlogPost[] = (data.posts || []).map((post: any) => {
        const title = post.title || '';
        const excerpt = post.excerpt || '';
        return {
            post: {
                title,
                url: toPublicBlogUrl(post),
                snippet: excerpt,
                date: post.published_at,
                reading_time: post.reading_time
            },
            publishedAt: post.published_at ? Date.parse(post.published_at) : 0,
            titleText: title.toLowerCase(),
            titleTokens: new Set([...tokenizeBlogText(title), ...tokenizeBlogText(post.slug || '')]),
            bodyTokens: new Set(tokenizeBlogText(excerpt))
        };
    });

    blogPostCache = { fetchedAt: Date.now(), posts };
    return posts;
}

/** Cutoff timestamp for a Google-style tbs parameter, or null if absent/unknown */
function resolveTbsCutoff(tbs?: string): number | null {
    const windows: Record<string, number> = {
        'qdr:h': 60 * 60 * 1000,
        'qdr:d': 24 * 60 * 60 * 1000,
        'qdr:w': 7 * 24 * 60 * 60 * 1000,
        'qdr:m': 30 * 24 * 60 * 60 * 1000,
        'qdr:y': 365 * 24 * 60 * 60 * 1000,
    };
    const span = tbs ? windows[tbs] : undefined;
    return span ? Date.now() - span : null;
}

/** TF-IDF-ish lexical scoring over title (weighted) and excerpt */
function scoreBlogPosts(query: string, posts: IndexedBlogPost[]): IndexedBlogPost[] {
    const queryTokens = Array.from(new Set(tokenizeBlogText(query)));
    if (queryTokens.length === 0 || posts.length === 0) {
        return [];
    }

    const phrase = query.trim().toLowerCase();
    const idf = new Map<string, number>();
    for (const token of queryTokens) {
        const df = posts.filter(p => p.titleTokens.has(token) || p.bodyTokens.has(token)).length;
        idf.set(token, Math.log(1 + posts.length / (1 + df)));
    }

    const scored: Array<{ entry: IndexedBlogPost; score: number }> = [];
    for (const entry of posts) {
        let score = 0;
        for (const token of queryTokens) {
            const weight = idf.get(token) || 0;
            if (entry.titleTokens.has(token)) score += 3 * weight;
            if (entry.bodyTokens.has(token)) score += weight;
        }
        // reward exact phrase hits so "late chunking" beats posts matching either word
        if (phrase.length > 2 && entry.titleText.includes(phrase)) {
            score += 5;
        }
        if (score > 0) {
            scored.push({ entry, score });
        }
    }

    scored.sort((a, b) => b.score - a.score || b.entry.publishedAt - a.entry.publishedAt);
    return scored.map(s => s.entry);
}

/** Reorder candidates with jina-reranker; returns null so callers can fall back */
async function rerankBlogPosts(
    query: string,
    candidates: IndexedBlogPost[],
    config?: JinaBlogRerankConfig
): Promise<IndexedBlogPost[] | null> {
    if (!config?.bearerToken || candidates.length < 2) {
        return null;
    }

    try {
        const response = await fetch(`${config.apiBaseUrl || 'https://api.jina.ai'}/v1/rerank`, {
            method: 'POST',
            signal: AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS),
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.bearerToken}`,
            },
            body: JSON.stringify({
                model: 'jina-reranker-v3.5',
                query,
                top_n: candidates.length,
                documents: candidates.map(c => `${c.post.title}\n${c.post.snippet || ''}`.trim())
            }),
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json() as any;
        if (!Array.isArray(data.results) || data.results.length === 0) {
            return null;
        }

        const ordered = data.results
            .map((result: any) => candidates[result.index])
            .filter((entry: IndexedBlogPost | undefined): entry is IndexedBlogPost => Boolean(entry));

        return ordered.length > 0 ? ordered : null;
    } catch {
        return null;
    }
}

/**
 * Execute a single Jina blog search over the Ghost post catalog
 */
export async function executeJinaBlogSearch(
    searchArgs: SearchJinaBlogArgs,
    ghostApiKey: string,
    rerankConfig?: JinaBlogRerankConfig
): Promise<SearchResultOrError> {
    try {
        const limit = Math.min(Math.max(searchArgs.num || 30, 1), 100);

        let posts = await fetchIndexedBlogPosts(ghostApiKey);

        const cutoff = resolveTbsCutoff(searchArgs.tbs);
        if (cutoff !== null) {
            posts = posts.filter(entry => entry.publishedAt >= cutoff);
        }

        // lexical matching decides *which* posts are relevant, the reranker only
        // decides their order - relevance scores are not calibrated enough to use
        // as a cutoff, so an unmatched query honestly returns nothing
        const matches = scoreBlogPosts(searchArgs.query, posts);
        const candidates = matches.slice(0, Math.max(BLOG_RERANK_CANDIDATES, limit));

        const ordered = await rerankBlogPosts(searchArgs.query, candidates, rerankConfig) || candidates;

        return { query: searchArgs.query, results: ordered.slice(0, limit).map(entry => entry.post) };
    } catch (error) {
        return { error: `Jina blog search failed for query "${searchArgs.query}": ${error instanceof Error ? error.message : String(error)}` };
    }
}

/**
 * Execute a single image search
 */
export async function executeImageSearch(
    searchArgs: SearchImageArgs,
    bearerToken: string
): Promise<SearchResultOrError> {
    try {
        const response = await fetch('https://svip.jina.ai/', {
            method: 'POST',
            signal: AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS),
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({
                q: searchArgs.query,
                type: 'images',
                ...(searchArgs.tbs && { tbs: searchArgs.tbs }),
                ...(searchArgs.location && { location: searchArgs.location }),
                ...(searchArgs.gl && { gl: searchArgs.gl }),
                ...(searchArgs.hl && { hl: searchArgs.hl })
            }),
        });

        if (!response.ok) {
            return { error: `Image search failed for query "${searchArgs.query}": ${response.statusText}` };
        }

        const data = await response.json() as any;
        return { query: searchArgs.query, results: data.results || [] };
    } catch (error) {
        return { error: `Image search failed for query "${searchArgs.query}": ${error instanceof Error ? error.message : String(error)}` };
    }
}

// ============================================================================
// PARALLEL SEARCH EXECUTION
// ============================================================================

/**
 * Execute multiple searches in parallel with timeout and error handling
 */
export async function executeParallelSearches<T>(
    searches: T[],
    searchFunction: (searchArgs: T) => Promise<SearchResultOrError>,
    options: ParallelSearchOptions = {}
): Promise<ParallelSearchResult[]> {
    const { timeout = 30000 } = options;

    // Each search gets its own deadline. Previously the whole batch was raced
    // against one rejecting timeout, so a single slow query discarded every
    // search that had already come back - the caller saw one generic timeout
    // error instead of the results it had actually paid for.
    return Promise.all(
        searches.map((searchArgs) =>
            withDeadline<SearchResultOrError>(
                async () => {
                    try {
                        return await searchFunction(searchArgs);
                    } catch (error) {
                        return { error: `Search failed: ${error instanceof Error ? error.message : String(error)}` } as SearchError;
                    }
                },
                timeout,
                () => ({ error: `Search timed out after ${timeout}ms` })
            )
        )
    );
}

// ============================================================================
// RESPONSE FORMATTING
// ============================================================================

/**
 * Convert search results to MCP content items for consistent response formatting
 */
export function formatSearchResultsToContentItems(results: any[]): Array<{ type: 'text'; text: string }> {
    const contentItems: Array<{ type: 'text'; text: string }> = [];

    if (results && Array.isArray(results)) {
        for (const result of results) {
            contentItems.push({
                type: "text" as const,
                text: yamlStringify(result),
            });
        }
    }

    return contentItems;
}

/**
 * Convert a single search result to MCP content items
 */
export function formatSingleSearchResultToContentItems(searchResult: SearchResultOrError): Array<{ type: 'text'; text: string }> {
    if ('error' in searchResult) {
        return [{
            type: "text" as const,
            text: `Error: ${searchResult.error}`,
        }];
    }

    return formatSearchResultsToContentItems(searchResult.results);
}

/**
 * Convert parallel search results to MCP content items
 */
export function formatParallelSearchResultsToContentItems(results: SearchResultOrError[]): Array<{ type: 'text'; text: string }> {
    const contentItems: Array<{ type: 'text'; text: string }> = [];

    for (const result of results) {
        if ('error' in result) {
            contentItems.push({
                type: "text" as const,
                text: `Error: ${result.error}`,
            });
        } else {
            contentItems.push({
                type: "text" as const,
                text: yamlStringify({
                    query: result.query,
                    results: result.results
                }),
            });
        }
    }

    return contentItems;
}
