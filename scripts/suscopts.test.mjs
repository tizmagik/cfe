import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { analyzeLexicalQuery, lexicalQA, topicsQA, buildLexicalStatements, indexText } from '../qa-lexical.js';
import { validateSource, loadSource, buildImportStatements, batchStatements, executeImport, selectDatabase, MIGRATION_SQL } from './suscopts-import.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(questions, categoryDefinitions = [{ id: 10, name: 'Source Root' }]) {
  const definitions = new Map(categoryDefinitions.map(topic => [topic.id, topic]));
  const pathFor = id => { const topic = definitions.get(id); return topic.parent ? [...pathFor(topic.parent), id] : [id]; };
  const url = id => `https://qa.suscopts.org/index.php?catid=${id}`;
  const records = questions.map(({ id, question, answer = 'Source answer retained.', topics = [10], ...extra }) => ({
    id: `suscopts-qa-${id}`, source_id: id, website: 'https://qa.suscopts.org/', source_url: `https://qa.suscopts.org/index.php?qid=${id}`,
    publisher: 'Coptic Orthodox Diocese of the Southern United States', question, answer,
    question_html: `<p>${question}</p>`, answer_html: `<p>${answer}</p>`,
    categories: topics.map(id => ({ source_id: id, name: definitions.get(id).name, alphabetical_index: 'S', url: url(id) })),
    citation: { text: `Source Q&A ${id}`, url: `https://qa.suscopts.org/index.php?qid=${id}`, publisher: 'Coptic Orthodox Diocese of the Southern United States' },
    author: null, source_html_sha256: hash(`source html ${id}`), content_sha256: hash(`${question}\n\n${answer}`),
    source_decoding: { unresolved_byte_count: 0 }, arbitrary_source_metadata: { preserved: true }, ...extra,
  }));
  const categories = categoryDefinitions.map(topic => {
    const ids = records.filter(record => record.categories.some(category => category.source_id === topic.id)).map(record => record.source_id);
    const total = records.filter(record => record.categories.some(category => pathFor(category.source_id).includes(topic.id))).length;
    return { source_id: topic.id, name: topic.name, alphabetical_index: 'S', url: url(topic.id), parent_category_ids: topic.parent ? [topic.parent] : [],
      child_category_ids: categoryDefinitions.filter(child => child.parent === topic.id).map(child => child.id), question_ids: ids,
      extracted_question_count: ids.length, aggregate_question_count: total };
  });
  const dataset = { record_count: records.length, records, categories, rights: { attribution_required: true }, coverage: {
    all_discovered_questions_exported: true, all_category_counts_match: true, failed_question_ids: [], category_count_mismatches: [], errors: [] } };
  const sourceSha = hash(JSON.stringify(dataset));
  const documents = { source_dataset_sha256: sourceSha, record_count: records.length, records: records.map(record => {
    const paths = record.categories.map(category => { const ids = pathFor(category.source_id); return { topic_ids: ids,
      label: ids.map(id => definitions.get(id).name).join(' > '), topics: ids.map(id => ({ topic_id: id, name: definitions.get(id).name, source_url: url(id) })) }; });
    return { ...record, topic_ids: record.categories.map(category => category.source_id),
      parent_topic_ids: [...new Set(record.categories.map(category => definitions.get(category.source_id).parent).filter(Boolean))],
      root_topic_ids: [...new Set(paths.map(path => path.topic_ids[0]))], filter_topic_ids: [...new Set(paths.flatMap(path => path.topic_ids))], topic_paths: paths };
  }) };
  const taxonomy = { source_dataset_sha256: sourceSha, topic_count: categories.length,
    root_topic_count: categoryDefinitions.filter(topic => !topic.parent).length,
    roots: categoryDefinitions.filter(topic => !topic.parent).map(topic => ({ topic_id: topic.id })),
    topics: categories.map(category => { const ids = pathFor(category.source_id); const descendants = categoryDefinitions.filter(topic => pathFor(topic.id).includes(category.source_id)).map(topic => topic.id);
      return { ...category, topic_id: category.source_id, parent_topic_id: category.parent_category_ids[0] ?? null, root_topic_id: ids[0], depth: ids.length - 1,
        topic_path_ids: ids, topic_path: ids.map(id => ({ topic_id: id, name: definitions.get(id).name, source_url: url(id) })),
        topic_path_label: ids.map(id => definitions.get(id).name).join(' > '), alphabetical_parent_label: 'S', direct_topic_ids: descendants,
        descendant_topic_ids: descendants.filter(id => id !== category.source_id), direct_question_count: category.extracted_question_count, descendant_question_count: category.aggregate_question_count };
    }) };
  return { dataset, documents, taxonomy, sourceSha, prepared: validateSource(dataset, documents, taxonomy, sourceSha, { records: records.length, topics: categories.length }) };
}
function sqliteAdapter(db) {
  return { prepare(sql) { let params = []; return {
    bind(...values) { params = values; return this; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params), success: true }; },
  }; } };
}
async function imported(prepared) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE); CREATE TABLE qa_entries(id TEXT PRIMARY KEY, answer TEXT); INSERT INTO qa_entries VALUES(\'legacy\',\'Do not change\');');
  const execute = async batch => {
    db.exec('BEGIN');
    try { const results = batch.map(({ sql, params }) => {
      if (sql === MIGRATION_SQL) { db.exec(sql); return { success: true, results: [] }; }
      const statement = db.prepare(sql); return { success: true, results: statement.columns().length ? statement.all(...params) : (statement.run(...params), []) };
    }); db.exec('COMMIT'); return results; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const receipt = await executeImport(prepared, execute, { applyMigration: true, importedAt: '2026-10-04T00:00:00Z' });
  return { db, execute, receipt, env: { QA_DB: sqliteAdapter(db) } };
}
const request = params => new Request(`https://example.test/api/qa/lexical?${new URLSearchParams(params)}`);
async function search(env, params = {}) { const response = await lexicalQA(request(params), env); return { status: response.status, body: await response.json() }; }

test('whole-query phrases outrank all significant words and partial matches, with safe phrase boundaries', async () => {
  const source = fixture([
    { id: 1, question: 'free choice is possible', answer: 'heaven is a place' },
    { id: 2, question: 'free', answer: 'will in heaven' },
    { id: 3, question: 'free', answer: 'source answer' },
    { id: 99, question: 'free will in heaven', answer: 'source answer' },
  ]);
  const { db, env } = await imported(source.prepared);
  try {
    const { body, status } = await search(env, { q: 'free will in heaven' });
    assert.equal(status, 200); assert.deepEqual(body.significant_terms, ['free','heaven']);
    assert.deepEqual(body.results.map(row => [row.qa_id,row.match_type]), [[99,'phrase'],[2,'all_words'],[1,'all_words'],[3,'some_words']]);
    assert.deepEqual(body.results[0].matched_terms, ['free','heaven']);
    assert.equal(body.results[0].question, source.dataset.records[3].question);
    assert.equal(db.prepare('SELECT answer FROM qa_entries WHERE id=?').get('legacy').answer, 'Do not change');
  } finally { db.close(); }
});

test('a phrase cannot span two topic names; actual parent and child labels are searchable', async () => {
  const source = fixture([{ id: 1, question: 'Source document', topics: [12] }, { id: 2, question: 'Source document', topics: [20] }], [
    { id: 10, name: 'Alpha' }, { id: 12, name: 'Beta', parent: 10 }, { id: 20, name: 'Alpha Beta' }, { id: 99, name: 'Empty' },
  ]);
  const { db, env } = await imported(source.prepared);
  try {
    const { body } = await search(env, { q: 'alpha beta' });
    assert.deepEqual(body.results.map(row => [row.qa_id,row.match_type]), [[2,'phrase'],[1,'all_words']]);
    assert.equal((await search(env, { q: 'alpha', topic_id: '10' })).body.total_count, 1);
    assert.equal((await search(env, { topic_id: '99' })).body.total_count, 0);
  } finally { db.close(); }
});

test('hierarchy, pagination and duplicate memberships use original IDs and preserve every source byte', async () => {
  const longQuestion = 'Why? '.repeat(1900), longAnswer = 'Full answer — café.\n'.repeat(1600);
  const source = fixture([{ id: 3, question: longQuestion, answer: longAnswer, topics: [57,253] },
    { id: 7, question: 'Second source question', topics: [219] }, { id: 9, question: 'Third source question', topics: [253] }],
  [{ id: 57, name: 'Child', parent: 219 }, { id: 219, name: 'Original Root' }, { id: 253, name: 'Other Root' }, { id: 383, name: 'Empty Root' }]);
  const { db, env, execute } = await imported(source.prepared);
  try {
    assert.equal((await search(env)).body.total_count, 3);
    assert.deepEqual((await search(env, { topic_id: '219', limit: '1', offset: '1' })).body.results.map(row => row.qa_id), [7]);
    assert.equal((await search(env, { topic_id: '253' })).body.total_count, 2);
    const first = (await search(env, { limit: '1' })).body.results[0];
    assert.equal(first.question, longQuestion); assert.equal(first.answer, longAnswer);
    assert.deepEqual(first.topic_paths, source.documents.records[0].topic_paths);
    assert.deepEqual(JSON.parse(db.prepare('SELECT source_record_json FROM suscopts_entries WHERE qa_id=3').get().source_record_json), source.dataset.records[0]);
    await executeImport(source.prepared, execute, { applyMigration: true });
    assert.equal(db.prepare('SELECT count(*) n FROM suscopts_entries').get().n, 3);
    assert.equal(db.prepare('SELECT count(*) n FROM suscopts_entries_fts WHERE suscopts_entries_fts MATCH ?').get('"full"').n, 1);
    const topicResponse = await topicsQA(new Request('https://example.test/api/qa/topics'), env);
    const topics = (await topicResponse.json()).topics;
    assert.deepEqual(topics.find(topic => topic.id === 57), { id: 57, name: 'Child', parent_id: 219, root_id: 219, question_count: 1, direct_question_count: 1, path_ids: [219,57], path_names: ['Original Root','Child'] });
    assert.equal(topics.find(topic => topic.id === 383).question_count, 0);
  } finally { db.close(); }
});

test('normalization treats punctuation and curly apostrophes alike and removes contraction debris', () => {
  assert.deepEqual(analyzeLexicalQuery("God’s love").tokens, analyzeLexicalQuery("God's love").tokens);
  assert.deepEqual(analyzeLexicalQuery('do—not—resuscitate').tokens, analyzeLexicalQuery('DO NOT RESUSCITATE').tokens);
  assert.deepEqual(analyzeLexicalQuery("why can't women do it?").terms, ['women']);
  assert.deepEqual(analyzeLexicalQuery('Women women\u2003WOMEN').terms, ['women']);
  assert.equal(indexText('CAFÉ\nSource'), 'cafe source');
});

test('common-only, punctuation and hostile syntax cannot become match-all or executable FTS', async () => {
  const { db, env } = await imported(fixture([{ id: 1, question: 'Body and blood are present', answer: 'Source answer' }]).prepared);
  try {
    for (const q of ['of the and', '"()*:+-\'', 'AND OR NOT', 't d m ll re ve']) assert.equal((await search(env, { q })).body.total_count, 0, q);
    for (const q of ['"body" OR *', "body'; DROP TABLE suscopts_entries;--", 'body:NEAR(answer)', 'body AND blood']) {
      const { status, body } = await search(env, { q }); assert.equal(status, 200); assert(body.results.every(row => row.qa_id === 1));
    }
    assert.equal(db.prepare('SELECT count(*) n FROM suscopts_entries').get().n, 1);
  } finally { db.close(); }
});

test('question field receives more lexical relevance than the answer field', async () => {
  const { db, env } = await imported(fixture([{ id: 2, question: 'rareword', answer: 'unrelated' }, { id: 1, question: 'unrelated', answer: 'rareword' }]).prepared);
  try { assert.deepEqual((await search(env, { q: 'rareword' })).body.results.map(row => row.qa_id), [2,1]); } finally { db.close(); }
});

test('request bounds and method errors are clear; free browse bypasses search limiter', async () => {
  const { db, env } = await imported(fixture([{ id: 1, question: 'A preserved source question' }]).prepared);
  try {
    for (const params of [{ topic_id: '999' }, { topic_id: '1.0' }, { topic_id: '-1' }, { topic_id: '' }, { limit: '0' }, { limit: '31' }, { offset: '-1' }, { offset: '100001' }, { q: 'q'.repeat(2001) }, { q: Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ') }]) assert.equal((await search(env, params)).status, 400, JSON.stringify(params));
    assert.equal((await lexicalQA(new Request('https://example.test/api/qa/lexical?q=body&q=blood'), env)).status, 400);
    assert.equal((await lexicalQA(new Request('https://example.test/api/qa/lexical', { method: 'POST' }), env)).status, 405);
    env.QA_SEARCH_LIMITER = { async limit() { return { success: false }; } };
    assert.equal((await search(env)).status, 200);
    assert.equal((await search(env, { q: 'source' })).status, 429);
  } finally { db.close(); }
});

test('import validation rejects changed source, missing coverage and invented supplemental hierarchy before execution', () => {
  const source = fixture([{ id: 1, question: 'Original source' }]);
  const verify = (dataset = source.dataset, documents = source.documents, taxonomy = source.taxonomy) => validateSource(dataset, documents, taxonomy, source.sourceSha, { records: 1, topics: 1 });
  const changed = structuredClone(source.dataset); changed.records[0].answer += ' edited'; assert.throws(() => verify(changed), /hash mismatch/);
  const incomplete = structuredClone(source.dataset); incomplete.coverage.all_discovered_questions_exported = false; assert.throws(() => verify(incomplete), /coverage/);
  const invented = structuredClone(source.taxonomy); invented.topics[0].root_topic_id = 123; assert.throws(() => verify(source.dataset, source.documents, invented), /taxonomy/);
  const wrongPaths = structuredClone(source.documents); wrongPaths.records[0].topic_paths[0].topics[0].name = 'Invented'; assert.throws(() => verify(source.dataset, wrongPaths), /paths/);
  const foreignHash = structuredClone(source.taxonomy); foreignHash.source_dataset_sha256 = '0'.repeat(64); assert.throws(() => verify(source.dataset, source.documents, foreignHash), /SHA256/);
  assert.throws(() => selectDatabase({}, undefined), /explicitly/);
  const statements = buildImportStatements(source.prepared);
  assert(statements.every(statement => statement.params.length <= 100));
  assert(batchStatements(statements).every(batch => batch.length <= 40 && Buffer.byteLength(JSON.stringify({ batch })) < 512100));
  assert(statements.every(statement => !/qa_entries|vectorize|\/ai\//.test(statement.sql)));
  assert.equal(buildLexicalStatements({ query: 'of the' }), null);
});

const sourceDir = process.env.SUSCOPTS_SOURCE_DIR;
test('complete exported source roundtrip, nested counts, multi-topic dedup, phrases and long text', { skip: !sourceDir || !existsSync(`${sourceDir}/suscopts-qa.json`) }, async () => {
  const { prepared } = loadSource({ sourceDir });
  assert.deepEqual(prepared.counts, { questions: 2545, topics: 906, roots: 814, direct_memberships: 2546, closure_pairs: 1000, inclusive_memberships: 2682 });
  const { db, env, execute } = await imported(prepared);
  try {
    for (const [id, count] of [[809,2],[219,21],[751,3],[188,48],[424,19],[45,35],[406,17],[383,0],[798,0]]) assert.equal((await search(env, { topic_id: String(id) })).body.total_count, count, `topic ${id}`);
    const all = [];
    for (let offset = 0; offset < 2545; offset += 30) all.push(...(await search(env, { limit: '30', offset: String(offset) })).body.results);
    assert.equal(all.length, 2545); assert.equal(new Set(all.map(row => row.qa_id)).size, 2545); assert.equal(all.filter(row => row.qa_id === 2480).length, 1);
    for (const entry of prepared.entries) {
      const row = db.prepare('SELECT * FROM suscopts_entries WHERE qa_id=?').get(entry.qa_id);
      assert.equal(row.question, entry.question); assert.equal(row.answer, entry.answer); assert.equal(row.source_record_json, entry.source_record_json); assert.equal(row.topic_paths_json, entry.topic_paths_json);
    }
    assert.equal(all.find(row => row.qa_id === 1470).question.length, 8859);
    for (const topic of [212,253]) {
      const selected = [], first = (await search(env, { topic_id: String(topic), limit: '30' })).body;
      for (let offset = 0; offset < first.total_count; offset += 30) selected.push(...(await search(env, { topic_id: String(topic), limit: '30', offset: String(offset) })).body.results);
      assert.equal(selected.filter(row => row.qa_id === 2480).length, 1);
    }
    for (const [q, phrase, allWords, partial] of [['free will in heaven',1373,175,2],['body and blood',60,64,7],["God’s love",163,37,4]]) {
      const rows = [];
      const first = (await search(env, { q, limit: '30' })).body;
      for (let offset = 0; offset < first.total_count; offset += 30) rows.push(...(await search(env, { q, limit: '30', offset: String(offset) })).body.results);
      const pos = id => rows.findIndex(row => row.qa_id === id);
      assert.equal(rows[pos(phrase)].match_type, 'phrase'); assert.equal(rows[pos(allWords)].match_type, 'all_words'); assert.equal(rows[pos(partial)].match_type, 'some_words');
      assert(pos(phrase) < pos(allWords) && pos(allWords) < pos(partial));
      const order = { phrase: 0, all_words: 1, some_words: 2 };
      assert(rows.every((row, i) => !i || order[rows[i - 1].match_type] <= order[row.match_type]));
    }
    await executeImport(prepared, execute, { applyMigration: true });
    assert.equal(db.prepare('SELECT count(*) n FROM suscopts_entries').get().n, 2545);
    assert.equal(db.prepare('SELECT count(*) n FROM suscopts_entry_topics').get().n, 2546);
    assert.equal(db.prepare('SELECT answer FROM qa_entries WHERE id=\'legacy\'').get().answer, 'Do not change');
  } finally { db.close(); }
});
