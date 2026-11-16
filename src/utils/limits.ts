/**
 * Every time limit this server puts on a call it makes, in one place.
 *
 * They used to be private constants in four files, which hid that some of them
 * only make sense together: a limit here has to be longer than the budget of
 * the service being called, and shorter than whatever is waiting on us. Two of
 * them were not, and it showed only as an outage made worse (see
 * PASSAGE_BUDGET_MS). The `/` info page prints these, so what callers are told
 * cannot drift from what the code does.
 */

/** One search query against svip.jina.ai. svip answers a search within ~7s or fails. */
export const SEARCH_REQUEST_TIMEOUT_MS = 30000;

/** One full-page read through r.jina.ai. */
export const READ_REQUEST_TIMEOUT_MS = 30000;

/**
 * A question-grounded read: what svip may spend on it (fetch, chunk, rerank),
 * sent to svip as `deep_timeout`, and how long we wait for its answer.
 *
 * The second has to be the larger. svip's own default budget is 30s and we
 * used to abort at 30s as well, so everything svip does when its budget runs
 * out - answering from what it has - was sent to a connection we were closing
 * at that instant, and svip still charged for it. Now svip gives up first and
 * its answer has 5s to get here.
 *
 * It also has to leave room for the fallback: a question read that svip cannot
 * serve is followed by a full read with its own READ_REQUEST_TIMEOUT_MS, and
 * both have to fit inside QUESTION_READ_TIMEOUT_MS. 25s + 30s does; 30s + 30s
 * did not, so the fallback could be cut off just as it finished.
 */
export const PASSAGE_BUDGET_MS = 20000;
export const PASSAGE_REQUEST_TIMEOUT_MS = PASSAGE_BUDGET_MS + 5000;

/** Per URL, when read_url is given an array: a plain read, and a read with a `question`. */
export const PLAIN_READ_TIMEOUT_MS = 30000;
export const QUESTION_READ_TIMEOUT_MS = 60000;

/** Per query, when a search tool is given an array. */
export const PARALLEL_SEARCH_TIMEOUT_MS = 30000;

export const SCREENSHOT_TIMEOUT_MS = 60000;
export const SCREENSHOT_DOWNLOAD_TIMEOUT_MS = 20000;

// These calls had no deadline, so a hung upstream held the invocation open.
// Measured: rerank over 1024 documents 1.5s, 1000 embeddings ~1s, extract_pdf
// 12-16s on three arXiv papers.
export const RERANK_TIMEOUT_MS = 30000;
export const EMBEDDINGS_TIMEOUT_MS = 30000;
/** svip gives one extraction 50s, and the platform in front of it cuts the request at 60s. */
export const EXTRACT_PDF_TIMEOUT_MS = 90000;

/** Arrays accepted by the search tools and read_url. */
export const MAX_BATCH_SIZE = 5;

const seconds = (ms: number) => `${ms / 1000}s`;

/** The limits as callers experience them, for the `/` info page. */
export function describeLimits(): Record<string, string> {
	return {
		search: `${seconds(SEARCH_REQUEST_TIMEOUT_MS)} per query, up to ${MAX_BATCH_SIZE} queries per call`,
		read_url: `${seconds(READ_REQUEST_TIMEOUT_MS)} per page, up to ${MAX_BATCH_SIZE} pages per call`,
		read_url_with_question: `${seconds(PASSAGE_REQUEST_TIMEOUT_MS)} for the passages, then ${seconds(READ_REQUEST_TIMEOUT_MS)} for the full page if none came back`,
		capture_screenshot_url: seconds(SCREENSHOT_TIMEOUT_MS),
		sort_by_relevance: seconds(RERANK_TIMEOUT_MS),
		deduplicate_strings: seconds(EMBEDDINGS_TIMEOUT_MS),
		extract_pdf: seconds(EXTRACT_PDF_TIMEOUT_MS),
	};
}
