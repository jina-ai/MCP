import { withDeadline } from "./timeout.js";
import { PASSAGE_BUDGET_MS, PASSAGE_REQUEST_TIMEOUT_MS, READ_REQUEST_TIMEOUT_MS } from "./limits.js";

/** Passage size for question-grounded reads, in words. Counted in words in every script. */
export const DEFAULT_SNIPPET_CHUNK_SIZE = 100;
/** Passages returned for question-grounded reads. */
export const DEFAULT_SNIPPET_TOPK = 1;

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

export interface ReadUrlConfig {
    url: string;
    withAllLinks?: boolean;
    withAllImages?: boolean;
    /**
     * Read the rendered page as an image with jina-ocr-v1 instead of parsing
     * its HTML. That is the only way to get at a scanned document or a PDF
     * whose text is not in the markup, and it keeps formulas and table
     * structure. It costs 40x the tokens of an ordinary read, so it stays off
     * unless asked for.
     *
     * It parses ONE page per call, the first unless `page` says otherwise.
     * Measured on arXiv 2609.03181: the HTML path returns the whole PDF in
     * 13,864 tokens, the OCR path returns page 1 for 61,520. Cost is per
     * page, and a long document needs one call per page.
     */
    ocr?: boolean;
    /**
     * Which page the OCR pass should parse, 1-based. Ignored without `ocr`,
     * since the HTML path returns the whole document at once and has nothing
     * to page through.
     */
    page?: number;
    /**
     * When set, the page is reduced to the passage(s) that best answer this
     * question, by the read -> chunk -> rerank pipeline at svip.jina.ai.
     * Absent (the default), the full content is returned exactly as before.
     */
    question?: string;
    /**
     * Target passage size for question-grounded reads, in words, split at
     * sentence boundaries. Counted in words in every script, so CJK passages are
     * as long as English ones, not shorter. Default 100.
     *
     * Named for what the server measures. It is not a token count: passages are
     * split at sentence boundaries and sized by `textSize`, which counts CJK
     * characters plus whitespace-delimited words. 100 words is roughly 130-150
     * tokens of English.
     */
    chunk_size?: number;
    /** Number of passages to keep for question-grounded reads. Default 1. */
    topk?: number;
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
// QUESTION-GROUNDED READ
// ============================================================================

/** The passages svip ranked as answering the question. */
interface Passages {
    snippets: string[];
    title?: string;
    url?: string;
    unrankedReason?: undefined;
}

/** No passages to use, and why svip could not rank any, when it said. */
interface NoPassages {
    snippets?: undefined;
    unrankedReason?: string;
}

/**
 * What the model is told when a question read comes back as the full page.
 *
 * It used to be one sentence for every cause. Most of the time the cause is
 * the reranker rate-limiting the caller's key: svip ranks under that key, a
 * batch of question reads all draw on its limit at once, and a model that is
 * not told keeps sending batches and keeps getting whole pages - the opposite
 * of what it passed `question` for. Measured on svip, 2026-11-15: 223 of the
 * 250 unranked reads that day, in bursts lasting up to 37 seconds.
 *
 * Reasons this server does not know get the general sentence, so svip can add
 * one without this having to change first.
 */
function fullContentNote(unrankedReason?: string): string {
    switch (unrankedReason) {
        case 'rate_limited':
            return 'The passages could not be ranked because this Jina API key reached the rate limit of the reranker; returning full content. Reads with a `question` share that limit, so send fewer of them at once.';
        case 'timeout':
            return 'The passages could not be ranked within the time limit; returning full content.';
        default:
            return 'Question-grounded extraction was unavailable for this page; returning full content.';
    }
}

/**
 * Read a page and return only the passages answering `question`.
 *
 * Delegates to svip.jina.ai's `url` + `q` form rather than chunking and ranking
 * here, which keeps the chunker and the reranker call off the Worker's CPU.
 *
 * Stripping is real and worth knowing: measured against a local wrangler dev, the
 * Wikipedia GDP list comes back as passages that contain the country name but not
 * the figures, because the table is gone before ranking, and the same removal takes
 * fenced code and site furniture with it. The consequence for callers is that a
 * number or a command that lives in a table or a code block is not reachable by
 * `question`; those need a plain read.
 *
 * Only ever called with BOTH a url and a non-empty question. svip's read path
 * is keyed on that pair: a url with no `q` there is a search for the literal
 * string, not a read, so forwarding a question-less read would silently turn it
 * into a nonsense search. Plain reads must stay on r.jina.ai. The caller
 * enforces this and the guard below repeats it, because the failure is silent
 * and wrong rather than loud.
 */
async function readWithQuestion(
    targetUrl: string,
    question: string,
    urlConfig: ReadUrlConfig,
    bearerToken?: string
): Promise<Passages | NoPassages> {
    if (!targetUrl || !question) return {};

    const response = await fetch('https://svip.jina.ai/', {
        method: 'POST',
        signal: AbortSignal.timeout(PASSAGE_REQUEST_TIMEOUT_MS),
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...(bearerToken ? { 'Authorization': `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify({
            q: question,
            url: targetUrl,
            topk: urlConfig.topk ?? DEFAULT_SNIPPET_TOPK,
            chunk_size: urlConfig.chunk_size ?? DEFAULT_SNIPPET_CHUNK_SIZE,
            deep_timeout: PASSAGE_BUDGET_MS,
        }),
    });

    if (!response.ok) return {};

    const data = await response.json() as {
        results?: Array<{ snippet?: string; title?: string; url?: string; rerank_score?: number; }>;
        meta?: { unranked_reason?: string; };
    };
    const first = data?.results?.[0];
    if (!first?.snippet) return {};

    // A snippet is only an answer if svip ranked it. When its rerank call fails
    // or runs out of budget, svip returns the first passage of the page
    // instead, in the same shape and with the same `snippet_source`; the one
    // difference is that there is no `rerank_score`. Passing that on told the
    // model "this is the passage that answers your question" about a page
    // header. Treat it as no extraction, so the caller falls back to the full
    // page and says so, along with svip's reason when it gives one.
    if (typeof first.rerank_score !== 'number') {
        return { unrankedReason: data.meta?.unranked_reason };
    }

    // One url in, so at most one result out; its snippet already joins the top
    // `topk` passages with the separator deep search uses.
    return { snippets: [first.snippet], title: first.title, url: first.url };
}

// ============================================================================
// CORE URL READING LOGIC
// ============================================================================

/**
 * Core function to read and extract content from a URL
 */
export async function readUrlFromConfig(
    urlConfig: ReadUrlConfig,
    bearerToken?: string,
    clientIp?: string
): Promise<ReadUrlResponse> {
    try {
        // The URL goes upstream as given. r.jina.ai already adds a missing scheme,
        // lowercases the host and rejects bad protocols with a clear message;
        // rewriting it here only broke pages (www. stripped off hosts with no apex
        // DNS record, meaningful query params and hash routes dropped). Only the
        // trim stays: svip finds nothing for a URL with surrounding whitespace.
        const targetUrl = urlConfig.url.trim();
        if (!targetUrl) {
            return { error: "Empty URL", url: urlConfig.url };
        }

        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Md-Link-Style': 'discarded',
        };

        // Add Authorization header if bearer token is available
        if (bearerToken) {
            headers['Authorization'] = `Bearer ${bearerToken}`;
        } else if (clientIp) {
            // Anonymous reads are rate-limited per X-Forwarded-For, so pass the
            // caller's IP instead of letting all keyless users share the Worker's.
            headers['X-Forwarded-For'] = clientIp;
        }

        if (urlConfig.withAllLinks) {
            headers['X-With-Links-Summary'] = 'all';
        }

        if (urlConfig.withAllImages) {
            headers['X-With-Images-Summary'] = 'true';
        } else {
            headers['X-Retain-Images'] = 'none';
        }

        if (urlConfig.ocr) {
            headers['X-Respond-With'] = 'jina-ocr-v1';

            // Only the OCR path works a page at a time, so page selection is
            // scoped to it rather than sent on every read.
            if (urlConfig.page && urlConfig.page > 1) {
                headers['X-Page'] = String(urlConfig.page);
            }
        }

        // svip is only involved when there is BOTH a url and a question. Without
        // a question this is an ordinary read and must go to r.jina.ai alone:
        // svip would treat a bare url as a search query. A question of only
        // whitespace is no question at all, hence the trim before the check.
        // svip also requires a key while r.jina.ai does not, so a keyless read
        // skips extraction instead of sending a request that can only be a 401.
        const question = urlConfig.question?.trim() || undefined;
        const useSvip = Boolean(targetUrl && question && bearerToken);

        // A failure here must not fail the read; it degrades to full content.
        const extractPassages = () =>
            readWithQuestion(targetUrl, question as string, urlConfig, bearerToken).catch((): NoPassages => ({}));

        // svip reads the page itself, through r.jina.ai under the caller's key, so
        // a full read running alongside it fetched and billed the same page twice
        // and was then discarded. The full read now runs only as the fallback when
        // extraction comes back empty, or concurrently when the caller also wants
        // links/images, which the passage endpoint does not return.
        const wantsPageExtras = Boolean(urlConfig.withAllLinks || urlConfig.withAllImages);
        let unrankedReason: string | undefined;
        if (useSvip && !wantsPageExtras) {
            const passages = await extractPassages();
            unrankedReason = passages.unrankedReason;
            if (passages.snippets) {
                return {
                    success: true,
                    url: urlConfig.url,
                    structuredData: {
                        url: passages.url || targetUrl,
                        title: passages.title,
                        question,
                        snippets: passages.snippets,
                        snippet_source: 'content',
                    },
                    withAllLinks: false,
                    withAllImages: false
                };
            }
        }

        const [response, snippetResult] = await Promise.all([
            fetch('https://r.jina.ai/', {
                method: 'POST',
                signal: AbortSignal.timeout(READ_REQUEST_TIMEOUT_MS),
                headers,
                body: JSON.stringify({ url: targetUrl }),
            }),
            useSvip && wantsPageExtras ? extractPassages() : Promise.resolve<NoPassages>({}),
        ]);
        unrankedReason ??= snippetResult.unrankedReason;

        if (!response.ok) {
            // r.jina.ai explains the failure (DNS, timeout, blocked) in `message`;
            // the bare status line left the caller unable to tell those apart.
            const body = await response.json().catch(() => null) as { message?: string } | null;
            const reason = body?.message?.split('\n')[0].slice(0, 300);
            return { error: `HTTP ${response.status}: ${reason || response.statusText}`, url: urlConfig.url };
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

        const content: string = data.data.content || "";

        if (question) {
            if (snippetResult.snippets) {
                structuredData.question = question;
                structuredData.snippets = snippetResult.snippets;
                // The full body is omitted: the point of passing a question is to
                // not carry the whole page. `snippet_source` separates a ranked
                // passage from the full-content fallback.
                structuredData.snippet_source = 'content';

                return {
                    success: true,
                    url: urlConfig.url,
                    structuredData,
                    withAllLinks: urlConfig.withAllLinks || false,
                    withAllImages: urlConfig.withAllImages || false
                };
            }

            // Extraction could not run, or ran and found nothing rankable.
            // Returning the full page is strictly more useful than an error, but
            // say so rather than letting the caller believe it is looking at a
            // ranked passage.
            structuredData.question = question;
            structuredData.snippet_source = 'full_content';
            structuredData.note = useSvip
                ? fullContentNote(unrankedReason)
                : 'Question-grounded extraction requires a Jina API key; returning full content.';
        }

        structuredData.content = content;

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
    timeout: number = READ_REQUEST_TIMEOUT_MS,
    clientIp?: string
): Promise<ReadUrlResponse[]> {
    // Per-URL deadline. The whole batch used to be raced against one rejecting
    // timeout, so one slow page threw away every read that had already
    // succeeded and the caller got a single generic error instead.
    return Promise.all(
        urlConfigs.map((urlConfig) =>
            withDeadline<ReadUrlResponse>(
                () => readUrlFromConfig(urlConfig, bearerToken, clientIp),
                timeout,
                () => ({ error: `Read timed out after ${timeout}ms`, url: urlConfig.url })
            )
        )
    );
}
