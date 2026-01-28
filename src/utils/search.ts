import { stringify as yamlStringify } from "yaml";

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

/**
 * Execute a single Jina blog search using Ghost Content API
 */
export async function executeJinaBlogSearch(
    searchArgs: SearchJinaBlogArgs,
    ghostApiKey: string
): Promise<SearchResultOrError> {
    try {
        const limit = searchArgs.num || 30;

        // Build filter for Ghost NQL
        // Ghost Content API only supports filtering on specific fields (title, tag, author, etc.)
        // Full-text search on content/excerpt is not supported - only substring matching on title
        const filters: string[] = [];

        // Search in title using contains operator
        if (searchArgs.query) {
            // Escape single quotes in query
            const escapedQuery = searchArgs.query.replace(/'/g, "\\'");
            filters.push(`title:~'${escapedQuery}'`);
        }

        // Map tbs (time-based search) to Ghost's published_at filter
        if (searchArgs.tbs) {
            const now = new Date();
            let dateFilter: Date | null = null;

            switch (searchArgs.tbs) {
                case 'qdr:h': // past hour
                    dateFilter = new Date(now.getTime() - 60 * 60 * 1000);
                    break;
                case 'qdr:d': // past day
                    dateFilter = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    break;
                case 'qdr:w': // past week
                    dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    break;
                case 'qdr:m': // past month
                    dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    break;
                case 'qdr:y': // past year
                    dateFilter = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                    break;
            }

            if (dateFilter) {
                filters.push(`published_at:>'${dateFilter.toISOString()}'`);
            }
        }

        // Build URL with query parameters
        const params = new URLSearchParams({
            key: ghostApiKey,
            limit: limit.toString(),
            fields: 'id,title,slug,excerpt,published_at,url,reading_time',
            order: 'published_at desc'
        });

        if (filters.length > 0) {
            params.set('filter', filters.join('+'));
        }

        const response = await fetch(`https://jina-ai-gmbh.ghost.io/ghost/api/content/posts/?${params.toString()}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            return { error: `Jina blog search failed for query "${searchArgs.query}": ${response.statusText}` };
        }

        const data = await response.json() as any;

        // Transform Ghost posts to search result format
        const results = (data.posts || []).map((post: any) => {
            // Transform ghost.io URL to jina.ai/news URL
            let url = post.url || `https://jina.ai/news/${post.slug}`;
            if (url.includes('jina-ai-gmbh.ghost.io')) {
                url = url.replace('https://jina-ai-gmbh.ghost.io/podcast/', 'https://jina.ai/news/');
                url = url.replace('https://jina-ai-gmbh.ghost.io/', 'https://jina.ai/news/');
            }
            return {
                title: post.title,
                url,
                snippet: post.excerpt,
                date: post.published_at,
                reading_time: post.reading_time
            };
        });

        return { query: searchArgs.query, results };
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

    // Execute all searches in parallel
    const searchPromises = searches.map(async (searchArgs) => {
        try {
            return await searchFunction(searchArgs);
        } catch (error) {
            return { error: `Search failed: ${error instanceof Error ? error.message : String(error)}` } as SearchError;
        }
    });

    // Race all searches against timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Parallel search timed out after ${timeout}ms`)), timeout)
    );

    return Promise.race([
        Promise.all(searchPromises),
        timeoutPromise
    ]);
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
