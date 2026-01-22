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

// Generate a citation key from title and year
function generateKey(title: string, year?: number): string {
	const words = title.toLowerCase().split(/\s+/);
	const firstWord = words[0]?.replace(/[^a-z]/g, '') || 'unknown';
	return `${firstWord}${year || ''}`;
}

// Format authors for BibTeX (Last, First and Last, First format)
function formatAuthorsForBibtex(authors: string[]): string {
	return authors.join(' and ');
}

// Escape special characters for BibTeX
function escapeBibtex(str: string): string {
	return str
		.replace(/&/g, '\\&')
		.replace(/%/g, '\\%')
		.replace(/_/g, '\\_')
		.replace(/\$/g, '\\$')
		.replace(/#/g, '\\#');
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
	const key = entry.key || generateKey(entry.title || 'unknown', entry.year);

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
		h: String(Math.min(num * 2, 100)), // Over-fetch for filtering
	});

	try {
		const response = await fetch(`https://dblp.org/search/publ/api?${params}`, {
			headers: { 'Accept': 'application/json' },
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			return [];
		}

		const data = await response.json() as any;
		const hits = data?.result?.hits?.hit || [];

		const results: BibtexEntry[] = [];

		for (const hit of hits) {
			const info = hit.info;
			if (!info) continue;

			// Apply year filter
			const pubYear = info.year ? parseInt(info.year) : undefined;
			if (year && pubYear && pubYear < year) continue;

			// Parse authors
			let authors: string[] = [];
			if (info.authors?.author) {
				const authorList = Array.isArray(info.authors.author)
					? info.authors.author
					: [info.authors.author];
				authors = authorList.map((a: any) => typeof a === 'string' ? a : a.text || a._);
			}

			// Determine entry type
			let type: BibtexEntry['type'] = 'misc';
			if (info.type === 'Conference and Workshop Papers') {
				type = 'inproceedings';
			} else if (info.type === 'Journal Articles') {
				type = 'article';
			} else if (info.type === 'Books and Theses') {
				type = 'book';
			}

			const entry: Partial<BibtexEntry> = {
				type,
				title: info.title?.replace(/\.$/, '') || '', // Remove trailing period
				authors,
				year: pubYear,
				venue: info.venue,
				volume: info.volume,
				number: info.number,
				pages: info.pages,
				doi: info.doi,
				url: info.ee || info.url,
				source: 'dblp',
			};

			entry.key = generateKey(entry.title!, entry.year);
			entry.bibtex = generateBibtexString(entry);

			results.push(entry as BibtexEntry);

			if (results.length >= num) break;
		}

		return results;
	} catch (error) {
		// Timeout or network error
		return [];
	}
}

// Search Semantic Scholar API
export async function searchSemanticScholar(args: BibtexSearchArgs): Promise<BibtexEntry[]> {
	const { query, num = 10, year } = args;

	const params = new URLSearchParams({
		query,
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
			return [];
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

			entry.key = generateKey(entry.title!, entry.year);
			entry.bibtex = generateBibtexString(entry);

			results.push(entry as BibtexEntry);

			if (results.length >= num) break;
		}

		return results;
	} catch (error) {
		// Timeout or network error
		return [];
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

// Deduplicate results from multiple sources
export function deduplicateResults(results: BibtexEntry[]): BibtexEntry[] {
	const seen = new Map<string, BibtexEntry>();
	const seenDois = new Map<string, string>(); // doi -> key
	const seenArxiv = new Map<string, string>(); // arxiv_id -> key

	for (const entry of results) {
		// Check DOI match
		if (entry.doi) {
			const normalizedDoi = normalizeDoi(entry.doi);
			if (seenDois.has(normalizedDoi)) {
				// Merge with existing entry (prefer one with more data)
				const existingKey = seenDois.get(normalizedDoi)!;
				const existing = seen.get(existingKey)!;
				mergeEntries(existing, entry);
				continue;
			}
			seenDois.set(normalizedDoi, entry.key);
		}

		// Check arXiv ID match
		if (entry.arxiv_id) {
			const normalizedArxiv = entry.arxiv_id.replace(/v\d+$/, ''); // Remove version
			if (seenArxiv.has(normalizedArxiv)) {
				const existingKey = seenArxiv.get(normalizedArxiv)!;
				const existing = seen.get(existingKey)!;
				mergeEntries(existing, entry);
				continue;
			}
			seenArxiv.set(normalizedArxiv, entry.key);
		}

		// Check title similarity (for entries without DOI/arXiv)
		let isDuplicate = false;
		for (const [key, existing] of seen) {
			if (similarity(entry.title, existing.title) > 0.85 &&
				entry.year === existing.year) {
				mergeEntries(existing, entry);
				isDuplicate = true;
				break;
			}
		}

		if (!isDuplicate) {
			seen.set(entry.key, entry);
		}
	}

	// Sort by year (descending) then title
	return Array.from(seen.values()).sort((a, b) => {
		if (a.year && b.year) {
			if (a.year !== b.year) return b.year - a.year;
		}
		return a.title.localeCompare(b.title);
	});
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
export async function searchBibtex(args: BibtexSearchArgs): Promise<BibtexEntry[]> {
	const { num = 10 } = args;

	// Search both providers in parallel
	const [dblpResults, s2Results] = await Promise.all([
		searchDblp(args),
		searchSemanticScholar(args),
	]);

	// Combine and deduplicate
	const combined = [...dblpResults, ...s2Results];
	const deduplicated = deduplicateResults(combined);

	// Return requested number
	return deduplicated.slice(0, num);
}
