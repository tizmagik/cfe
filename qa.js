export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_POOLING = 'mean';
export const MAX_SEARCH_LENGTH = 500;

export function normalizeQuery(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function assertEmbedding(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS ||
      !vector.every(Number.isFinite)) throw new Error('Invalid embedding response');
  return vector;
}

const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...headers },
});

export async function searchQA(request, env) {
  if (request.method !== 'GET') return json({ error: 'Use GET for search.' }, 405, { Allow: 'GET' });
  const url = new URL(request.url);
  const query = normalizeQuery(url.searchParams.get('q'));
  const limit = Number(url.searchParams.get('limit') ?? 5);
  if (!query || query.length > MAX_SEARCH_LENGTH || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    return json({ error: 'Provide q (1–500 characters) and an optional limit (1–10).' }, 400);
  }
  try {
    const { success } = await env.QA_SEARCH_LIMITER.limit({
      key: `${env.QA_ENVIRONMENT}:search:${request.headers.get('CF-Connecting-IP') ?? 'local'}`,
    });
    if (!success) return json({ error: 'Too many searches. Please try again shortly.' }, 429, { 'Retry-After': '60' });
    // Avoid inference entirely while the curated collection is empty.
    const any = await env.QA_DB.prepare('SELECT id FROM qa_entries WHERE published = 1 LIMIT 1').first();
    if (!any) return json({ query, results: [] });
    const embedding = await env.AI.run(EMBEDDING_MODEL, { text: [query], pooling: EMBEDDING_POOLING });
    const found = await env.QA_INDEX.query(assertEmbedding(embedding.data?.[0]), {
      topK: 20, returnMetadata: 'all', returnValues: false,
    });
    const matches = found.matches.filter(match => match.score >= Number(env.QA_MIN_SCORE));
    if (!matches.length) return json({ query, results: [] });
    const ids = matches.map(match => match.id);
    const { results: rows } = await env.QA_DB.prepare(
      `SELECT id, question, answer, source, revision FROM qa_entries WHERE published = 1 AND id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all();
    const byId = new Map(rows.map(row => [row.id, row]));
    const results = matches.flatMap(match => {
      const row = byId.get(match.id);
      // Async Vectorize mutations and partial imports must never serve stale answers.
      if (!row || row.revision !== match.metadata?.revision) return [];
      return [{ id: row.id, question: row.question, answer: row.answer, source: row.source, score: match.score }];
    }).slice(0, limit);
    return json({ query, results });
  } catch (error) {
    // Do not log visitors' questions, answers, or upstream response bodies.
    console.error('Q&A search dependency failed', { name: error.name });
    return json({ error: 'Search is temporarily unavailable. Please try again later.' }, 503);
  }
}
