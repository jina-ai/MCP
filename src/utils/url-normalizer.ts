// URL normalization function based on Jina DeepResearch
export function normalizeUrl(urlString: string, options = {
	removeAnchors: true,
	removeSessionIDs: true,
	removeUTMParams: true,
	removeTrackingParams: true,
	removeXAnalytics: true
}) {
	try {
		// Only strip leading/trailing whitespace and the C0 control characters the
		// WHATWG URL parser ignores. Collapsing *all* whitespace deleted spaces
		// inside the path and query too, so
		// "https://en.wikipedia.org/wiki/New York City" was fetched as
		// ".../NewYorkCity" and the caller was told the original URL had 404'd.
		// new URL() percent-encodes interior spaces correctly on its own.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 controls are exactly what must be removed
		urlString = urlString.trim().replace(/[\u0000-\u001F\u007F]/g, '');

		if (!urlString) {
			throw new Error('Empty URL');
		}

		// Handle x.com and twitter.com URLs with /analytics
		if (options.removeXAnalytics) {
			const xComPattern = /^(https?:\/\/(www\.)?(x\.com|twitter\.com)\/([^/]+)\/status\/(\d+))\/analytics(\/)?(\?.*)?(#.*)?$/i;
			const xMatch = urlString.match(xComPattern);
			if (xMatch) {
				let cleanUrl = xMatch[1];
				if (xMatch[7]) cleanUrl += xMatch[7];
				if (xMatch[8]) cleanUrl += xMatch[8];
				urlString = cleanUrl;
			}
		}

		const url = new URL(urlString);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('Unsupported protocol');
		}

		url.hostname = url.hostname.toLowerCase();
		if (url.hostname.startsWith('www.')) {
			url.hostname = url.hostname.slice(4);
		}

		if ((url.protocol === 'http:' && url.port === '80') ||
			(url.protocol === 'https:' && url.port === '443')) {
			url.port = '';
		}

		// Query parameter filtering
		const searchParams = new URLSearchParams(url.search);
		const filteredParams = Array.from(searchParams.entries())
			.filter(([key]) => {
				if (key === '') return false;
				// note: `s` is deliberately absent - it is a search parameter on WordPress
				// and many other sites, not a session ID
				if (options.removeSessionIDs && /^(session|sid|sessionid|phpsessid|jsessionid|aspsessionid|asp\.net_sessionid)$/i.test(key)) {
					return false;
				}
				if (options.removeUTMParams && /^utm_/i.test(key)) {
					return false;
				}
				if (options.removeTrackingParams && /^(ref|referrer|fbclid|gclid|cid|mcid|source|medium|campaign|term|content|sc_rid|mc_[a-z]+)$/i.test(key)) {
					return false;
				}
				return true;
			})
			.sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

		url.search = new URLSearchParams(filteredParams).toString();

		if (options.removeAnchors) {
			url.hash = '';
		}

		return url.toString();
	} catch (error) {
		return undefined;
	}
}
