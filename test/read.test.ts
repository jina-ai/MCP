import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readUrlFromConfig } from '../src/utils/read.js';
import { respond, stubFetch } from './helpers.js';

/**
 * read_url with a `question`: when svip's answer is used, and when the full
 * page is read instead.
 *
 * This is the contract between this server and svip.jina.ai. svip returns the
 * same shape for a passage it ranked and for the top of the page it falls back
 * to when ranking fails; the only difference is `rerank_score`.
 */
const PAGE = 'https://example.com/';
const FULL = { data: { url: PAGE, title: 'Example', content: 'FULL PAGE BODY' } };

let stub: ReturnType<typeof stubFetch>;
afterEach(() => stub.restore());

const withSvip = (answer: () => Response) => {
    stub = stubFetch((call) => (call.host === 'svip.jina.ai' ? answer() : respond(call.url, 200, FULL)));
    return stub.calls;
};

/** A read with a question and a key, unless told otherwise. `key: null` is a caller without one. */
const read = (config: object = {}, key: string | null = 'key') =>
    readUrlFromConfig({ url: PAGE, question: 'what is it?', ...config }, key ?? undefined) as Promise<any>;

test('a ranked passage is returned and the page is not read a second time', async () => {
    const calls = withSvip(() => respond('https://svip.jina.ai/', 200, {
        results: [{ url: PAGE, title: 'Example', snippet: 'THE ANSWER', rerank_score: 0.61, snippet_source: 'content' }],
    }));

    const result = await read();

    assert.deepEqual(calls.map((c) => c.host), ['svip.jina.ai']);
    assert.equal(result.structuredData.snippet_source, 'content');
    assert.deepEqual(result.structuredData.snippets, ['THE ANSWER']);
    assert.equal(result.structuredData.content, undefined);
});

test('an unranked passage is not passed on as the answer', async () => {
    // What svip sends when its rerank call failed: the top of the page, in the
    // same shape, without a score.
    const calls = withSvip(() => respond('https://svip.jina.ai/', 200, {
        results: [{ url: PAGE, title: 'Example', snippet: 'Skip to content | Home | Docs', snippet_source: 'content' }],
    }));

    const result = await read();

    assert.deepEqual(calls.map((c) => c.host), ['svip.jina.ai', 'r.jina.ai']);
    assert.equal(result.structuredData.snippet_source, 'full_content');
    assert.equal(result.structuredData.content, 'FULL PAGE BODY');
    assert.equal(result.structuredData.snippets, undefined);
    assert.match(result.structuredData.note, /unavailable for this page/);
});

/** svip's answer when its rerank call failed: the top of the page, no score, and since 2026-11-16 the reason. */
const unranked = (reason?: string) => () => respond('https://svip.jina.ai/', 200, {
    results: [{ url: PAGE, title: 'Example', snippet: 'Skip to content | Home | Docs', snippet_source: 'content' }],
    meta: reason ? { unranked_reason: reason } : {},
});

test('says so when the reranker rate limit of the key is why there are no passages', async () => {
    // The commonest cause by far, and the one the caller can do something
    // about: the limit is on their own key and parallel question reads share it.
    withSvip(unranked('rate_limited'));

    const result = await read();

    assert.equal(result.structuredData.snippet_source, 'full_content');
    assert.equal(result.structuredData.content, 'FULL PAGE BODY');
    assert.match(result.structuredData.note, /rate limit/);
    assert.match(result.structuredData.note, /fewer/);
});

test('says so when ranking ran out of time', async () => {
    withSvip(unranked('timeout'));

    const result = await read();

    assert.equal(result.structuredData.content, 'FULL PAGE BODY');
    assert.match(result.structuredData.note, /time limit/);
});

for (const reason of ['unavailable', 'a_reason_added_later', undefined]) {
    test(`keeps the general note when the reason is ${reason ?? 'not given'}`, async () => {
        withSvip(unranked(reason));

        const result = await read();

        assert.match(result.structuredData.note, /unavailable for this page/);
    });
}

test('the reason survives when the page is read alongside for its links', async () => {
    // With links or images wanted, the passage call and the full read run
    // together instead of one after the other; the note must not depend on which.
    withSvip(unranked('rate_limited'));

    const result = await read({ withAllLinks: true });

    assert.equal(result.structuredData.snippet_source, 'full_content');
    assert.match(result.structuredData.note, /rate limit/);
});

test('a negative score is still a score', async () => {
    // jina-reranker-v3.5 scores weak matches below zero.
    withSvip(() => respond('https://svip.jina.ai/', 200, {
        results: [{ url: PAGE, snippet: 'A WEAK MATCH', rerank_score: -0.12 }],
    }));

    const result = await read();

    assert.deepEqual(result.structuredData.snippets, ['A WEAK MATCH']);
});

for (const [name, answer] of [
    ['svip read nothing', () => respond('https://svip.jina.ai/', 200, { results: [] })],
    ['svip failed', () => respond('https://svip.jina.ai/', 500, { error: 'boom' })],
    ['svip is at capacity', () => respond('https://svip.jina.ai/', 429, 'Rate exceeded.')],
] as const) {
    test(`falls back to the full page when ${name}`, async () => {
        const calls = withSvip(answer);

        const result = await read();

        assert.deepEqual(calls.map((c) => c.host), ['svip.jina.ai', 'r.jina.ai']);
        assert.equal(result.structuredData.snippet_source, 'full_content');
        assert.equal(result.structuredData.content, 'FULL PAGE BODY');
    });
}

test('falls back to the full page when the svip call throws', async () => {
    stub = stubFetch((call) => {
        if (call.host === 'svip.jina.ai') throw new Error('The operation was aborted due to timeout');
        return respond(call.url, 200, FULL);
    });

    const result = await read();

    assert.equal(result.structuredData.snippet_source, 'full_content');
});

test('svip is given less time than we wait for it', async () => {
    const calls = withSvip(() => respond('https://svip.jina.ai/', 200, { results: [] }));

    await read();

    const [svip, reader] = calls;
    assert.equal(svip.body.deep_timeout, 20000);
    assert.equal(svip.timeoutMs, 25000);
    assert.equal(reader.timeoutMs, 30000);
});

test('without a key the question is not sent to svip at all', async () => {
    const calls = withSvip(() => respond('https://svip.jina.ai/', 401, { error: 'no key' }));

    const result = await read({}, null);

    assert.deepEqual(calls.map((c) => c.host), ['r.jina.ai']);
    assert.match(result.structuredData.note, /requires a Jina API key/);
});

test('without a question it is a plain read', async () => {
    const calls = withSvip(() => respond('https://svip.jina.ai/', 200, { results: [] }));

    const result = await read({ question: undefined });

    assert.deepEqual(calls.map((c) => c.host), ['r.jina.ai']);
    assert.equal(result.structuredData.content, 'FULL PAGE BODY');
    assert.equal(result.structuredData.snippet_source, undefined);
});
