// BibTeX search utility - searches DBLP and Semantic Scholar for academic references

export interface BibtexEntry {
	key: string;
	type: 'article' | 'inproceedings' | 'misc' | 'book' | 'phdthesis';
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	volume?: string;
	number?: string;
	pages?: string;
	doi?: string;
	arxiv_id?: string;
	url?: string;
	abstract?: string;
	citations?: number;
	bibtex: string;
	source: 'dblp' | 'semanticscholar';
}

export interface BibtexSearchArgs {
	query: string;
	num?: number;
	year?: number;
	author?: string;
}

// DBLP returns scalars for most fields but switches to an array whenever a record
// has several values (venue is commonly ["BIRDS+WEPIR@CHIIR", "CEUR Workshop
// Proceedings"]). Those arrays used to flow straight into escapeBibtex, where
// `.replace` is not a function - throwing out of the per-hit loop and discarding
// the *entire* DBLP result set for the query.
function asText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.length > 0 ? asText(value[0]) : '';
	return String(value);
}

function asOptionalText(value: unknown): string | undefined {
	const text = asText(value);
	return text === '' ? undefined : text;
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** DBLP serves HTML-escaped text; the entities must not reach the .bib output */
function decodeHtmlEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
		if (entity.startsWith('#')) {
			const code = entity[1] === 'x' || entity[1] === 'X'
				? Number.parseInt(entity.slice(2), 16)
				: Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return NAMED_HTML_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

// Generate a citation key from the first author's surname, year and first title
// word. Keying on the title's first word alone collided constantly - every
// "A Survey of ..." paper from the same year produced the same key.
function generateKey(title: string, year?: number, authors: string[] = []): string {
	const titleWord = title.toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, '') || 'unknown';
	const surname = authors[0]?.trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, '') || '';
	return surname ? `${surname}${year || ''}${titleWord}` : `${titleWord}${year || ''}`;
}

// Escape special characters for BibTeX
const BIBTEX_ESCAPES: Record<string, string> = {
	'\\': '\\textbackslash{}',
	'{': '\\{',
	'}': '\\}',
	'&': '\\&',
	'%': '\\%',
	'_': '\\_',
	'$': '\\$',
	'#': '\\#',
	'~': '\\textasciitilde{}',
	'^': '\\textasciicircum{}',
};

/**
 * Escape in a single pass. The previous chained .replace() calls left `\`, `{`,
 * `}`, `~` and `^` untouched, so an unbalanced brace from a source title swallowed
 * the rest of the .bib file, and escaping `$` while leaving `\` alone turned real
 * LaTeX titles such as "Fast $O(n\log n)$" into undefined control sequences.
 */
