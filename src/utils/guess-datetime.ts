// Utility functions for guessing datetime from web pages
// Refactored from Cloudflare Worker for MCP tool usage

// The web predates neither of these, so anything outside the window is a parse
// artifact rather than a publication date - a copyright range like "1999-2030",
// an event scheduled for next year, a template placeholder, or a unix timestamp
// read at the wrong scale. The upper bound keeps 48h of slack for clock skew and
// for timezone-less strings that land "tomorrow" relative to UTC.
const EARLIEST_PLAUSIBLE_PAGE_DATE = Date.UTC(1990, 0, 1);
const FUTURE_TOLERANCE_MS = 48 * 60 * 60 * 1000;

// Every extractor below runs its own regex passes over the whole document, so the
// body has to be bounded: an unbounded response turns one tool call into an
// unbounded amount of Worker CPU. Timestamps live in <head> and in feed preambles,
// which comfortably fit these caps.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_FEED_BYTES = 512 * 1024;
const PAGE_FETCH_TIMEOUT_MS = 15000;
const FEED_FETCH_TIMEOUT_MS = 5000;

/** Read a response body as text, stopping after maxBytes */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let text = '';
    let total = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            if (total + value.byteLength >= maxBytes) {
                text += decoder.decode(value.subarray(0, maxBytes - total));
                return text;
            }

            total += value.byteLength;
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally {
        await reader.cancel().catch(() => { });
    }

    return text;
}

function isPlausiblePageDate(date: Date | null): boolean {
    if (!date) return false;
    const t = date.getTime();
    if (Number.isNaN(t)) return false;
    return t >= EARLIEST_PLAUSIBLE_PAGE_DATE && t <= Date.now() + FUTURE_TOLERANCE_MS;
}

/** new Date(value), or null when it is unparseable or not a plausible page date */
function toPlausibleDate(value: string | number): Date | null {
    const date = new Date(value);
    return isPlausiblePageDate(date) ? date : null;
}

// Improved parseDate function to handle more date formats
function parseDate(dateStr: string): Date | null {
    const parsed = parseDateUnfiltered(dateStr);
    // A date the page cannot plausibly have been updated at is worse than no date:
    // determineBestUpdateTime() picks the *most recent* candidate, so a single
    // stray future date outranks every real signal on the page.
    return isPlausiblePageDate(parsed) ? parsed : null;
}

