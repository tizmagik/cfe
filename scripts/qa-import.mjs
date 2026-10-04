import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EMBEDDING_MODEL, EMBEDDING_POOLING, MAX_SEARCH_LENGTH, normalizeQuery, assertEmbedding } from '../qa.js';

export function validateEntries(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 1000) throw new Error('Supply a JSON array of 1–1000 entries.');
  const ids = new Set();
  return input.map(entry => {
    if (!entry || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id ?? '') || ids.has(entry.id)) throw new Error('Each entry needs a unique stable id (1–64 lowercase letters, numbers, _ or -).');
    ids.add(entry.id);
    const question = normalizeQuery(entry.question);
    const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
    if (!question || question.length > MAX_SEARCH_LENGTH || !answer || answer.length > 20000) throw new Error(`Invalid question or answer for ${entry.id}.`);
    if (typeof entry.published !== 'boolean') throw new Error(`Set published explicitly for ${entry.id}.`);
    const aliases = entry.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.length > 10 || aliases.some(a => typeof a !== 'string' || !normalizeQuery(a))) throw new Error(`Invalid aliases for ${entry.id}.`);
    const text = [question, ...aliases.map(normalizeQuery)].join('\n');
    if (text.length > MAX_SEARCH_LENGTH) throw new Error(`Question and aliases combined exceed 500 characters for ${entry.id}.`);
    const source = entry.source ?? null;
    if (source !== null && (typeof source !== 'string' || source.length > 1000 || !/^https?:\/\//.test(source))) throw new Error(`Source must be an http(s) URL for ${entry.id}.`);
    const record = { id: entry.id, question, answer, source, published: entry.published, text };
    const revision = createHash('sha256').update(JSON.stringify({ ...record, model: EMBEDDING_MODEL, pooling: EMBEDDING_POOLING })).digest('hex');
    return { ...record, revision };
  });
}

export function selectResources(config, target) {
  if (!['production', 'preview'].includes(target)) throw new Error('Choose --target production or --target preview explicitly.');
  const selected = target === 'preview' ? config.env.preview : config;
  return {
    accountId: config.account_id,
    databaseId: selected.d1_databases.find(b => b.binding === 'QA_DB').database_id,
    indexName: selected.vectorize.find(b => b.binding === 'QA_INDEX').index_name,
  };
}

export async function importEntries(entries, resources, api) {
  const prefix = `/accounts/${resources.accountId}`;
  const index = `${prefix}/vectorize/v2/indexes/${resources.indexName}`;
  const mutations = [];
  for (let offset = 0; offset < entries.length; offset += 10) {
    const batch = entries.slice(offset, offset + 10);
    const published = batch.filter(e => e.published);
    if (published.length) {
      const embedding = await api(`${prefix}/ai/run/${EMBEDDING_MODEL}`, { text: published.map(e => e.text), pooling: EMBEDDING_POOLING });
      if (embedding.data?.length !== published.length) throw new Error('Unexpected embedding batch size.');
      const vectors = published.map((e, i) => ({ id: e.id, values: assertEmbedding(embedding.data[i]), metadata: { revision: e.revision } }));
      const mutation = await api(`${index}/upsert`, vectors.map(v => JSON.stringify(v)).join('\n') + '\n', 'application/x-ndjson');
      mutations.push(mutation.mutationId);
    }
    // Update the authoritative records only after Vectorize accepts the batch.
    // Revision checks in search hide mismatched records until the async mutation lands.
    for (const e of batch) {
      const result = await api(`${prefix}/d1/database/${resources.databaseId}/query`, {
        sql: `INSERT INTO qa_entries (id, question, answer, source, published, revision) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET question=excluded.question, answer=excluded.answer, source=excluded.source,
          published=excluded.published, revision=excluded.revision, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        params: [e.id, e.question, e.answer, e.source, Number(e.published), e.revision],
      });
      if (result.some(r => r.success === false)) throw new Error(`D1 rejected entry ${e.id}. Rerun the import to reconcile.`);
    }
    const drafts = batch.filter(e => !e.published);
    if (drafts.length) {
      const mutation = await api(`${index}/delete_by_ids`, { ids: drafts.map(e => e.id) });
      mutations.push(mutation.mutationId);
    }
  }
  return mutations;
}

async function main() {
  const args = process.argv.slice(2);
  const target = args[args.indexOf('--target') + 1];
  if (args.length !== 3 || args[1] !== '--target') throw new Error('Usage: npm run qa:import -- path/to/qa.json --target preview|production');
  const entries = validateEntries(JSON.parse(readFileSync(args[0], 'utf8')));
  const resources = selectResources(JSON.parse(readFileSync('wrangler.jsonc', 'utf8')), target);
  // Capture credentials in memory only. Never print them or pass them as CLI arguments.
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    const auth = JSON.parse(execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    token = auth.token;
  }
  if (!token) throw new Error('Run npx wrangler login or set CLOUDFLARE_API_TOKEN.');
  const api = async (path, body, contentType = 'application/json') => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    const payload = await response.json();
    if (!response.ok || payload.success === false) throw new Error(`Cloudflare request failed (${response.status}); verify access and quotas, then rerun the import.`);
    return payload.result;
  };
  console.log(`Importing ${entries.length} entries into ${target}: ${resources.indexName}.`);
  const mutations = await importEntries(entries, resources, api);
  console.log(`Import accepted. Vectorize visibility is asynchronous; mutation IDs: ${mutations.join(', ')}. Verify search after indexing completes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
