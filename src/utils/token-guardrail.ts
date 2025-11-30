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

/**
 * Count tokens using Jina Segment API
 */
async function countTokens(content: string, bearerToken: string): Promise<number> {
    try {
        const response = await fetch('https://api.jina.ai/v1/segment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${bearerToken}`,
            },
            body: JSON.stringify({ content }),
        });

        if (!response.ok) {
            // Fallback: rough estimate (1 token ≈ 4 chars for English)
            return Math.ceil(content.length / 4);
        }

        const data = await response.json() as TokenCountResult;
        return data.num_tokens;
    } catch {
        // Fallback: rough estimate
        return Math.ceil(content.length / 4);
    }
}

/**
 * Truncate text content items in a structure-safe way
 * - For single large item: truncate the text content
 * - For multiple items: keep items until adding next would exceed limit
 */
async function truncateContentItems(
    contentItems: ContentItem[],
    bearerToken: string,
    maxTokens: number = MAX_TOKENS
): Promise<ContentItem[]> {
    const textItems = contentItems.filter((item): item is TextContentItem => item.type === 'text');
    const nonTextItems = contentItems.filter((item): item is ImageContentItem => item.type !== 'text');

    if (textItems.length === 0) {
        return contentItems;
    }

    // Single item case: truncate the text if too large
    if (textItems.length === 1) {
        const item = textItems[0];
        const tokens = await countTokens(item.text, bearerToken);

        if (tokens <= maxTokens) {
            return contentItems;
        }

        // Truncate text proportionally (use full ratio since no notice appended)
        const keepRatio = maxTokens / tokens;
        const truncatedLength = Math.floor(item.text.length * keepRatio);

        return [
            ...nonTextItems,
            {
                type: 'text',
                text: item.text.substring(0, truncatedLength)
            }
        ];
    }

    // Multiple items case: keep adding until would exceed limit
    const keptItems: TextContentItem[] = [];
    let totalTokens = 0;

    for (const item of textItems) {
        const itemTokens = await countTokens(item.text, bearerToken);

        if (totalTokens + itemTokens > maxTokens) {
            // Adding this item would exceed limit, stop here
            break;
        }

        keptItems.push(item);
        totalTokens += itemTokens;
    }

    return [...nonTextItems, ...keptItems];
}

/**
 * Check if client needs token guardrail
 */
export function shouldApplyGuardrail(clientName: string | undefined): boolean {
    if (!clientName) return false;
    return GUARDRAIL_CLIENTS.some(c => clientName.toLowerCase().includes(c.toLowerCase()));
}

/**
 * Apply token guardrail to MCP tool response
 * Only applies to known clients with token limits (Claude Code, Claude Desktop, Cursor)
 */
export async function applyTokenGuardrail(
    response: { content: ContentItem[]; isError?: boolean },
    bearerToken: string,
    clientName?: string
): Promise<{ content: ContentItem[]; isError?: boolean }> {
    // Skip guardrail if not a known limited client
    if (!shouldApplyGuardrail(clientName)) {
        return response;
    }

    if (response.isError) {
        return response;
    }

    const truncatedContent = await truncateContentItems(
        response.content,
        bearerToken,
        MAX_TOKENS
    );

    return {
        ...response,
        content: truncatedContent
    };
}

/**
 * List of tool names that should have token guardrail applied
 * Focus on tools that return full content (not just snippets/metadata)
 */
export const GUARDRAIL_TOOLS = [
    'read_url',
    'parallel_read_url',
];
