export const MAX_LEXICAL_QUERY_LENGTH = 2000;
export const MAX_SIGNIFICANT_TERMS = 24;
export const MAX_LEXICAL_LIMIT = 30;
export const MAX_LEXICAL_OFFSET = 100000;

const STOPWORDS = new Set(('a an and are as at be been being but by can could did do does doing for from had has have having he her hers herself him himself his how i if in into is it its itself just me might more most my myself no nor not of on once only or other our ours ourselves out over own s t d m ll re ve same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves').split(' '));
const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...HEADERS, ...extra } });

// Only this derived index text is normalized. Original source strings stay intact.
export function lexicalTokens(text) {
  return String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
export function indexText(text) { return lexicalTokens(text).join(' '); }
export function analyzeLexicalQuery(query) {
  const tokens = lexicalTokens(query);
  const terms = [...new Set(tokens.filter(term => !STOPWORDS.has(term) && !/^\p{L}$/u.test(term)))];
  return { tokens, terms, phrase: tokens.length ? `"${tokens.join(' ')}"` : null,
    match: terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ') };
}

function integer(value, fallback, min, max, label) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return number;
}
function options(request) {
  const url = new URL(request.url);
  for (const key of ['q', 'topic_id', 'limit', 'offset']) {
    if (url.searchParams.getAll(key).length > 1) throw new Error(`Supply ${key} only once.`);
  }
  const query = (url.searchParams.get('q') ?? '').trim().replace(/\s+/gu, ' ');
  if (query.length > MAX_LEXICAL_QUERY_LENGTH) throw new Error(`Search must be at most ${MAX_LEXICAL_QUERY_LENGTH} characters.`);
  const analyzed = analyzeLexicalQuery(query);
  if (analyzed.terms.length > MAX_SIGNIFICANT_TERMS) throw new Error(`Search may contain at most ${MAX_SIGNIFICANT_TERMS} different significant words.`);
  return { query, analyzed,
    topic_id: integer(url.searchParams.get('topic_id'), null, 1, Number.MAX_SAFE_INTEGER, 'topic_id'),
    limit: integer(url.searchParams.get('limit'), 10, 1, MAX_LEXICAL_LIMIT, 'limit'),
    offset: integer(url.searchParams.get('offset'), 0, 0, MAX_LEXICAL_OFFSET, 'offset') };
}
const SELECT = 'e.id, e.qa_id, e.question, e.answer, e.source_url, e.publisher, e.citation_json, e.topic_paths_json';
const FILTER = `EXISTS (SELECT 1 FROM suscopts_entry_topics membership
  JOIN suscopts_topic_closure closure ON closure.descendant_id = membership.topic_id
  WHERE membership.qa_id = e.qa_id AND closure.ancestor_id = ?)`;

export function buildLexicalStatements({ query, analyzed = analyzeLexicalQuery(query), topic_id = null, limit = 10, offset = 0 }) {
  const filter = topic_id === null ? '' : ` AND ${FILTER}`;
  const filterParams = topic_id === null ? [] : [topic_id];
  if (!query) return {
    count: { sql: `SELECT count(*) AS total_count FROM suscopts_entries e WHERE 1=1${filter}`, params: filterParams },
    rows: { sql: `SELECT ${SELECT} FROM suscopts_entries e WHERE 1=1${filter} ORDER BY e.qa_id LIMIT ? OFFSET ?`, params: [...filterParams, limit, offset] },
  };
  if (!analyzed.terms.length) return null;
  const hits = analyzed.terms.map(() => 'SELECT rowid AS qa_id, ? AS term FROM suscopts_entries_fts WHERE suscopts_entries_fts MATCH ?').join(' UNION ALL ');
  const hitParams = analyzed.terms.flatMap(term => [term, `"${term.replaceAll('"', '""')}"`]);
  const prefix = `WITH term_hits AS (${hits}), term_counts AS (
    SELECT qa_id, count(*) AS matched_count, json_group_array(term) AS matched_terms_json FROM term_hits GROUP BY qa_id
  ), phrase_hits AS (
    SELECT rowid AS qa_id FROM suscopts_entries_fts WHERE suscopts_entries_fts MATCH ?
    UNION
    SELECT membership.qa_id FROM suscopts_topics_fts
      JOIN suscopts_topic_closure closure ON closure.ancestor_id = suscopts_topics_fts.rowid
      JOIN suscopts_entry_topics membership ON membership.topic_id = closure.descendant_id
      WHERE suscopts_topics_fts MATCH ?
  )`;
  return {
    count: { sql: `SELECT count(*) AS total_count FROM suscopts_entries_fts
      JOIN suscopts_entries e ON e.qa_id = suscopts_entries_fts.rowid
      WHERE suscopts_entries_fts MATCH ?${filter}`, params: [analyzed.match, ...filterParams] },
    rows: { sql: `${prefix} SELECT ${SELECT}, term_counts.matched_terms_json,
      CASE WHEN phrase_hits.qa_id IS NOT NULL THEN 'phrase'
        WHEN term_counts.matched_count = ? THEN 'all_words' ELSE 'some_words' END AS match_type
      FROM suscopts_entries_fts
      JOIN suscopts_entries e ON e.qa_id = suscopts_entries_fts.rowid
      JOIN term_counts ON term_counts.qa_id = e.qa_id
      LEFT JOIN phrase_hits ON phrase_hits.qa_id = e.qa_id
      WHERE suscopts_entries_fts MATCH ?${filter}
      ORDER BY CASE WHEN phrase_hits.qa_id IS NOT NULL THEN 0 WHEN term_counts.matched_count = ? THEN 1 ELSE 2 END,
        term_counts.matched_count DESC, bm25(suscopts_entries_fts, 8.0, 1.0, 3.0), e.qa_id
      LIMIT ? OFFSET ?`,
      params: [...hitParams, `{question_index answer_index}: ${analyzed.phrase}`, analyzed.phrase,
        analyzed.terms.length, analyzed.match, ...filterParams, analyzed.terms.length, limit, offset] },
  };
}

function record(row, terms) {
  const matched = new Set(JSON.parse(row.matched_terms_json ?? '[]'));
  return { id: row.id, qa_id: row.qa_id, question: row.question, answer: row.answer,
    source_url: row.source_url, publisher: row.publisher,
    citation: JSON.parse(row.citation_json), topic_paths: JSON.parse(row.topic_paths_json),
    match_type: row.match_type ?? null, matched_terms: terms.filter(term => matched.has(term)) };
}
export async function lexicalQA(request, env) {
  if (request.method !== 'GET') return json({ error: 'Use GET for Q&A search.' }, 405, { Allow: 'GET' });
  let parsed;
  try { parsed = options(request); } catch (error) { return json({ error: error.message }, 400); }
  try {
    if (!env.QA_DB) return json({ error: 'Q&A search is temporarily unavailable.' }, 503);
    if (parsed.topic_id !== null && !await env.QA_DB.prepare('SELECT id FROM suscopts_topics WHERE id = ?').bind(parsed.topic_id).first()) {
      return json({ error: 'Unknown source topic.' }, 400);
    }
    if (parsed.query && env.QA_SEARCH_LIMITER) {
      const { success } = await env.QA_SEARCH_LIMITER.limit({ key: `${env.QA_ENVIRONMENT ?? 'local'}:lexical:${request.headers.get('CF-Connecting-IP') ?? 'local'}` });
      if (!success) return json({ error: 'Please wait a minute before searching again.' }, 429, { 'Retry-After': '60' });
    }
    const { query, topic_id, offset, limit, analyzed } = parsed;
    const plan = buildLexicalStatements(parsed);
    if (!plan) return json({ query, topic_id, total_count: 0, offset, limit, results: [], significant_terms: analyzed.terms });
    const [count, rows] = await Promise.all([
      env.QA_DB.prepare(plan.count.sql).bind(...plan.count.params).first(),
      env.QA_DB.prepare(plan.rows.sql).bind(...plan.rows.params).all(),
    ]);
    return json({ query, topic_id, total_count: count.total_count, offset, limit,
      results: rows.results.map(row => record(row, analyzed.terms)), significant_terms: analyzed.terms });
  } catch (error) {
    console.error('SUSCopts lexical search failed:', error.name);
    return json({ error: 'Q&A search is temporarily unavailable.' }, 503);
  }
}

export async function topicsQA(request, env) {
  if (request.method !== 'GET') return json({ error: 'Use GET for source topics.' }, 405, { Allow: 'GET' });
  try {
    const [topics, count] = await Promise.all([
      env.QA_DB.prepare('SELECT id, name, parent_id, root_id, path_ids_json, path_names_json, question_count, direct_question_count FROM suscopts_topics ORDER BY id').all(),
      env.QA_DB.prepare('SELECT count(*) AS question_count FROM suscopts_entries').first(),
    ]);
    return json({ topics: topics.results.map(({ path_ids_json, path_names_json, ...topic }) => ({ ...topic,
      path_ids: JSON.parse(path_ids_json), path_names: JSON.parse(path_names_json) })), question_count: count.question_count });
  } catch (error) {
    console.error('SUSCopts topics failed:', error.name);
    return json({ error: 'Q&A topics are temporarily unavailable.' }, 503);
  }
}
