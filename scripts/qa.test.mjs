import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchQA } from '../qa.js';
import { validateEntries, selectResources, importEntries } from './qa-import.mjs';
import { previewConfig } from './preview-config.mjs';

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const example = JSON.parse(readFileSync('data/qa.example.json', 'utf8'));
const vector = Array(384).fill(0.1);
const request = (query = 'Can I join?', options) => new Request(`https://www.christforeveryone.org/api/qa/search?q=${encodeURIComponent(query)}`, options);
function env({ empty = false, allowed = true } = {}) {
  return {
    QA_ENVIRONMENT: 'preview', QA_MIN_SCORE: '0.65',
    QA_SEARCH_LIMITER: { limit: async () => ({ success: allowed }) },
    AI: { run: async () => ({ data: [vector] }) },
    QA_INDEX: { query: async () => ({ matches: [
      { id: 'valid', score: 0.9, metadata: { revision: 'current' } },
      { id: 'stale', score: 0.85, metadata: { revision: 'old' } },
      { id: 'draft', score: 0.8, metadata: { revision: 'current' } },
      { id: 'weak', score: 0.3, metadata: { revision: 'current' } },
    ] }) },
    QA_DB: { prepare: () => ({ first: async () => empty ? null : { id: 'valid' }, bind: () => ({ all: async () => ({ results: [
      { id: 'valid', question: 'Can I attend?', answer: 'Everyone is welcome.', source: null, revision: 'current' },
      { id: 'stale', question: 'Updated?', answer: 'Updated answer.', revision: 'new' },
    ] }) }) }) },
  };
}

test('search returns ranked curated answers and suppresses weak, stale and unpublished matches', async () => {
  const response = await searchQA(request(), env());
  const body = await response.json();
  assert.deepEqual(body.results.map(r => r.id), ['valid']);
  assert.equal(body.results[0].answer, 'Everyone is welcome.');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('invalid search and exhausted rate limits never invoke inference', async () => {
  for (const [req, bindings, status] of [
    [request(''), env(), 400], [request('x'.repeat(501)), env(), 400],
    [request('hello', { method: 'POST' }), env(), 405],
    [request(), env({ allowed: false }), 429],
    [new Request('https://x/api/qa/search?q=test&limit=100'), env(), 400],
  ]) {
    bindings.AI.run = () => assert.fail('Unexpected inference');
    assert.equal((await searchQA(req, bindings)).status, status);
  }
});

test('empty collection returns no results without generating an embedding', async () => {
  const bindings = env({ empty: true });
  bindings.AI.run = () => assert.fail('Unexpected inference');
  assert.deepEqual((await (await searchQA(request(), bindings)).json()).results, []);
});

test('upstream failures do not leak internal messages', async () => {
  const bindings = env();
  bindings.AI.run = async () => { throw new Error('private upstream detail'); };
  const response = await searchQA(request(), bindings);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private upstream/);
});

test('preview resource selection cannot inherit production databases or indexes', () => {
  const production = selectResources(config, 'production');
  const preview = selectResources(config, 'preview');
  assert.notEqual(preview.databaseId, production.databaseId);
  assert.notEqual(preview.indexName, production.indexName);
  const generated = previewConfig(config, '3');
  assert.equal(generated.d1_databases[0].database_id, preview.databaseId);
  assert.equal(generated.vectorize[0].index_name, preview.indexName);
  assert.equal(generated.vars.QA_ENVIRONMENT, 'preview');
  assert.notEqual(generated.ratelimits[0].namespace_id, config.ratelimits[0].namespace_id);
  assert.throws(() => selectResources(config, undefined), /explicitly/);
  assert.throws(() => previewConfig({ ...config, env: undefined }, '3'), /refusing to inherit/);
});

test('import validation rejects ambiguous publication, duplicate IDs and oversized embedding text', () => {
  const [entry] = example;
  for (const input of [[{ ...entry, published: undefined }], [entry, entry], [{ ...entry, aliases: ['x'.repeat(500)] }], [{ ...entry, source: 'javascript:alert(1)' }]]) {
    assert.throws(() => validateEntries(input));
  }
  assert.equal(validateEntries(example)[0].revision, validateEntries(example)[0].revision);
  assert.notEqual(validateEntries([{ ...entry, answer: 'Changed answer' }])[0].revision, validateEntries([entry])[0].revision);
});

test('import upserts before publishing and unpublishes before removing vectors', async () => {
  const records = validateEntries([example[0], { ...example[1], published: false }]);
  const calls = [];
  const api = async (path, body) => {
    calls.push([path, body]);
    if (path.includes('/ai/run/')) return { data: [vector] };
    if (path.endsWith('/query')) return [{ success: true }];
    return { mutationId: 'accepted' };
  };
  await importEntries(records, selectResources(config, 'preview'), api);
  assert.deepEqual(calls.map(([p]) => p.split('/').at(-1)), ['bge-small-en-v1.5', 'upsert', 'query', 'query', 'delete_by_ids']);
  assert.equal(JSON.parse(calls[1][1]).metadata.revision, records[0].revision);
  assert.equal(calls[3][1].params[4], 0);
});

test('failed vector mutation never publishes the new D1 record', async () => {
  const calls = [];
  await assert.rejects(importEntries(validateEntries(example), selectResources(config, 'preview'), async path => {
    calls.push(path);
    if (path.includes('/ai/run/')) return { data: [vector, vector] };
    throw new Error('mutation failed');
  }), /mutation failed/);
  assert.ok(!calls.some(p => p.includes('/d1/')));
});
