import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewConfig } from './preview-config.mjs';
import { deletePreview } from './delete-preview.mjs';
import worker from '../worker.js';

const base = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const settings = { prNumber: '1', accountId: 'a'.repeat(32), token: 'test-token' };
const domain = { id: 'preview-domain', hostname: 'pr-1.christforeveryone.org', service: 'cfe-pr-1' };
const json = result => Response.json({ success: true, result });
function mockFetch(responses) {
  const calls = [];
  const fetchApi = async (url, options) => {
    calls.push([new URL(url).pathname, options.method ?? 'GET']);
    assert.ok(responses.length, 'Unexpected Cloudflare request');
    return responses.shift();
  };
  return { fetchApi, calls };
}

test('preview replaces every production domain without mutating production config', () => {
  const original = structuredClone(base);
  const config = previewConfig(base, '123');
  assert.equal(config.name, 'cfe-pr-123');
  assert.deepEqual(config.routes, [{ pattern: 'pr-123.christforeveryone.org', custom_domain: true }]);
  assert.deepEqual(base, original);
  for (const value of [undefined, '', '0', '-1', '01', '1.5', '../cfe']) {
    assert.throws(() => previewConfig(base, value), /positive integer/);
  }
});

test('cleanup deletes its own domain and Worker and verifies both are gone', async () => {
  const mock = mockFetch([json([domain]), json(null), new Response(null, {status:204}), json([]), new Response(null, {status:404})]);
  await deletePreview({ ...settings, fetchApi: mock.fetchApi });
  const prefix = `/client/v4/accounts/${settings.accountId}/workers`;
  assert.deepEqual(mock.calls, [[`${prefix}/domains`, 'GET'], [`${prefix}/domains/preview-domain`, 'DELETE'], [`${prefix}/scripts/cfe-pr-1`, 'DELETE'], [`${prefix}/domains`, 'GET'], [`${prefix}/scripts/cfe-pr-1`, 'GET']]);
});

test('cleanup refuses to delete a reassigned hostname', async () => {
  const mock = mockFetch([json([{ ...domain, service: 'cfe' }])]);
  await assert.rejects(deletePreview({ ...settings, fetchApi: mock.fetchApi }), /ownership mismatch/);
  assert.equal(mock.calls.length, 1);
});

test('cleanup is repeatable after removal', async () => {
  const mock = mockFetch([json([]), new Response(null, {status:404}), json([]), new Response(null, {status:404})]);
  assert.deepEqual(await deletePreview({ ...settings, fetchApi: mock.fetchApi }), { worker: domain.service, hostname: domain.hostname });
});

test('cleanup rejects invalid input before calling Cloudflare', async () => {
  const mock = mockFetch([]);
  await assert.rejects(deletePreview({ ...settings, prNumber:'../cfe', fetchApi: mock.fetchApi }), /Invalid PR_NUMBER/);
  assert.equal(mock.calls.length, 0);
});

test('cleanup fails if Worker removal cannot be verified', async () => {
  const mock = mockFetch([json([]), new Response(null, {status:204}), json([]), new Response('worker')]);
  await assert.rejects(deletePreview({ ...settings, fetchApi: mock.fetchApi }), /removal not verified/);
});

test('metadata identifies the deployment without caching', async () => {
  const response = await worker.fetch(new Request('https://pr-1.christforeveryone.org/.well-known/deployment'), { DEPLOYMENT_SHA: 'abc123' });
  assert.deepEqual(await response.json(), { commit: 'abc123' });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('production redirects preserve path and query; previews serve assets directly', async () => {
  const response = await worker.fetch(new Request('https://christforeveryone.org/path?a=1'), {});
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), 'https://www.christforeveryone.org/path?a=1');
  const env = { ASSETS: { fetch: async () => new Response('site') } };
  const preview = await worker.fetch(new Request('https://pr-1.christforeveryone.org/'), env);
  assert.equal(await preview.text(), 'site');
  assert.equal(preview.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const production = await worker.fetch(new Request('https://www.christforeveryone.org/'), env);
  assert.equal(production.headers.get('X-Robots-Tag'), null);
});