function parseDateUnfiltered(dateStr: string): Date | null {
    if (!dateStr) return null;

    // Clean up the string (remove extra spaces, normalize separators)
    let cleanStr = dateStr.trim()
        .replace(/\s+/g, ' ')
        .replace(/-(\d{2}:)/, ' $1'); // Fix formats like 2025-03-05-21:25:00

    // Try direct parsing first
    const date = new Date(cleanStr);
    if (!isNaN(date.getTime())) return date;

    // Try parsing ISO-like formats with variations
    const isoPattern = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T\s-](\d{1,2})[:\.](\d{1,2})(?:[:\.](\d{1,2}))?)?/;
    const isoMatch = cleanStr.match(isoPattern);
    if (isoMatch) {
        const year = parseInt(isoMatch[1]);
        const month = parseInt(isoMatch[2]) - 1; // JS months are 0-indexed
        const day = parseInt(isoMatch[3]);
        const hour = isoMatch[4] ? parseInt(isoMatch[4]) : 0;
        const minute = isoMatch[5] ? parseInt(isoMatch[5]) : 0;
        const second = isoMatch[6] ? parseInt(isoMatch[6]) : 0;

        const newDate = new Date(year, month, day, hour, minute, second);
        if (!isNaN(newDate.getTime())) return newDate;
    }

    // Try MM/DD/YYYY and DD/MM/YYYY formats
    const slashPattern = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/;
    const slashMatch = cleanStr.match(slashPattern);
    if (slashMatch) {
        // Try both MM/DD/YYYY and DD/MM/YYYY interpretations
        const parts = [parseInt(slashMatch[1]), parseInt(slashMatch[2]), parseInt(slashMatch[3])];

        // MM/DD/YYYY attempt
        const usDate = new Date(parts[2], parts[0] - 1, parts[1]);
        if (!isNaN(usDate.getTime()) && usDate.getMonth() === parts[0] - 1 && usDate.getDate() === parts[1]) {
            return usDate;
        }

        // DD/MM/YYYY attempt
        const euDate = new Date(parts[2], parts[1] - 1, parts[0]);
        if (!isNaN(euDate.getTime()) && euDate.getMonth() === parts[1] - 1 && euDate.getDate() === parts[0]) {
            return euDate;
        }
    }

    // Try month name patterns
    const monthNamePattern = /([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i;
    const monthMatch = cleanStr.match(monthNamePattern);
    if (monthMatch) {
        const newDate = new Date(`${monthMatch[1]} ${monthMatch[2]}, ${monthMatch[3]}`);
        if (!isNaN(newDate.getTime())) return newDate;
    }

    // Try international date formats
    // Chinese: YYYY年MM月DD日
    const chinesePattern = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
    const chineseMatch = cleanStr.match(chinesePattern);
    if (chineseMatch) {
        const year = parseInt(chineseMatch[1]);
        const month = parseInt(chineseMatch[2]) - 1;
        const day = parseInt(chineseMatch[3]);
        const newDate = new Date(year, month, day);
        if (!isNaN(newDate.getTime())) return newDate;
    }

    // Japanese: YYYY年MM月DD日
    const japanesePattern = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
    const japaneseMatch = cleanStr.match(japanesePattern);
    if (japaneseMatch) {
        const year = parseInt(japaneseMatch[1]);
        const month = parseInt(japaneseMatch[2]) - 1;
        const day = parseInt(japaneseMatch[3]);
        const newDate = new Date(year, month, day);
        if (!isNaN(newDate.getTime())) return newDate;
    }

    // European: DD.MM.YYYY
    const europeanPattern = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
    const europeanMatch = cleanStr.match(europeanPattern);
    if (europeanMatch) {
        const day = parseInt(europeanMatch[1]);
        const month = parseInt(europeanMatch[2]) - 1;
        const year = parseInt(europeanMatch[3]);
        const newDate = new Date(year, month, day);
        if (!isNaN(newDate.getTime())) return newDate;
    }

    // Korean: YYYY-MM-DD
    const koreanPattern = /(\d{4})-(\d{1,2})-(\d{1,2})/;
    const koreanMatch = cleanStr.match(koreanPattern);
    if (koreanMatch) {
        const year = parseInt(koreanMatch[1]);
        const month = parseInt(koreanMatch[2]) - 1;
        const day = parseInt(koreanMatch[3]);
        const newDate = new Date(year, month, day);
        if (!isNaN(newDate.getTime())) return newDate;
    }

    // Try Unix timestamps (seconds or milliseconds)
    if (/^\d+$/.test(cleanStr)) {
        const timestamp = parseInt(cleanStr);
        // If the number is too small to be a millisecond timestamp but could be seconds
        const date = new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
        if (!isNaN(date.getTime()) && date.getFullYear() > 1970 && date.getFullYear() < 2100) {
            return date;
        }
    }

    return null;
}

// Extract Schema.org timestamps
function extractSchemaOrgTimestamps(html: string): Array<{
    type: string;
    field: string;
    date: string;
    priority: string;
    context: string;
}> {
    const results: Array<{
        type: string;
        field: string;
        date: string;
        priority: string;
        context: string;
    }> = [];

    // Find JSON+LD scripts with Schema.org data
    const schemaPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let schemaMatch;

    while ((schemaMatch = schemaPattern.exec(html)) !== null) {
        try {
            const jsonData = JSON.parse(schemaMatch[1]);

            // Process array of schemas or single schema object
            const schemas = Array.isArray(jsonData) ? jsonData : [jsonData];

            for (const schema of schemas) {
                // Handle nested graphs
                if (schema['@graph'] && Array.isArray(schema['@graph'])) {
                    for (const item of schema['@graph']) {
                        extractDatesFromSchema(item, results);
                    }
                } else {
                    extractDatesFromSchema(schema, results);
                }
            }
        } catch (e) {
            // Skip invalid JSON
        }
    }

    return results;
}

// Helper function to extract dates from schema objects
function extractDatesFromSchema(schema: any, results: Array<{
    type: string;
    field: string;
    date: string;
    priority: string;
    context: string;
}>) {
    const dateProperties = [
        'dateModified',
        'dateUpdated',
        'datePublished',
        'dateCreated',
        'uploadDate',
        'lastReviewed'
    ];

    for (const prop of dateProperties) {
        if (schema[prop]) {
            const date = parseDate(schema[prop]);
            if (date) {
                results.push({
                    type: 'schemaOrg',
                    field: prop,
                    date: date.toISOString(),
                    priority: prop === 'dateModified' ? 'high' :
                        prop === 'dateUpdated' ? 'high' : 'medium',
                    context: `Schema.org ${schema['@type'] || 'object'}`
                });
            }
        }
    }

    // Check for nested objects that might contain dates
    if (schema.mainEntity) {
        extractDatesFromSchema(schema.mainEntity, results);
    }

    // Handle Article specific schema
    if (schema['@type'] === 'Article' && schema.author) {
        const authorObj = typeof schema.author === 'object' ? schema.author : {};
        for (const prop of dateProperties) {
            if (authorObj[prop]) {
                const date = parseDate(authorObj[prop]);
                if (date) {
                    results.push({
                        type: 'schemaOrg',
                        field: `author.${prop}`,
                        date: date.toISOString(),
                        priority: 'medium',
                        context: 'Article author'
                    });
                }
            }
        }
    }
}

// Extract HTML comments that might contain version info
function extractHtmlComments(html: string): Array<{
    type: string;
    date: string;
    context: string;
    version?: string;
}> {
    const results: Array<{
        type: string;
        date: string;
        context: string;
        version?: string;
    }> = [];
    const commentPattern = /<!--([\s\S]*?)-->/g;
    let commentMatch;

    while ((commentMatch = commentPattern.exec(html)) !== null) {
        const comment = commentMatch[1];

        // Look for version patterns
        const versionPattern = /(?:version|v|revision|rev|updated|modified|timestamp)[\s:=]+([0-9.]+|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/i;
        const versionMatch = comment.match(versionPattern);

        if (versionMatch) {
            // Try to parse as date
            const date = parseDate(versionMatch[1]);
            if (date) {
                results.push({
                    type: 'htmlComment',
                    date: date.toISOString(),
                    context: comment.trim().substring(0, 100),
                    version: versionMatch[1]
                });
            } else if (/\d{4}-\d{2}-\d{2}/.test(versionMatch[1])) {
                // Looks like a date but couldn't parse, try manual parsing
                const parts = versionMatch[1].split(/[-\/]/);
                if (parts.length === 3 && parts[0].length === 4) {
                    const date = toPlausibleDate(`${parts[0]}-${parts[1]}-${parts[2]}`);
                    if (date) {
                        results.push({
                            type: 'htmlComment',
                            date: date.toISOString(),
                            context: comment.trim().substring(0, 100)
                        });
                    }
                }
            }
        }

        // Look for date patterns
        const datePattern = /(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{1,2} [A-Za-z]+ \d{4})/;
        const dateMatch = comment.match(datePattern);

        if (dateMatch && !versionMatch) {
            const date = parseDate(dateMatch[1]);
            if (date) {
                results.push({
                    type: 'htmlComment',
                    date: date.toISOString(),
                    context: comment.trim().substring(0, 100)
                });
            }
        }
    }

    return results;
}

// Check Git blame info (sometimes exposed in HTML comments)
function extractGitInfo(html: string): {
    gitHash?: string;
    gitDate?: string;
    deployDate?: string;
} {
    const results: {
        gitHash?: string;
        gitDate?: string;
        deployDate?: string;
    } = {};

    // Look for Git hash in comments
    const gitHashPattern = /<!--[\s\S]*?(?:commit|hash|git)[:\s]+([a-f0-9]{7,40})[\s\S]*?-->/i;
    const gitHashMatch = html.match(gitHashPattern);

    if (gitHashMatch) {
        results.gitHash = gitHashMatch[1];

        // Look for date near the hash
        const nearbyDatePattern = new RegExp(`<!--[\\s\\S]*?${gitHashMatch[1]}[\\s\\S]*?(\\d{4}-\\d{2}-\\d{2}|\\d{2}/\\d{2}/\\d{4})[\\s\\S]*?-->`, 'i');
        const nearbyDateMatch = html.match(nearbyDatePattern);

        if (nearbyDateMatch) {
            const date = parseDate(nearbyDateMatch[1]);
            if (date) {
                results.gitDate = date.toISOString();
            }
        }
    }

    // Look for GitLab/GitHub deploy comments
    // NB: the trailing class must be [\s\S] (any char). `[\\s\\S]` inside a regex
    // *literal* is the three-character class {\, s, S}, which made this pattern
    // match only when nothing but backslashes/s/S sat between the date and `-->`.
    const deployPattern = /<!--[\s\S]*?(?:deployed|deployment|deploy)[\s\S]*?((?:\d{4}-\d{2}-\d{2})|(?:\d{2}\/\d{2}\/\d{4}))[\s\S]*?-->/i;
    const deployMatch = html.match(deployPattern);

    if (deployMatch) {
        const date = parseDate(deployMatch[1]);
        if (date) {
            results.deployDate = date.toISOString();
        }
    }

    return results;
}

// Extract meta update times
function extractMetaUpdateTimes(html: string): {
    lastModified?: string;
    publishedDate?: string;
    articleModified?: string;
    articlePublished?: string;
    pageGenerated?: string;
    ogUpdatedTime?: string;
    lastmod?: string;
    generated?: string;
    build?: string;
    revision?: string;
    version?: string;
} {
    const results: {
        lastModified?: string;
        publishedDate?: string;
        articleModified?: string;
        articlePublished?: string;
        pageGenerated?: string;
        ogUpdatedTime?: string;
        lastmod?: string;
        generated?: string;
        build?: string;
        revision?: string;
        version?: string;
    } = {};

    // More flexible meta tag pattern matching (attribute order independent)
    const metaTimePattern = /<meta\s+(?:[^>]*?\s+)?(?:name|property)=["']([^"']+)["'](?:[^>]*?\s+)?content=["']([^"']+)["']|<meta\s+(?:[^>]*?\s+)?content=["']([^"']+)["'](?:[^>]*?\s+)?(?:name|property)=["']([^"']+)["']/gi;

    let match;
    while ((match = metaTimePattern.exec(html)) !== null) {
        // Handle both attribute orders
        const name = match[1] || match[4];
        const content = match[2] || match[3];

        if (!name || !content) continue;

        // Check for various time-related meta tags
        if (/last[-_]?modified|modified[-_]?time|update[-_]?time|date[-_]?modified|modified|revision/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.lastModified = date.toISOString();
            }
        }
        else if (/published[-_]?time|pub[-_]?date|date[-_]?published|creation[-_]?date|firstpublishedtime/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.publishedDate = date.toISOString();
            }
        }
        else if (/article:modified_time|og:updated_time/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.articleModified = date.toISOString();
            }
        }
        else if (/article:published_time|og:published_time/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.articlePublished = date.toISOString();
            }
        }
        else if (/og:updated_time/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.ogUpdatedTime = date.toISOString();
            }
        }
        else if (/lastmod|last[-_]?mod/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.lastmod = date.toISOString();
            }
        }
        else if (/generated|gen[-_]?date|build[-_]?date/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.generated = date.toISOString();
            }
        }
        else if (/build|build[-_]?time|build[-_]?date/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.build = date.toISOString();
            }
        }
        else if (/revision|rev/i.test(name)) {
            const date = parseDate(content);
            if (date) {
                results.revision = date.toISOString();
            }
        }
        else if (/version|ver/i.test(name) && /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(content)) {
            // Extract date from version content that might contain other text
            const dateMatch = content.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?)/);
            if (dateMatch) {
                const date = parseDate(dateMatch[1]);
                if (date) {
                    results.version = date.toISOString();
                }
            }
        }
        else if (/page[-_]?generated[-_]?time|gendate|generated|others/i.test(name) && /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(content)) {
            // Extract date from content that might contain other text
            const dateMatch = content.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?)/);
            if (dateMatch) {
                const date = parseDate(dateMatch[1]);
                if (date) {
                    results.pageGenerated = date.toISOString();
                }
            }
        }
    }

    return results;
}

