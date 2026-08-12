import { normalizeUrl } from "./url-normalizer.js";
import { withDeadline } from "./timeout.js";

// r.jina.ai had no client-side deadline: a hung read held the Worker invocation
// open until the platform killed it, taking the sibling reads down with it.
const READ_REQUEST_TIMEOUT_MS = 30000;

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

export interface ReadUrlConfig {
    url: string;
    withAllLinks?: boolean;
    withAllImages?: boolean;
}

export interface ReadUrlResult {
    success: boolean;
    url: string;
    structuredData: any;
    withAllLinks: boolean;
    withAllImages: boolean;
}

export interface ReadUrlError {
    error: string;
    url: string;
}

export type ReadUrlResponse = ReadUrlResult | ReadUrlError;

// ============================================================================
// CORE URL READING LOGIC
// ============================================================================

/**
 * Core function to read and extract content from a URL
 */
export async function readUrlFromConfig(
    urlConfig: ReadUrlConfig,
    bearerToken?: string
): Promise<ReadUrlResponse> {
    try {
        // Normalize the URL first
        const normalizedUrl = normalizeUrl(urlConfig.url);
        if (!normalizedUrl) {
            return { error: "Invalid or unsupported URL", url: urlConfig.url };
        }

        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Md-Link-Style': 'discarded',
        };

        // Add Authorization header if bearer token is available
        if (bearerToken) {
            headers['Authorization'] = `Bearer ${bearerToken}`;
        }

        if (urlConfig.withAllLinks) {
            headers['X-With-Links-Summary'] = 'all';
        }

        if (urlConfig.withAllImages) {
            headers['X-With-Images-Summary'] = 'true';
        } else {
            headers['X-Retain-Images'] = 'none';
        }

        const response = await fetch('https://r.jina.ai/', {
            method: 'POST',
            signal: AbortSignal.timeout(READ_REQUEST_TIMEOUT_MS),
            headers,
            body: JSON.stringify({ url: normalizedUrl }),
        });

        if (!response.ok) {
            return { error: `HTTP ${response.status}: ${response.statusText}`, url: urlConfig.url };
        }

        const data = await response.json() as any;

        if (!data.data) {
            return { error: "Invalid response data from r.jina.ai", url: urlConfig.url };
        }

        // Prepare structured data
        const structuredData: any = {
            url: data.data.url,
            title: data.data.title,
        };

        if (urlConfig.withAllLinks && data.data.links) {
            structuredData.links = data.data.links.map((link: [string, string]) => ({
                anchorText: link[0],
                url: link[1]
            }));
        }

        if (urlConfig.withAllImages && data.data.images) {
            structuredData.images = data.data.images;
        }
        structuredData.content = data.data.content || "";

        return {
            success: true,
            url: urlConfig.url,
            structuredData,
            withAllLinks: urlConfig.withAllLinks || false,
            withAllImages: urlConfig.withAllImages || false
        };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : String(error),
            url: urlConfig.url
        };
    }
}

/**
 * Execute multiple URL reads in parallel with timeout
 */
export async function executeParallelUrlReads(
    urlConfigs: ReadUrlConfig[],
    bearerToken?: string,
    timeout: number = 30000
): Promise<ReadUrlResponse[]> {
    // Per-URL deadline. The whole batch used to be raced against one rejecting
    // timeout, so one slow page threw away every read that had already
    // succeeded and the caller got a single generic error instead.
    return Promise.all(
        urlConfigs.map((urlConfig) =>
            withDeadline<ReadUrlResponse>(
                () => readUrlFromConfig(urlConfig, bearerToken),
                timeout,
                () => ({ error: `Read timed out after ${timeout}ms`, url: urlConfig.url })
            )
        )
    );
}
