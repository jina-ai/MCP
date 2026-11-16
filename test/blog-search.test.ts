import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { executeJinaBlogSearch } from '../src/utils/search.js';
import { respond, stubFetch } from './helpers.js';

/**
 * The blog catalog cache: empty -> downloading -> fresh -> stale. The module
 * keeps its state for the life of an isolate, so these tests run in order and
 * each one starts from where the previous one left the cache.
 */
const CATALOG = {
    posts: [
        { title: 'Late Chunking in Long-Context Embedding Models', slug: 'late-chunking', excerpt: 'Chunking after embedding.', published_at: '2024-08-22T00:00:00Z', url: 'https://cms.jina.ai/late-chunking/' },
        { title: 'Jina Reranker v3', slug: 'jina-reranker-v3', excerpt: 'A listwise reranker.', published_at: '2025-10-01T00:00:00Z', url: 'https://cms.jina.ai/jina-reranker-v3/' },
    ],
};

type GhostMode = 'ok' | 'never' | 'down';
let mode: GhostMode = 'ok';
const stub = stubFetch(() => {
    if (mode === 'never') return new Promise<Response>(() => { });
    if (mode === 'down') return respond('https://cms.jina.ai/', 503, 'unavailable', { statusText: 'Service Unavailable' });
    return respond('https://cms.jina.ai/', 200, CATALOG);
});
const realNow = Date.now;
after(() => {
    stub.restore();
    Date.now = realNow;
});

/** One tool call: every query in it is handed the same config object. */
const call = (queries: string[]) => {
    const config = {};
    return Promise.all(queries.map((query) => executeJinaBlogSearch({ query }, 'ghost-key', config))) as Promise<any[]>;
};

test('a download another request never finished does not hold up this one', async () => {
    // A request whose client went away: the runtime drops its fetch and the
    // promise never settles. This used to be the one promise every later
    // search in the isolate waited on.
    mode = 'never';
    void call(['chunking']);

    mode = 'ok';
    const [result] = await call(['chunking']);

    assert.equal(result.error, undefined);
    assert.equal(result.results[0].title, 'Late Chunking in Long-Context Embedding Models');
});

test('a fresh catalog is reused without asking the CMS again', async () => {
    const before = stub.calls.length;

    const [result] = await call(['reranker']);

    assert.equal(stub.calls.length, before);
    assert.equal(result.results[0].url, 'https://jina.ai/news/jina-reranker-v3/');
});

test('the queries of one call share a single download', async () => {
    Date.now = () => realNow() + 11 * 60 * 1000; // past the 10 minute lifetime
    const before = stub.calls.length;

    const results = await call(['chunking', 'reranker', 'embedding', 'jina', 'listwise']);

    assert.equal(stub.calls.length, before + 1);
    assert.equal(results.filter((r) => r.error).length, 0);
});

test('a stale catalog is served when the refresh fails, and the CMS is left alone for a minute', async () => {
    Date.now = () => realNow() + 30 * 60 * 1000;
    mode = 'down';
    const before = stub.calls.length;

    const [first] = await call(['chunking']);
    assert.equal(first.error, undefined);
    assert.equal(first.results[0].title, 'Late Chunking in Long-Context Embedding Models');
    assert.equal(stub.calls.length, before + 1);

    // Thirty seconds later: still answered, without another failed download.
    Date.now = () => realNow() + 30 * 60 * 1000 + 30 * 1000;
    const [second] = await call(['reranker']);
    assert.equal(second.error, undefined);
    assert.equal(stub.calls.length, before + 1);

    // After the minute it tries again.
    Date.now = () => realNow() + 30 * 60 * 1000 + 61 * 1000;
    mode = 'ok';
    await call(['reranker']);
    assert.equal(stub.calls.length, before + 2);
});