// Extract visible dates from HTML content
function extractVisibleDates(html: string): Array<{
    type: string;
    date: string;
    context: string;
    priority: string;
}> {
    const results: Array<{
        type: string;
        date: string;
        context: string;
        priority: string;
    }> = [];

    // Common date indicator classes
    const dateClassPattern = /<(?:div|span|p)\s+class=["'](?:[^"']*\s+)?(?:date|time|timestamp|pubdate|updated|modified|posted-on|entry-date|publish-date|post-date)[^"']*["'][^>]*>([^<]+)/gi;

    let match;
    while ((match = dateClassPattern.exec(html)) !== null) {
        const content = match[1].trim();
        // Check if content looks date-like
        if (/\d{4}/.test(content)) {
            const date = parseDate(content);
            if (date) {
                results.push({
                    type: 'dateClass',
                    date: date.toISOString(),
                    context: content,
                    priority: 'medium'
                });
            }
        }
    }

    // Extract dates from time elements (more reliable)
    const timePattern = /<time(?:\s+[^>]*)?\s+datetime=["']([^"']+)["'][^>]*>.*?<\/time>/gi;
    while ((match = timePattern.exec(html)) !== null) {
        const datetime = match[1];
        const date = parseDate(datetime);
        if (date) {
            results.push({
                type: 'timeElement',
                date: date.toISOString(),
                context: match[0].substring(0, 100),
                priority: 'high' // Time elements are usually more reliable
            });
        }
    }

    // Common date patterns in text
    const dateFormatPatterns = [
        // ISO 8601
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})/g,

        // Common date formats
        /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/g,
        /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}(?::\d{2})?/g,

        // Date only formats
        /\d{4}-\d{2}-\d{2}/g,
        /\d{2}\/\d{2}\/\d{4}/g
    ];

    for (const pattern of dateFormatPatterns) {
        let dateMatch;
        while ((dateMatch = pattern.exec(html)) !== null) {
            const date = parseDate(dateMatch[0]);
            if (date) {
                results.push({
                    type: 'visibleDate',
                    date: date.toISOString(),
                    context: html.substring(Math.max(0, dateMatch.index - 50),
                        dateMatch.index + dateMatch[0].length + 50),
                    priority: 'medium'
                });
            }
        }
    }

    // Update phrases with more variants
    const updatePhrasePattern = /(?:updated|last modified|modified|revised|last updated|posted|published)(?:\s*(?:on|at|date|time))?[:：]\s*([^<\n\r]{5,30})/gi;
    while ((match = updatePhrasePattern.exec(html)) !== null) {
        const dateStr = match[1].trim();
        const date = parseDate(dateStr);
        if (date) {
            results.push({
                type: 'updatePhrase',
                date: date.toISOString(),
                context: match[0],
                priority: 'high'
            });
        }
    }

    return results;
}

