import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    PASSAGE_BUDGET_MS,
    PASSAGE_REQUEST_TIMEOUT_MS,
    PLAIN_READ_TIMEOUT_MS,
    QUESTION_READ_TIMEOUT_MS,
    READ_REQUEST_TIMEOUT_MS,
    describeLimits,
} from '../src/utils/limits.js';

/**
 * The limits only work in relation to each other. These are the relations;
 * changing one number without the others should fail here, not in production.
 */
test('svip is told to give up before we stop waiting for it', () => {
    // Equal budgets (30s and 30s) meant svip's answer at its deadline went to a
    // connection we were closing, and was still charged for.
    assert.ok(PASSAGE_BUDGET_MS < PASSAGE_REQUEST_TIMEOUT_MS);
    assert.ok(PASSAGE_REQUEST_TIMEOUT_MS - PASSAGE_BUDGET_MS >= 5000);
});

test('a question read leaves room for the full-page fallback', () => {
    assert.ok(PASSAGE_REQUEST_TIMEOUT_MS + READ_REQUEST_TIMEOUT_MS <= QUESTION_READ_TIMEOUT_MS);
});

test('a plain read in an array is not cut off before its own request would be', () => {
    assert.ok(READ_REQUEST_TIMEOUT_MS <= PLAIN_READ_TIMEOUT_MS);
});

test('the info page states the limits the code uses', () => {
    const limits = describeLimits();
    assert.equal(limits.read_url_with_question, '25s for the passages, then 30s for the full page if none came back');
    assert.equal(limits.search, '30s per query, up to 5 queries per call');
    assert.equal(limits.extract_pdf, '90s');
});
