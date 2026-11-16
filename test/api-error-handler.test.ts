import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeApiError, handleApiError } from '../src/utils/api-error-handler.js';
import { respond } from './helpers.js';

/**
 * What a model is told when an API call fails. The message is the only thing it
 * has to decide between retrying, waiting, and asking the user to fix their key.
 */
const SVIP = 'https://svip.jina.ai/';
const API = 'https://api.jina.ai/v1/rerank';

test('a svip 429 is capacity, not a limit on the key', async () => {
    const message = await describeApiError(respond(SVIP, 429, 'Rate exceeded.', { statusText: 'Too Many Requests' }));

    assert.match(message, /temporarily at capacity/);
    assert.match(message, /not a limit on your API key/);
    assert.match(message, /Retry in a few seconds\.$/);
    assert.doesNotMatch(message, /upgrade your API key/);
    // A platform's plain-text notice is not quoted as the API's reason.
    assert.doesNotMatch(message, /Rate exceeded/);
});

test('a 429 from api.jina.ai is a rate limit on the key, with the reason it gave', async () => {
    const message = await describeApiError(respond(API, 429, { detail: 'Rate limit of 500 RPM reached' }));

    assert.match(message, /^Rate limit exceeded\./);
    assert.match(message, /Reason given: Rate limit of 500 RPM reached$/);
});

test('the wait a service asks for is passed on', async () => {
    const seconds = await describeApiError(respond(API, 429, { detail: 'slow down' }, { headers: { 'retry-after': '12' } }));
    assert.match(seconds, /Retry after 12s\. Reason given: slow down$/);

    const capacity = await describeApiError(respond(SVIP, 429, '', { headers: { 'retry-after': '3' } }));
    assert.match(capacity, /will not help\. Retry after 3s\.$/);

    const busy = await describeApiError(respond('https://svip.jina.ai/extract-pdf', 503,
        { error: 'PDF extraction is at capacity, retry shortly' },
        { statusText: 'Service Unavailable', headers: { 'retry-after': '10' } }));
    assert.equal(busy, '503 Service Unavailable - PDF extraction is at capacity, retry shortly. Retry after 10s.');
});

test('a wait is only mentioned where waiting helps', async () => {
    // A rejected key does not start working because time has passed.
    const rejected = await describeApiError(respond(SVIP, 401, { error: 'Invalid API key.' }, { headers: { 'retry-after': '300' } }));
    assert.doesNotMatch(rejected, /Retry after/);

    const nonsense = await describeApiError(respond(API, 429, {}, { headers: { 'retry-after': 'soon' } }));
    assert.doesNotMatch(nonsense, /Retry after/);
});

test('a rejected key is told why, not only to set one', async () => {
    const unknown = await describeApiError(respond(SVIP, 401, { error: 'Invalid API key.' }));
    assert.match(unknown, /^Authentication failed\./);
    assert.match(unknown, /Reason given: Invalid API key\.$/);

    const billing = await describeApiError(respond(SVIP, 403,
        { error: 'Jina billing rejected this API key: Insufficient balance. Please check the key and its balance at https://jina.ai' },
        { statusText: 'Forbidden' }));
    assert.match(billing, /^403 Forbidden - Jina billing rejected this API key: Insufficient balance/);
});

test('a proxy error page is not quoted as the reason for an account error', async () => {
    const message = await describeApiError(respond(SVIP, 401, '<html><body>error</body></html>'));

    assert.doesNotMatch(message, /html/);
    assert.match(message, /^Authentication failed\./);
});

test('other statuses keep the status line and whatever the body said', async () => {
    const message = await describeApiError(respond(API, 422, { detail: 'input exceeds the maximum length' }, { statusText: 'Unprocessable Entity' }));

    assert.equal(message, '422 Unprocessable Entity - input exceeds the maximum length');
});

test('a tool result marks the failure and names the request only when the request is the problem', async () => {
    const capacity = await handleApiError(respond('https://svip.jina.ai/extract-pdf', 429, 'Rate exceeded.'), 'PDF extraction');
    assert.equal(capacity.isError, true);
    assert.match(capacity.content[0].text, /^The search service is temporarily at capacity/);

    const failed = await handleApiError(respond('https://svip.jina.ai/extract-pdf', 504,
        { error: 'Failed to download PDF: 2301.12345 (not finished after 50000ms)' }, { statusText: 'Gateway Timeout' }), 'PDF extraction');
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text,
        'Error: PDF extraction failed - 504 Gateway Timeout - Failed to download PDF: 2301.12345 (not finished after 50000ms)');
});