function escapeBibtex(value: unknown): string {
	return asText(value).replace(/[\\{}&%_$#~^]/g, (ch) => BIBTEX_ESCAPES[ch] ?? ch);
}

// Format authors for BibTeX (Last, First and Last, First format)
function formatAuthorsForBibtex(authors: string[]): string {
	// The author field used to be emitted raw, so "AT&T Labs Research" produced a
	// misplaced alignment tab
	return authors.map((author) => escapeBibtex(author)).join(' and ');
}

// Generate BibTeX string from entry data
function generateBibtexString(entry: Partial<BibtexEntry>): string {
	const fields: string[] = [];

	if (entry.title) fields.push(`  title = {${escapeBibtex(entry.title)}}`);
	if (entry.authors && entry.authors.length > 0) {
		fields.push(`  author = {${formatAuthorsForBibtex(entry.authors)}}`);
	}
	if (entry.year) fields.push(`  year = {${entry.year}}`);
	if (entry.venue) {
		const venueField = entry.type === 'inproceedings' ? 'booktitle' : 'journal';
		fields.push(`  ${venueField} = {${escapeBibtex(entry.venue)}}`);
	}
	if (entry.volume) fields.push(`  volume = {${entry.volume}}`);
	if (entry.number) fields.push(`  number = {${entry.number}}`);
	if (entry.pages) fields.push(`  pages = {${entry.pages}}`);
	if (entry.doi) fields.push(`  doi = {${entry.doi}}`);
	if (entry.url) fields.push(`  url = {${entry.url}}`);
	if (entry.arxiv_id) {
		fields.push(`  eprint = {${entry.arxiv_id}}`);
		fields.push(`  archivePrefix = {arXiv}`);
	}

	const type = entry.type || 'misc';
	const key = entry.key || generateKey(entry.title || 'unknown', entry.year, entry.authors);

	return `@${type}{${key},\n${fields.join(',\n')}\n}`;
}

// Search DBLP API
export async function searchDblp(args: BibtexSearchArgs): Promise<BibtexEntry[]> {
	const { query, num = 10, year, author } = args;

	// Build query string
	let searchQuery = query;
	if (author) {
		searchQuery = `${searchQuery} ${author}`;
	}

	const params = new URLSearchParams({
		q: searchQuery,
		format: 'json',
		// The year filter is applied client-side below, so a num*2 window silently
		// under-filled `num` whenever most hits predated `year`
		h: String(year ? 100 : Math.min(num * 2, 100)), // Over-fetch for filtering
	});

	try {
		const response = await fetch(`https://dblp.org/search/publ/api?${params}`, {
			headers: { 'Accept': 'application/json' },
			signal: AbortSignal.timeout(5000),
		});

		// Returning [] here made a 429/5xx indistinguishable from "no matches" -
		// the exact confusion the surface-lookup-failures change set out to remove,
		// which only ever covered the `catch` path.
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as any;
		const hits = data?.result?.hits?.hit || [];

		const results: BibtexEntry[] = [];

		for (const hit of hits) {
			const info = hit.info;
			if (!info) continue;

			// Apply year filter
			const pubYear = info.year ? parseInt(asText(info.year)) : undefined;
			if (year && pubYear && pubYear < year) continue;

			// Parse authors
			let authors: string[] = [];
			if (info.authors?.author) {
				const authorList = Array.isArray(info.authors.author)
					? info.authors.author
					: [info.authors.author];
				authors = authorList
					.map((a: any) => decodeHtmlEntities(asText(typeof a === 'string' ? a : a?.text ?? a?._)))
					.filter((name: string) => name.length > 0);
			}

			// Determine entry type
			let type: BibtexEntry['type'] = 'misc';
			if (asText(info.type) === 'Conference and Workshop Papers') {
				type = 'inproceedings';
			} else if (asText(info.type) === 'Journal Articles') {
				type = 'article';
			} else if (asText(info.type) === 'Books and Theses') {
				type = 'book';
			}

			// Every field is coerced through asText: DBLP returns arrays for records
			// with multiple venues/volumes, which used to throw inside escapeBibtex
			const entry: Partial<BibtexEntry> = {
				type,
				title: decodeHtmlEntities(asText(info.title).replace(/\.$/, '')), // Remove trailing period
				authors,
				year: pubYear,
				venue: asOptionalText(info.venue) && decodeHtmlEntities(asText(info.venue)),
				volume: asOptionalText(info.volume),
				number: asOptionalText(info.number),
				pages: asOptionalText(info.pages),
				doi: asOptionalText(info.doi),
				url: asOptionalText(info.ee) ?? asOptionalText(info.url),
				source: 'dblp',
			};

			entry.key = generateKey(entry.title!, entry.year, entry.authors);
			entry.bibtex = generateBibtexString(entry);

			results.push(entry as BibtexEntry);

			if (results.length >= num) break;
		}

		return results;
	} catch (error) {
		// Surface the failure instead of swallowing to [] (so a network/API error is not mistaken
		// for "no matches"); searchBibtex decides whether it is fatal.
		throw new Error(`DBLP: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Search Semantic Scholar API
export async function searchSemanticScholar(args: BibtexSearchArgs): Promise<BibtexEntry[]> {
	const { query, num = 10, year, author } = args;

	const params = new URLSearchParams({
		// `author` was destructured out of existence here, so DBLP filtered by
		// author and Semantic Scholar did not - half the merged result set ignored
		// a filter the tool schema advertises
		query: author ? `${query} ${author}` : query,
		limit: String(Math.min(num * 2, 100)), // Over-fetch for filtering
		fields: 'title,authors,year,venue,externalIds,abstract,citationCount,url',
	});

	if (year) {
		params.set('year', `${year}-`); // >= year
	}

	try {
		const response = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
			headers: { 'Accept': 'application/json' },
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			// Unauthenticated Semantic Scholar routinely answers 429; returning []
			// silently degraded search_bibtex to DBLP-only with no signal
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as any;
		const papers = data?.data || [];

		const results: BibtexEntry[] = [];

		for (const paper of papers) {
			if (!paper.title) continue;

			// Parse authors
			const authors = (paper.authors || []).map((a: any) => a.name).filter(Boolean);

			// Extract external IDs
			const externalIds = paper.externalIds || {};
			const doi = externalIds.DOI;
			const arxivId = externalIds.ArXiv;

			// Determine entry type (default to article for S2)
			const type: BibtexEntry['type'] = paper.venue?.toLowerCase().includes('conference')
				? 'inproceedings'
				: 'article';

			const entry: Partial<BibtexEntry> = {
				type,
				title: paper.title,
				authors,
				year: paper.year,
				venue: paper.venue,
				doi,
				arxiv_id: arxivId,
				url: paper.url,
				abstract: paper.abstract,
				citations: paper.citationCount,
				source: 'semanticscholar',
			};

			entry.key = generateKey(entry.title!, entry.year, entry.authors);
			entry.bibtex = generateBibtexString(entry);

			results.push(entry as BibtexEntry);

			if (results.length >= num) break;
		}

		return results;
	} catch (error) {
		throw new Error(`Semantic Scholar: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Normalize DOI for comparison
function normalizeDoi(doi: string): string {
	return doi.toLowerCase()
		.replace(/^https?:\/\/doi\.org\//i, '')
		.replace(/^doi:/i, '')
		.trim();
}

// Simple string similarity (Jaccard on words)
function similarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
	const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));

	if (wordsA.size === 0 || wordsB.size === 0) return 0;

	let intersection = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) intersection++;
	}

	return intersection / Math.max(wordsA.size, wordsB.size);
}

/**
 * Deduplicate results from multiple sources.
 *
 * Survivors are held in a plain array keyed by object identity rather than in a
 * Map keyed by `entry.key`. The old Map silently dropped distinct papers whenever
 * two of them produced the same citation key, and it recorded DOIs/arXiv ids for
 * entries that were subsequently merged away - leaving `seenDois` pointing at a
 * key absent from the map, so the next matching DOI dereferenced `undefined` and
 * threw out of the tool.
 *
 * Input order (each provider's own relevance ranking) is preserved; ordering for
 * display is applied by the caller after the result set has been trimmed.
 */
export function deduplicateResults(results: BibtexEntry[]): BibtexEntry[] {
	const kept: BibtexEntry[] = [];
	const byDoi = new Map<string, BibtexEntry>();
	const byArxiv = new Map<string, BibtexEntry>();

	for (const entry of results) {
		const normalizedDoi = entry.doi ? normalizeDoi(entry.doi) : undefined;
		const normalizedArxiv = entry.arxiv_id ? entry.arxiv_id.replace(/v\d+$/, '') : undefined; // Remove version

		const existing =
			(normalizedDoi ? byDoi.get(normalizedDoi) : undefined) ??
			(normalizedArxiv ? byArxiv.get(normalizedArxiv) : undefined) ??
			// Title similarity, for entries without DOI/arXiv
			kept.find((candidate) => candidate.year === entry.year && similarity(entry.title, candidate.title) > 0.85);

		if (existing) {
			mergeEntries(existing, entry);
			// Index the survivor under this entry's identifiers too, so a third
			// record carrying either id still resolves to a live entry
			if (normalizedDoi && !byDoi.has(normalizedDoi)) byDoi.set(normalizedDoi, existing);
			if (normalizedArxiv && !byArxiv.has(normalizedArxiv)) byArxiv.set(normalizedArxiv, existing);
			continue;
		}

		kept.push(entry);
		if (normalizedDoi) byDoi.set(normalizedDoi, entry);
		if (normalizedArxiv) byArxiv.set(normalizedArxiv, entry);
	}

	return kept;
}

/**
 * Interleave the providers so the top `num` draws from both.
 *
 * `[...dblp, ...s2]` followed by a year-descending sort and slice() meant the
 * returned set was "the newest of everything both APIs happened to return",
 * discarding the relevance ranking the caller actually searched by.
 */
function interleaveBySource(lists: BibtexEntry[][]): BibtexEntry[] {
	const merged: BibtexEntry[] = [];
	const longest = Math.max(0, ...lists.map((list) => list.length));
	for (let i = 0; i < longest; i++) {
		for (const list of lists) {
			if (i < list.length) merged.push(list[i]);
		}
	}
	return merged;
}

/** Make citation keys unique within the returned set (smith2020attention, ...b, ...c) */
function assignUniqueKeys(entries: BibtexEntry[]): void {
	const used = new Set<string>();
	for (const entry of entries) {
		const base = entry.key;
		let key = base;
		let suffix = 0;
		while (used.has(key)) {
			key = `${base}${String.fromCharCode(97 + (suffix % 26))}`;
			suffix++;
		}
		used.add(key);
		if (key !== entry.key) {
			entry.key = key;
			entry.bibtex = generateBibtexString(entry);
		}
	}
}

// Merge two entries, keeping the most complete data
function mergeEntries(target: BibtexEntry, source: BibtexEntry): void {
	// Keep longer abstract
	if (source.abstract && (!target.abstract || source.abstract.length > target.abstract.length)) {
		target.abstract = source.abstract;
	}

	// Keep higher citation count
	if (source.citations && (!target.citations || source.citations > target.citations)) {
		target.citations = source.citations;
	}

	// Fill in missing fields
	if (!target.doi && source.doi) target.doi = source.doi;
	if (!target.arxiv_id && source.arxiv_id) target.arxiv_id = source.arxiv_id;
	if (!target.url && source.url) target.url = source.url;
	if (!target.volume && source.volume) target.volume = source.volume;
	if (!target.pages && source.pages) target.pages = source.pages;

	// Regenerate bibtex with updated fields
	target.bibtex = generateBibtexString(target);
}

// Main search function - searches both providers and deduplicates
export async function searchBibtex(args: BibtexSearchArgs, warningsOut?: string[]): Promise<BibtexEntry[]> {
	const { num = 10 } = args;

	// Search both providers in parallel. allSettled (not all) so one provider failing does not
	// discard the other's results.
	const settled = await Promise.allSettled([
		searchDblp(args),
		searchSemanticScholar(args),
	]);

	const perSource: BibtexEntry[][] = [];
	const errors: string[] = [];
	for (const r of settled) {
		if (r.status === "fulfilled") perSource.push(r.value);
		else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
	}

	const deduplicated = deduplicateResults(interleaveBySource(perSource));
	// Trim by relevance first, then order the survivors newest-first for display
	const results = deduplicated.slice(0, num).sort((a, b) => {
		if (a.year && b.year && a.year !== b.year) return b.year - a.year;
		return a.title.localeCompare(b.title);
	});

	assignUniqueKeys(results);

	// A lookup that errored must not masquerade as "no matches": if every source we tried failed
	// and we got nothing, surface the failure instead of returning an empty list.
	if (results.length === 0 && errors.length > 0) {
		throw new Error(`bibtex lookup failed (${errors.join("; ")})`);
	}

	// A *partial* failure was previously invisible too: one provider down just
	// halved the coverage with no signal to the caller.
	if (warningsOut) {
		for (const error of errors) warningsOut.push(`source unavailable: ${error}`);
	}

	return results;
}

/** Providers that failed, for callers that want to warn about partial coverage */
export async function searchBibtexWithWarnings(
	args: BibtexSearchArgs
): Promise<{ results: BibtexEntry[]; warnings: string[] }> {
	const warnings: string[] = [];
	const results = await searchBibtex(args, warnings);
	return { results, warnings };
}