// Extract JavaScript timestamps
function extractJavaScriptTimestamps(html: string): Array<{
    type: string;
    date: string;
    context: string;
    field?: string;
    priority?: string;
}> {
    const results: Array<{
        type: string;
        date: string;
        context: string;
        field?: string;
        priority?: string;
    }> = [];

    // Find timestamps in script tags
    const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptMatch;
    while ((scriptMatch = scriptPattern.exec(html)) !== null) {
        const scriptContent = scriptMatch[1];

        // Look for timestamp variables
        const timestampPatterns = [
            /(?:last_?(?:updated|modified)|modified_?(?:date|time)|update_?(?:date|time)|published_?(?:date|time))\s*[=:]\s*['"]?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?)['"]?/i,
            /(?:last_?(?:updated|modified)|modified_?(?:date|time)|update_?(?:date|time)|published_?(?:date|time))\s*[=:]\s*new Date\(["']?([^)]+)["']?\)/i,
            /(?:last_?(?:updated|modified)|modified_?(?:date|time)|update_?(?:date|time)|published_?(?:date|time))\s*[=:]\s*(\d+)/i // Unix timestamp
        ];

        for (const pattern of timestampPatterns) {
            const match = scriptContent.match(pattern);
            if (match && match[1]) {
                let date: Date | null;
                if (/^\d+$/.test(match[1])) {
                    // Handle Unix timestamps (in seconds or milliseconds)
                    const timestamp = parseInt(match[1]);
                    date = toPlausibleDate(timestamp > 9999999999 ? timestamp : timestamp * 1000);
                } else {
                    date = toPlausibleDate(match[1]);
                }

                if (date) {
                    results.push({
                        type: 'jsTimestamp',
                        date: date.toISOString(),
                        context: match[0],
                        priority: 'medium'
                    });
                }
            }
        }

        // Look for data objects with date properties
        const dataObjectPattern = /(?:article|page|post|document|content|data)(?:Data)?\s*[=:]\s*\{[\s\S]*?(?:updated|modified|published|date)(?:At|On|Date|Time)?\s*[=:]\s*["']?([^,"'\}\s]+)["']?/i;
        const dataObjectMatch = scriptContent.match(dataObjectPattern);
        if (dataObjectMatch && dataObjectMatch[1]) {
            const date = toPlausibleDate(dataObjectMatch[1]);
            if (date) {
                results.push({
                    type: 'jsDataObject',
                    date: date.toISOString(),
                    context: dataObjectMatch[0].substring(0, 100),
                    priority: 'medium'
                });
            }
        }
    }

    // Look for JSON-LD scripts which often contain date information
    const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let jsonLdMatch;
    while ((jsonLdMatch = jsonLdPattern.exec(html)) !== null) {
        try {
            const jsonLd = JSON.parse(jsonLdMatch[1]);

            // Extract dates from JSON-LD
            const dateFields = ['dateModified', 'dateUpdated', 'datePublished', 'uploadDate'];
            for (const field of dateFields) {
                if (jsonLd[field]) {
                    const date = toPlausibleDate(jsonLd[field]);
                    if (date) {
                        results.push({
                            type: 'jsonLd',
                            field: field,
                            date: date.toISOString(),
                            priority: field === 'dateModified' ? 'high' : 'medium',
                            context: `JSON-LD ${field}`
                        });
                    }
                }
            }
        } catch (e) {
            // Invalid JSON, skip this script
        }
    }

    return results;
}

// Extract RSS/Atom feed timestamps
async function extractFeedTimestamps(targetUrl: string): Promise<Array<{
    type: string;
    date: string;
    context: string;
    priority: string;
}>> {
    const results: Array<{
        type: string;
        date: string;
        context: string;
        priority: string;
    }> = [];

    try {
        const urlObj = new URL(targetUrl);
        const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;

        // Common feed URLs to check
        const feedUrls = [
            `${baseUrl}/feed`,
            `${baseUrl}/rss`,
            `${baseUrl}/atom`,
            `${baseUrl}/feed.xml`,
            `${baseUrl}/rss.xml`,
            `${baseUrl}/atom.xml`,
            `${baseUrl}/sitemap.xml`
        ];

        // These were fetched one after another with no timeout, so a site that
        // serves a slow 404 for /feed delayed the other six - up to 7 serial
        // round-trips on every guess_datetime_url call. They are independent, so
        // fan them out and bound each one. allSettled preserves feedUrls order,
        // keeping the emitted results deterministic.
        const fetched = await Promise.allSettled(
            feedUrls.map(async (feedUrl) => {
                const response = await fetch(feedUrl, {
                    signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
                });
                if (!response.ok) return null;
                return { feedUrl, text: await readCapped(response, MAX_FEED_BYTES) };
            })
        );

        for (const settled of fetched) {
            if (settled.status !== 'fulfilled' || !settled.value) continue;
            const { feedUrl, text } = settled.value;
            {
                // Check for RSS feed
                if (text.includes('<rss') || text.includes('<rdf')) {
                    // Look for lastBuildDate in RSS
                    const lastBuildMatch = text.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/i);
                    if (lastBuildMatch) {
                        const date = parseDate(lastBuildMatch[1]);
                        if (date) {
                            results.push({
                                type: 'rssLastBuild',
                                date: date.toISOString(),
                                context: `RSS feed: ${feedUrl}`,
                                priority: 'high'
                            });
                        }
                    }

                    // Look for pubDate in RSS items
                    const pubDateMatch = text.match(/<pubDate>([^<]+)<\/pubDate>/i);
                    if (pubDateMatch) {
                        const date = parseDate(pubDateMatch[1]);
                        if (date) {
                            results.push({
                                type: 'rssPubDate',
                                date: date.toISOString(),
                                context: `RSS pubDate: ${feedUrl}`,
                                priority: 'medium'
                            });
                        }
                    }
                }

                // Check for Atom feed
                else if (text.includes('<feed')) {
                    // Look for updated in Atom
                    const updatedMatch = text.match(/<updated>([^<]+)<\/updated>/i);
                    if (updatedMatch) {
                        const date = parseDate(updatedMatch[1]);
                        if (date) {
                            results.push({
                                type: 'atomUpdated',
                                date: date.toISOString(),
                                context: `Atom feed: ${feedUrl}`,
                                priority: 'high'
                            });
                        }
                    }
                }

                // Check for sitemap
                else if (text.includes('<urlset')) {
                    // Look for lastmod in sitemap
                    const lastmodMatch = text.match(/<lastmod>([^<]+)<\/lastmod>/i);
                    if (lastmodMatch) {
                        const date = parseDate(lastmodMatch[1]);
                        if (date) {
                            results.push({
                                type: 'sitemapLastmod',
                                date: date.toISOString(),
                                context: `Sitemap: ${feedUrl}`,
                                priority: 'high'
                            });
                        }
                    }
                }
            }
        }
    } catch (e) {
        // Skip if URL parsing fails
    }

    return results;
}

// Extract all time indicators from a web page
async function extractAllTimeIndicators(response: Response, html: string, targetUrl: string) {
    const result: any = {
        // Standard HTTP headers
        lastModified: response.headers.get('last-modified') || null,
        etag: response.headers.get('etag') || null,
        date: response.headers.get('date') || null,
        expires: response.headers.get('expires') || null,

        // HTML metadata
        metaTags: extractMetaUpdateTimes(html),

        // HTML content-based timestamps
        visibleDates: extractVisibleDates(html),

        // JavaScript timestamps
        jsTimestamps: extractJavaScriptTimestamps(html),

        // Schema.org timestamps
        schemaOrgTimestamps: extractSchemaOrgTimestamps(html),

        // HTML comments extraction
        htmlComments: extractHtmlComments(html),

        // Git info extraction
        gitInfo: extractGitInfo(html),

        // Server time
        serverTime: response.headers.get('date') || null,
    };

    // Add feed timestamps (RSS, Atom, Sitemap)
    try {
        result.feedTimestamps = await extractFeedTimestamps(targetUrl);
    } catch (e) {
        result.feedTimestamps = [];
    }

    return result;
}

// Determine the best update time from all available indicators
function determineBestUpdateTime(updateTimes: any) {
    // First check for meta tags that explicitly indicate last modified time
    if (updateTimes.metaTags && updateTimes.metaTags.lastModified) {
        return {
            timestamp: updateTimes.metaTags.lastModified,
            confidence: 95,
            reasoning: ["Explicit lastmodifiedtime meta tag"]
        };
    }

    // Check other meta tags related to publication/modification
    if (updateTimes.metaTags) {
        if (updateTimes.metaTags.articleModified) {
            return {
                timestamp: updateTimes.metaTags.articleModified,
                confidence: 90,
                reasoning: ["Article modified time meta tag"]
            };
        }

        if (updateTimes.metaTags.publishedDate) {
            return {
                timestamp: updateTimes.metaTags.publishedDate,
                confidence: 85,
                reasoning: ["Published date meta tag"]
            };
        }

        // Check for new high-value meta tags
        if (updateTimes.metaTags.ogUpdatedTime) {
            return {
                timestamp: updateTimes.metaTags.ogUpdatedTime,
                confidence: 88,
                reasoning: ["Open Graph updated time meta tag"]
            };
        }

        if (updateTimes.metaTags.lastmod) {
            return {
                timestamp: updateTimes.metaTags.lastmod,
                confidence: 87,
                reasoning: ["Last modified meta tag"]
            };
        }

        if (updateTimes.metaTags.generated) {
            return {
                timestamp: updateTimes.metaTags.generated,
                confidence: 85,
                reasoning: ["Page generated meta tag"]
            };
        }

        if (updateTimes.metaTags.build) {
            return {
                timestamp: updateTimes.metaTags.build,
                confidence: 83,
                reasoning: ["Build timestamp meta tag"]
            };
        }
    }

    // Check feed timestamps (RSS, Atom, Sitemap) - often very reliable
    if (updateTimes.feedTimestamps && updateTimes.feedTimestamps.length > 0) {
        // Filter for high priority feed timestamps
        const highPriorityFeeds = updateTimes.feedTimestamps
            .filter((stamp: any) => stamp.priority === 'high')
            .map((stamp: any) => ({ date: new Date(stamp.date), type: stamp.type, context: stamp.context }));

        if (highPriorityFeeds.length > 0) {
            // Sort by recency
            highPriorityFeeds.sort((a: any, b: any) => b.date.getTime() - a.date.getTime());

            return {
                timestamp: highPriorityFeeds[0].date.toISOString(),
                confidence: 92,
                reasoning: ["Feed timestamp", `Type: ${highPriorityFeeds[0].type}`, `Context: ${highPriorityFeeds[0].context}`]
            };
        }

        // If no high priority feeds, use most recent feed timestamp
        const allFeedDates = updateTimes.feedTimestamps
            .map((stamp: any) => ({ date: new Date(stamp.date), type: stamp.type, context: stamp.context }));

        allFeedDates.sort((a: any, b: any) => b.date.getTime() - a.date.getTime());

        return {
            timestamp: allFeedDates[0].date.toISOString(),
            confidence: 85,
            reasoning: ["Feed timestamp", `Type: ${allFeedDates[0].type}`, `Context: ${allFeedDates[0].context}`]
        };
    }

    // Check visible dates with high priority markers
    if (updateTimes.visibleDates && updateTimes.visibleDates.length > 0) {
        // Look for dates that appear to be part of lastmodified content
        const contentDates = updateTimes.visibleDates.filter((d: any) => {
            const ctx = d.context.toLowerCase();
            return ctx.includes('lastmodified') ||
                ctx.includes('last modified') ||
                ctx.includes('updated') ||
                ctx.includes('修改') ||  // Chinese for "modified"
                ctx.includes('更新');    // Chinese for "updated" 
        });

        if (contentDates.length > 0) {
            // Sort by recency
            const dates = contentDates.map((d: any) => new Date(d.date));
            dates.sort((a: Date, b: Date) => {
                if (!a || !b) return 0;
                return b.getTime() - a.getTime();
            });

            return {
                timestamp: dates[0].toISOString(),
                confidence: 92,
                reasoning: ["Content explicitly marked as modified/updated"]
            };
        }

        // Next check for dates that appear in common date display elements
        const displayDateElements = updateTimes.visibleDates.filter((d: any) => {
            const ctx = d.context.toLowerCase();
            return ctx.includes('class="date') ||
                ctx.includes('class="time') ||
                ctx.includes('class="pubdate') ||
                ctx.includes('class="published') ||
                ctx.includes('pages-date') ||
                ctx.includes('pub-date');
        });

        if (displayDateElements.length > 0) {
            const dates = displayDateElements.map((d: any) => new Date(d.date));
            dates.sort((a: Date, b: Date) => b.getTime() - a.getTime());

            return {
                timestamp: dates[0].toISOString(),
                confidence: 88,
                reasoning: ["Date from primary content display element"]
            };
        }
    }

    // Check for Schema.org timestamps
    if (updateTimes.schemaOrgTimestamps && updateTimes.schemaOrgTimestamps.length > 0) {
        // Filter for high priority fields: dateModified and dateUpdated
        const highPriorityDates = updateTimes.schemaOrgTimestamps
            .filter((stamp: any) => stamp.priority === 'high')
            .map((stamp: any) => ({ date: new Date(stamp.date), field: stamp.field, context: stamp.context }));

        if (highPriorityDates.length > 0) {
            // Sort by recency
            highPriorityDates.sort((a: any, b: any) => b.date.getTime() - a.date.getTime());

            return {
                timestamp: highPriorityDates[0].date.toISOString(),
                confidence: 85,
                reasoning: ["Schema.org structured data", `Field: ${highPriorityDates[0].field}`, `Context: ${highPriorityDates[0].context}`]
            };
        }

        // If no high priority fields, use most recent Schema.org date
        const allSchemaDates = updateTimes.schemaOrgTimestamps
            .map((stamp: any) => ({ date: new Date(stamp.date), field: stamp.field, context: stamp.context }));

        allSchemaDates.sort((a: any, b: any) => b.date.getTime() - a.date.getTime());

        return {
            timestamp: allSchemaDates[0].date.toISOString(),
            confidence: 75,
            reasoning: ["Schema.org structured data", `Field: ${allSchemaDates[0].field}`, `Context: ${allSchemaDates[0].context}`]
        };
    }

    // Check Git info (often very reliable)
    if (updateTimes.gitInfo && updateTimes.gitInfo.gitDate) {
        return {
            timestamp: updateTimes.gitInfo.gitDate,
            confidence: 90,
            reasoning: ["Git commit information", updateTimes.gitInfo.gitHash ? `Git hash: ${updateTimes.gitInfo.gitHash}` : ""]
        };
    } else if (updateTimes.gitInfo && updateTimes.gitInfo.deployDate) {
        return {
            timestamp: updateTimes.gitInfo.deployDate,
            confidence: 88,
            reasoning: ["Git deployment timestamp"]
        };
    }

    // JSON-LD structured data is also quite reliable
    if (updateTimes.jsTimestamps && updateTimes.jsTimestamps.length > 0) {
        const jsonLdDates = updateTimes.jsTimestamps
            .filter((stamp: any) => stamp.type === 'jsonLd')
            .map((stamp: any) => ({
                date: new Date(stamp.date),
                field: stamp.field,
                priority: stamp.priority
            }));

        if (jsonLdDates.length > 0) {
            // Sort by priority and recency
            jsonLdDates.sort((a: any, b: any) => {
                if (a.priority === 'high' && b.priority !== 'high') return -1;
                if (a.priority !== 'high' && b.priority === 'high') return 1;
                return b.date.getTime() - a.date.getTime();
            });

            return {
                timestamp: jsonLdDates[0].date.toISOString(),
                confidence: jsonLdDates[0].priority === 'high' ? 80 : 65,
                reasoning: [`JSON-LD structured data (${jsonLdDates[0].field})`]
            };
        }
    }

    // If we have a page generation time meta tag, it's a decent indicator
    if (updateTimes.metaTags && updateTimes.metaTags.pageGenerated) {
        return {
            timestamp: updateTimes.metaTags.pageGenerated,
            confidence: 75,
            reasoning: ["Page generation time meta tag"]
        };
    }

    // Process visible dates that don't have explicit modification indicators
    if (updateTimes.visibleDates && updateTimes.visibleDates.length > 0) {
        // Get all dates and sort by recency
        const allDates = updateTimes.visibleDates.map((d: any) => ({
            date: new Date(d.date),
            context: d.context
        }));

        allDates.sort((a: any, b: any) => b.date.getTime() - a.date.getTime());

        return {
            timestamp: allDates[0].date.toISOString(),
            confidence: 70,
            reasoning: ["Most recent date found in page content", `Context: "${allDates[0].context}"`]
        };
    }

    // Try HTML comments
    if (updateTimes.htmlComments && updateTimes.htmlComments.length > 0) {
        const commentDates = updateTimes.htmlComments.map((c: any) => ({
            date: new Date(c.date),
            context: c.context
        }));

        commentDates.sort((a: any, b: any) => b.date.getTime() - a.date.getTime());

        return {
            timestamp: commentDates[0].date.toISOString(),
            confidence: 60,
            reasoning: ["Timestamp from HTML comment", `Context: "${commentDates[0].context}"`]
        };
    }

    // Try JavaScript timestamps
    if (updateTimes.jsTimestamps && updateTimes.jsTimestamps.length > 0) {
        const jsDates = updateTimes.jsTimestamps
            .filter((stamp: any) => stamp.type !== 'jsonLd')
            .map((stamp: any) => ({
                date: new Date(stamp.date),
                context: stamp.context,
                type: stamp.type
            }));

        if (jsDates.length > 0) {
            // Sort by recency
            jsDates.sort((a: any, b: any) => b.date.getTime() - a.date.getTime());

            return {
                timestamp: jsDates[0].date.toISOString(),
                confidence: 60,
                reasoning: ["JavaScript timestamp found", `Context: "${jsDates[0].context}"`]
            };
        }
    }

    // Use HTTP Last-Modified even if it matches server time, but with lower confidence
    if (updateTimes.lastModified) {
        const lastModDate = toPlausibleDate(updateTimes.lastModified);
        if (lastModDate) {
            // Check if Last-Modified differs significantly from server time
            if (updateTimes.date) {
                const serverDate = new Date(updateTimes.date);
                const timeDiff = Math.abs(lastModDate.getTime() - serverDate.getTime());

                if (timeDiff > 60000) { // More than 1 minute difference
                    return {
                        timestamp: lastModDate.toISOString(),
                        confidence: 75,
                        reasoning: ["HTTP Last-Modified header differs significantly from server time", `Difference: ${Math.round(timeDiff / 1000 / 60)} minutes`]
                    };
                } else if (timeDiff > 1000) { // More than 1 second difference
                    return {
                        timestamp: lastModDate.toISOString(),
                        confidence: 65,
                        reasoning: ["HTTP Last-Modified header differs from server time", `Difference: ${Math.round(timeDiff / 1000)} seconds`]
                    };
                } else {
                    return {
                        timestamp: lastModDate.toISOString(),
                        confidence: 40,
                        reasoning: ["HTTP Last-Modified header (may be server time)"]
                    };
                }
            } else {
                return {
                    timestamp: lastModDate.toISOString(),
                    confidence: 60,
                    reasoning: ["HTTP Last-Modified header"]
                };
            }
        }
    }

    // If all else fails, use the server date with very low confidence
    if (updateTimes.date) {
        return {
            timestamp: new Date(updateTimes.date).toISOString(),
            confidence: 10,
            reasoning: ["No update time found", "Using server date as fallback"]
        };
    }

    // Absolute fallback: unknown
    return {
        timestamp: null,
        confidence: 0,
        reasoning: ["No reliable update time indicators found"]
    };
}

// Main function to guess datetime from a URL
export async function guessDatetimeFromUrl(url: string): Promise<{
    bestGuess: string | null;
    confidence: number;
}> {
    try {
        // Fetch the target webpage
        const response = await fetch(url, {
            signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const text = await readCapped(response, MAX_PAGE_BYTES);

        // Extract all possible time indicators
        const updateTimes = await extractAllTimeIndicators(response, text, url);

        // Advanced heuristic-based determination of the "true" update time
        const bestGuess = determineBestUpdateTime(updateTimes);

        // Result with confidence score
        const result = {
            bestGuess: bestGuess.timestamp,
            confidence: bestGuess.confidence
        };

        return result;
    } catch (error) {
        throw new Error(`Failed to guess datetime from URL: ${error instanceof Error ? error.message : String(error)}`);
    }
}