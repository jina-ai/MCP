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
            return { error: `Search failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    });

    // Wait for all searches with timeout
    const results = await Promise.allSettled(searchPromises);
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('timeout'), timeout));

    const completedResults = await Promise.race([
        Promise.all(results.map(result =>
            result.status === 'fulfilled' ? result.value : { error: 'Promise rejected' }
        )),
        timeoutPromise
    ]);

    if (completedResults === 'timeout') {
        throw new Error(`Parallel search timed out after ${timeout}ms`);
    }

    return completedResults as ParallelSearchResult[];
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
