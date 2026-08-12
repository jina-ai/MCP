// ============================================================================
// TOKEN GUARDRAIL - Prevents MCP tool responses from exceeding client limits
// ============================================================================

const MAX_TOKENS = 25000;

// Clients known to have 25k token limit on MCP tool responses
const GUARDRAIL_CLIENTS = [
    'claude-code',
    'claude-ai',      // Claude Desktop
    'cursor-vscode',  // Cursor
];

type TextContentItem = { type: 'text'; text: string };
type ImageContentItem = { type: 'image'; data: string; mimeType: string };
type ContentItem = TextContentItem | ImageContentItem;

interface TokenCountResult {
    num_tokens: number;
    tokenizer: string;
}

// /v1/segment rejects content of 64k characters or more ("Content length must be
// greater than 0 and less than 64k"), which is *exactly* the size range the
// guardrail cares about: 25k tokens of English prose is ~100k characters. Every
// oversized document therefore used to 400 - after uploading the whole body -
// and silently fall back to a flat chars/4 guess. Count in chunks instead.
const SEGMENT_MAX_CHARS = 60000;
const SEGMENT_TIMEOUT_MS = 15000;

/** Rough local estimate, used only when the API is unavailable */
function estimateTokens(content: string): number {
    // ~4 chars/token holds for Latin script but overshoots badly for CJK, where a
    // character is closer to one token. Split the difference by script mix rather
    // than assuming English.
    const cjkCount = (content.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    const rest = content.length - cjkCount;
    return Math.ceil(cjkCount + rest / 4);
}

async function countSegmentChunk(chunk: string, bearerToken: string, apiBaseUrl: string): Promise<number> {
    const response = await fetch(`${apiBaseUrl}/v1/segment`, {
        method: 'POST',
        signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ content: chunk }),
    });

    if (!response.ok) {
        throw new Error(`segment failed: ${response.status}`);
    }

    const data = await response.json() as TokenCountResult;
    return data.num_tokens;
}

/**
 * Count tokens using Jina Segment API
 */
async function countTokens(content: string, bearerToken: string, apiBaseUrl: string = 'https://api.jina.ai'): Promise<number> {
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += SEGMENT_MAX_CHARS) {
        chunks.push(content.slice(i, i + SEGMENT_MAX_CHARS));
    }

    try {
        const counts = await Promise.all(
            chunks.map((chunk) => countSegmentChunk(chunk, bearerToken, apiBaseUrl))
        );
        // Summing per-chunk counts can differ from a single-pass count by at most
        // one token per boundary, which is immaterial against a 25k budget.
        return counts.reduce((sum, n) => sum + n, 0);
    } catch {
        return estimateTokens(content);
    }
}

/** Reserve a little budget for the "content was truncated" notice */
const TRUNCATION_NOTICE_TOKENS = 64;

/**
 * Truncate text content items so the response fits the client's budget.
 *
 * - Token counts for every item are resolved concurrently. They used to be
 *   awaited one at a time, so a 5-URL parallel_read_url paid five *sequential*
 *   /v1/segment round-trips after the reads had already finished.
 * - Original item order is preserved (images used to be hoisted ahead of text).
 * - At least one text item always survives: previously, if the very first item
 *   was on its own over budget the loop broke immediately and the caller got a
 *   response with no text content at all, silently.
 * - Dropped/truncated content is reported instead of vanishing, so the model
 *   knows it is looking at a partial document.
 */
async function truncateContentItems(
    contentItems: ContentItem[],
    bearerToken: string,
    maxTokens: number = MAX_TOKENS,
    apiBaseUrl: string = 'https://api.jina.ai'
): Promise<ContentItem[]> {
    const textItems = contentItems.filter((item): item is TextContentItem => item.type === 'text');
    if (textItems.length === 0) {
        return contentItems;
    }

    // A token never spans fewer than one UTF-8 byte, so a response whose total
    // byte length is already within budget cannot exceed it in tokens. Checking
    // that first skips the /v1/segment round-trips entirely for ordinary pages,
    // instead of uploading every document just to be told it fits.
    const totalBytes = textItems.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
    if (totalBytes <= maxTokens) {
        return contentItems;
    }

    const tokenCounts = new Map<TextContentItem, number>();
    await Promise.all(
        textItems.map(async (item) => {
            tokenCounts.set(item, await countTokens(item.text, bearerToken, apiBaseUrl));
        })
    );

    const totalTokens = [...tokenCounts.values()].reduce((sum, n) => sum + n, 0);
    if (totalTokens <= maxTokens) {
        return contentItems;
    }

    const budget = maxTokens - TRUNCATION_NOTICE_TOKENS;
    const kept: ContentItem[] = [];
    let used = 0;
    let droppedItems = 0;
    let truncated = false;

    for (const item of contentItems) {
        if (item.type !== 'text') {
            kept.push(item);
            continue;
        }

        const itemTokens = tokenCounts.get(item) ?? 0;

        if (used + itemTokens <= budget) {
            kept.push(item);
            used += itemTokens;
            continue;
        }

        // First item that does not fit: spend whatever budget is left on a prefix
        // of it, then drop the rest. This is what guarantees the caller always
        // gets *some* content back, even when item one alone blows the budget.
        const remaining = budget - used;
        if (!truncated && remaining > 0 && itemTokens > 0) {
            // Proportional character cut - approximate, but token density is
            // roughly uniform within a single document
            const keepChars = Math.floor(item.text.length * (remaining / itemTokens));
            if (keepChars > 0) {
                kept.push({ type: 'text', text: item.text.slice(0, keepChars) });
                used = budget;
                truncated = true;
                continue;
            }
        }

        droppedItems++;
    }

    const notes: string[] = [];
    if (truncated) notes.push('content was truncated to fit the client token limit');
    if (droppedItems > 0) notes.push(`${droppedItems} further result(s) omitted`);
    if (notes.length > 0) {
        kept.push({
            type: 'text',
            text: `[jina-mcp] Response exceeded the ${maxTokens}-token client limit: ${notes.join('; ')}. Re-run with fewer URLs, or read the omitted URLs individually, to see the rest.`,
        });
    }

    return kept;
}

/**
 * Check if client needs token guardrail
 *
 * `clientName` can no longer come only from server.getClientVersion(): the MCP
 * `initialize` request that carries clientInfo is handled in a *different* Worker
 * invocation than the `tools/call` that needs it, and this deployment is stateless
 * (createMcpHandler gets no `storage`, so WorkerTransport never replays
 * initializeParams). getClientVersion() is therefore undefined at tool-call time
 * and this predicate always returned false - the whole truncation path was dead.
 * index.ts now also passes the transport User-Agent as a fallback hint.
 */
export function shouldApplyGuardrail(clientName: string | undefined): boolean {
    if (!clientName) return false;
    return GUARDRAIL_CLIENTS.some(c => clientName.toLowerCase().includes(c.toLowerCase()));
}

/**
 * Apply token guardrail to MCP tool response
 *
 * Applies to known limited clients (Claude Code, Claude Desktop, Cursor), or to
 * any client that states its own budget with `?max_tokens=` on the endpoint URL.
 * `?max_tokens=0` opts out entirely.
 */
export async function applyTokenGuardrail(
    response: { content: ContentItem[]; isError?: boolean },
    bearerToken: string,
    clientName?: string,
    apiBaseUrl: string = 'https://api.jina.ai',
    explicitMaxTokens?: number
): Promise<{ content: ContentItem[]; isError?: boolean }> {
    const maxTokens = explicitMaxTokens ?? (shouldApplyGuardrail(clientName) ? MAX_TOKENS : undefined);

    // Not a known limited client and no declared budget
    if (maxTokens === undefined || maxTokens <= 0) {
        return response;
    }

    if (response.isError) {
        return response;
    }

    const truncatedContent = await truncateContentItems(
        response.content,
        bearerToken,
        maxTokens,
        apiBaseUrl
    );

    return {
        ...response,
        content: truncatedContent
    };
}
