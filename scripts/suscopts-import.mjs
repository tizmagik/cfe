import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { indexText } from '../qa-lexical.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATION_NAME = '0002_suscopts_qa.sql';
export const MIGRATION_SQL = readFileSync(resolve(ROOT, 'migrations', MIGRATION_NAME), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const numeric = value => Number.isSafeInteger(value) && value > 0;
const unique = values => new Set(values).size === values.length;
const sorted = values => [...values].sort((a, b) => a - b);
const sameIDs = (a, b) => isDeepStrictEqual(sorted(a), sorted(b));

export function validateSource(dataset, documents, taxonomy, sourceSha256, expected = { records: 2545, topics: 906 }) {
  assert(dataset && Array.isArray(dataset.records) && Array.isArray(dataset.categories), 'Supply the complete source JSON envelope.');
  assert(dataset.records.length === expected.records && dataset.record_count === expected.records, 'Source record count does not match the complete collection.');
  assert(dataset.categories.length === expected.topics, 'Source topic count does not match the complete collection.');
  const coverage = dataset.coverage;
  assert(coverage?.all_discovered_questions_exported === true && coverage?.all_category_counts_match === true &&
    ['failed_question_ids', 'category_count_mismatches', 'errors'].every(key => Array.isArray(coverage[key]) && !coverage[key].length), 'Source coverage must be complete and error-free.');
  assert(/^[a-f0-9]{64}$/.test(sourceSha256 ?? ''), 'A source file SHA256 is required.');
  assert(documents?.source_dataset_sha256 === sourceSha256 && taxonomy?.source_dataset_sha256 === sourceSha256, 'Supplemental files must refer to this exact source file SHA256.');
  assert(documents.record_count === expected.records && documents.records?.length === expected.records && taxonomy.topic_count === expected.topics && taxonomy.topics?.length === expected.topics, 'Supplemental file counts do not match the source.');
  const categoryMap = new Map(), recordMap = new Map(), documentMap = new Map(), taxonomyMap = new Map();
  for (const category of dataset.categories) {
    const id = category.source_id;
    assert(numeric(id) && !categoryMap.has(id), 'Source topics need unique positive numeric IDs.');
    assert(typeof category.name === 'string' && category.name.trim() && typeof category.url === 'string' && /^https:\/\/qa\.suscopts\.org\//.test(category.url), `Invalid source topic ${id}.`);
    assert(Array.isArray(category.parent_category_ids) && category.parent_category_ids.length <= 1 && Array.isArray(category.child_category_ids) && unique(category.child_category_ids) && Array.isArray(category.question_ids) && unique(category.question_ids), `Invalid hierarchy or membership list for topic ${id}.`);
    categoryMap.set(id, category);
  }
  for (const document of documents.records) {
    assert(numeric(document.source_id) && !documentMap.has(document.source_id), 'Duplicate supplemental question ID.');
    documentMap.set(document.source_id, document);
  }
  for (const topic of taxonomy.topics) {
    assert(numeric(topic.topic_id) && !taxonomyMap.has(topic.topic_id), 'Duplicate supplemental topic ID.');
    taxonomyMap.set(topic.topic_id, topic);
  }
  const pathCache = new Map();
  function pathFor(id, visiting = new Set()) {
    if (pathCache.has(id)) return pathCache.get(id);
    const topic = categoryMap.get(id);
    assert(topic && !visiting.has(id), `Missing topic or cycle at ${id}.`);
    visiting.add(id);
    const parent = topic.parent_category_ids[0] ?? null;
    if (parent !== null) assert(categoryMap.get(parent)?.child_category_ids.includes(id), `Parent/child lists disagree for ${id}.`);
    for (const child of topic.child_category_ids) assert(categoryMap.get(child)?.parent_category_ids[0] === id, `Child/parent lists disagree for ${id}.`);
    const path = parent === null ? [id] : [...pathFor(parent, visiting), id];
    visiting.delete(id); pathCache.set(id, path); return path;
  }
  for (const id of categoryMap.keys()) pathFor(id);
  const members = new Map([...categoryMap.keys()].map(id => [id, new Set()]));
  const inclusive = new Map([...categoryMap.keys()].map(id => [id, new Set()]));
  const entries = [];
  for (const record of dataset.records) {
    const id = record.source_id;
    assert(numeric(id) && !recordMap.has(id) && record.id === `suscopts-qa-${id}`, 'Source questions need unique original IDs.');
    assert(typeof record.question === 'string' && record.question.trim() && typeof record.answer === 'string' && record.answer.trim(), `Empty source question or answer ${id}.`);
    assert(record.source_url === `https://qa.suscopts.org/index.php?qid=${id}` && typeof record.publisher === 'string' && record.publisher.trim(), `Invalid source attribution for ${id}.`);
    assert(record.citation && record.citation.url === record.source_url && record.citation.publisher === record.publisher && typeof record.citation.text === 'string', `Missing source citation for ${id}.`);
    assert(record.content_sha256 === sha256(`${record.question}\n\n${record.answer}`) && /^[a-f0-9]{64}$/.test(record.source_html_sha256), `Source content hash mismatch for ${id}.`);
    assert(Array.isArray(record.categories) && record.categories.length > 0 && unique(record.categories.map(c => c.source_id)), `Invalid direct memberships for ${id}.`);
    const document = documentMap.get(id);
    assert(document, `Missing supplemental question ${id}.`);
    for (const [key, value] of Object.entries(record)) assert(isDeepStrictEqual(value, document[key]), `Supplemental source field changed: ${id}.${key}.`);
    const paths = record.categories.map(category => {
      const original = categoryMap.get(category.source_id);
      assert(original && category.name === original.name && category.url === original.url && category.alphabetical_index === original.alphabetical_index, `Question ${id} uses a changed or unknown source topic.`);
      const ids = pathFor(category.source_id);
      members.get(category.source_id).add(id);
      for (const ancestor of ids) inclusive.get(ancestor).add(id);
      return { topic_ids: ids, label: ids.map(topicID => categoryMap.get(topicID).name).join(' > '),
        topics: ids.map(topicID => ({ topic_id: topicID, name: categoryMap.get(topicID).name, source_url: categoryMap.get(topicID).url })) };
    });
    assert(isDeepStrictEqual(document.topic_paths, paths), `Supplemental paths disagree for question ${id}.`);
    assert(sameIDs(document.topic_ids ?? [], record.categories.map(c => c.source_id)) &&
      sameIDs(document.root_topic_ids ?? [], [...new Set(paths.map(p => p.topic_ids[0]))]) &&
      sameIDs(document.parent_topic_ids ?? [], [...new Set(record.categories.map(c => categoryMap.get(c.source_id).parent_category_ids[0]).filter(numeric))]) &&
      sameIDs(document.filter_topic_ids ?? [], [...new Set(paths.flatMap(p => p.topic_ids))]), `Supplemental filter IDs disagree for question ${id}.`);
    const sourceRecord = JSON.stringify(record);
    const topicNames = [...new Set(paths.flatMap(path => path.topics.map(topic => topic.name)))];
    const entry = { qa_id: id, id: record.id, question: record.question, answer: record.answer,
      source_url: record.source_url, publisher: record.publisher, citation_json: JSON.stringify(record.citation),
      topic_paths_json: JSON.stringify(document.topic_paths), source_record_json: sourceRecord,
      content_sha256: record.content_sha256, source_html_sha256: record.source_html_sha256,
      question_index: indexText(record.question), answer_index: indexText(record.answer), topic_names_index: topicNames.map(indexText).join(' '),
      topic_ids: record.categories.map(c => c.source_id) };
    // D1 has a 2MB row ceiling; this verifies it rather than shortening text.
    assert(Object.values(entry).filter(v => typeof v === 'string').reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) < 1900000, `Question ${id} exceeds D1's row capacity; source text was not truncated.`);
    entries.push(entry); recordMap.set(id, record);
  }
  const closure = [], topics = [];
  for (const [id, category] of categoryMap) {
    assert(sameIDs(category.question_ids, [...members.get(id)]), `Source direct question membership mismatch at topic ${id}.`);
    const path = pathFor(id), topic = taxonomyMap.get(id);
    assert(topic, `Missing supplemental topic ${id}.`);
    for (const [key, value] of Object.entries(category)) assert(isDeepStrictEqual(value, topic[key]), `Supplemental source category changed: ${id}.${key}.`);
    const descendants = [...categoryMap.keys()].filter(other => pathFor(other).includes(id));
    assert(topic.parent_topic_id === (category.parent_category_ids[0] ?? null) && topic.root_topic_id === path[0] &&
      isDeepStrictEqual(topic.topic_path_ids, path) && topic.depth === path.length - 1 &&
      sameIDs(topic.direct_topic_ids ?? [], descendants) && sameIDs(topic.descendant_topic_ids ?? [], descendants.filter(other => other !== id)) &&
      topic.direct_question_count === members.get(id).size && topic.descendant_question_count === inclusive.get(id).size,
    `Supplemental taxonomy disagrees with source topic ${id}.`);
    assert(category.extracted_question_count === members.get(id).size && category.aggregate_question_count === inclusive.get(id).size, `Source topic count mismatch at ${id}.`);
    const names = path.map(topicID => categoryMap.get(topicID).name);
    assert(isDeepStrictEqual(topic.topic_path, path.map(topicID => ({ topic_id: topicID, name: categoryMap.get(topicID).name, source_url: categoryMap.get(topicID).url }))) &&
      topic.topic_path_label === names.join(' > ') && topic.alphabetical_parent_label === category.alphabetical_index, `Supplemental topic path changed at ${id}.`);
    topics.push({ id, name: category.name, name_index: indexText(category.name), parent_id: category.parent_category_ids[0] ?? null,
      root_id: path[0], path_ids_json: JSON.stringify(path), path_names_json: JSON.stringify(names),
      question_count: inclusive.get(id).size, direct_question_count: members.get(id).size,
      source_category_json: JSON.stringify(category), depth: path.length - 1 });
    path.forEach((ancestor, position) => closure.push({ ancestor_id: ancestor, descendant_id: id, depth: path.length - position - 1 }));
  }
  const roots = topics.filter(topic => topic.parent_id === null).length;
  assert(taxonomy.root_topic_count === roots && sameIDs((taxonomy.roots ?? []).map(root => typeof root === 'number' ? root : root.topic_id), topics.filter(topic => topic.parent_id === null).map(topic => topic.id)), 'Supplemental source roots do not match.');
  const { records, categories, ...metadata } = dataset;
  return { source_sha256: sourceSha256, metadata, entries: entries.sort((a, b) => a.qa_id - b.qa_id),
    topics: topics.sort((a, b) => a.depth - b.depth || a.id - b.id), closure,
    counts: { questions: entries.length, topics: topics.length, roots,
      direct_memberships: entries.reduce((n, entry) => n + entry.topic_ids.length, 0), closure_pairs: closure.length,
      inclusive_memberships: [...inclusive.values()].reduce((n, ids) => n + ids.size, 0) } };
}

function upserts(table, columns, key, rows) {
  const statements = [], rowsPerStatement = Math.floor(96 / columns.length);
  const update = columns.filter(column => column !== key).map(column => `${column}=excluded.${column}`).join(', ');
  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const part = rows.slice(offset, offset + rowsPerStatement);
    statements.push({ sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${part.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}
      ON CONFLICT(${key}) DO UPDATE SET ${update}`,
    params: part.flatMap(row => columns.map(column => row[column])) });
  }
  return statements;
}
function deleteIncluded(table, column, ids) {
  const statements = [];
  for (let offset = 0; offset < ids.length; offset += 96) {
    const part = ids.slice(offset, offset + 96);
    statements.push({ sql: `DELETE FROM ${table} WHERE ${column} IN (${part.map(() => '?').join(',')})`, params: part });
  }
  return statements;
}
function relationInserts(table, columns, rows) {
  const statements = [], size = Math.floor(96 / columns.length);
  for (let offset = 0; offset < rows.length; offset += size) {
    const part = rows.slice(offset, offset + size);
    statements.push({ sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${part.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`,
      params: part.flatMap(row => columns.map(column => row[column])) });
  }
  return statements;
}
export function buildImportStatements(prepared, importedAt = new Date().toISOString()) {
  const topicColumns = ['id','name','name_index','parent_id','root_id','path_ids_json','path_names_json','question_count','direct_question_count','source_category_json'];
  const entryColumns = ['qa_id','id','question','answer','source_url','publisher','citation_json','topic_paths_json','source_record_json','content_sha256','source_html_sha256','question_index','answer_index','topic_names_index'];
  const statements = [
    ...upserts('suscopts_topics', topicColumns, 'id', prepared.topics),
    ...upserts('suscopts_entries', entryColumns, 'qa_id', prepared.entries),
    ...deleteIncluded('suscopts_entry_topics', 'qa_id', prepared.entries.map(entry => entry.qa_id)),
    ...relationInserts('suscopts_entry_topics', ['qa_id','topic_id'], prepared.entries.flatMap(entry => entry.topic_ids.map(topic_id => ({ qa_id: entry.qa_id, topic_id })))),
    ...deleteIncluded('suscopts_topic_closure', 'descendant_id', prepared.topics.map(topic => topic.id)),
    ...relationInserts('suscopts_topic_closure', ['ancestor_id','descendant_id','depth'], prepared.closure),
    { sql: 'INSERT INTO suscopts_entries_fts(suscopts_entries_fts, rank) VALUES (?, ?)', params: ['integrity-check', 1] },
    { sql: 'INSERT INTO suscopts_topics_fts(suscopts_topics_fts, rank) VALUES (?, ?)', params: ['integrity-check', 1] },
    { sql: `INSERT INTO suscopts_collection(id, source_sha256, source_metadata_json, question_count, topic_count, imported_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source_sha256=excluded.source_sha256,
      source_metadata_json=excluded.source_metadata_json, question_count=excluded.question_count, topic_count=excluded.topic_count, imported_at=excluded.imported_at`,
    params: ['suscopts-qa', prepared.source_sha256, JSON.stringify(prepared.metadata), prepared.counts.questions, prepared.counts.topics, importedAt] },
  ];
  assert(statements.every(statement => statement.params.length <= 100 && Buffer.byteLength(statement.sql) < 100000), 'An import statement exceeds D1 limits.');
  return statements;
}
export function batchStatements(statements, maxStatements = 40, maxBytes = 512000) {
  const batches = []; let batch = [], bytes = 0;
  for (const statement of statements) {
    const size = Buffer.byteLength(JSON.stringify(statement)) + 1;
    assert(size <= maxBytes, 'An import statement exceeds the bounded request size.');
    if (batch.length && (batch.length >= maxStatements || bytes + size > maxBytes)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(statement); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export function loadSource({ sourceDir, source, documents, taxonomy }) {
  const sourcePath = resolve(source ?? resolve(sourceDir, 'suscopts-qa.json'));
  const sourceBytes = readFileSync(sourcePath);
  const docsPath = resolve(documents ?? resolve(sourceDir ?? dirname(sourcePath), 'embeddings-openai', 'search-documents.json'));
  const taxonomyPath = resolve(taxonomy ?? resolve(sourceDir ?? dirname(sourcePath), 'embeddings-openai', 'taxonomy.json'));
  const docsBytes = readFileSync(docsPath), taxBytes = readFileSync(taxonomyPath);
  const prepared = validateSource(JSON.parse(sourceBytes), JSON.parse(docsBytes), JSON.parse(taxBytes), sha256(sourceBytes));
  return { prepared, files: { source_sha256: prepared.source_sha256, documents_sha256: sha256(docsBytes), taxonomy_sha256: sha256(taxBytes) } };
}
export function selectDatabase(config, target) {
  assert(['preview', 'production'].includes(target), 'Choose --target preview or production explicitly.');
  const selected = target === 'preview' ? config.env?.preview : config;
  const binding = selected?.d1_databases?.find(database => database.binding === 'QA_DB');
  assert(config.account_id && binding?.database_id, 'No QA_DB database is configured for this target.');
  return { account_id: config.account_id, database_id: binding.database_id, database_name: binding.database_name };
}
export async function executeImport(prepared, execute, { applyMigration = false, importedAt = new Date().toISOString() } = {}) {
  // Build and bound every write before applying even the migration.
  const statements = buildImportStatements(prepared, importedAt), batches = batchStatements(statements);
  if (applyMigration) {
    await execute([{ sql: MIGRATION_SQL, params: [] }]);
    await execute([{ sql: 'INSERT OR IGNORE INTO d1_migrations(name) VALUES (?)', params: [MIGRATION_NAME] }]);
  }
  for (const batch of batches) await execute(batch);
  const verification = await execute([{ sql: `SELECT (SELECT count(*) FROM suscopts_entries) AS questions,
    (SELECT count(*) FROM suscopts_topics) AS topics, (SELECT count(*) FROM suscopts_entry_topics) AS direct_memberships,
    (SELECT count(*) FROM suscopts_topic_closure) AS closure_pairs,
    (SELECT count(*) FROM (SELECT DISTINCT closure.ancestor_id, membership.qa_id FROM suscopts_topic_closure closure
      JOIN suscopts_entry_topics membership ON membership.topic_id=closure.descendant_id)) AS inclusive_memberships,
    (SELECT source_sha256 FROM suscopts_collection WHERE id='suscopts-qa') AS source_sha256`, params: [] }]);
  const actual = verification?.[0]?.results?.[0];
  assert(actual && actual.source_sha256 === prepared.source_sha256 && ['questions','topics','direct_memberships','closure_pairs','inclusive_memberships'].every(key => actual[key] === prepared.counts[key]), 'Post-import counts/hash differ from the complete collection; investigate before deploying. Unrelated records were not deleted.');
  return { counts: prepared.counts, statement_count: statements.length, batch_count: batches.length, source_sha256: prepared.source_sha256, verified: true };
}

function argumentsFor(args) {
  const options = { dryRun: false, applyMigration: false };
  const values = { '--source-dir': 'sourceDir', '--source': 'source', '--documents': 'documents', '--taxonomy': 'taxonomy', '--target': 'target', '--local': 'local', '--config': 'config', '--receipt': 'receipt' };
  for (let cursor = 0; cursor < args.length; cursor++) {
    const arg = args[cursor];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--apply-migration') options.applyMigration = true;
    else if (values[arg]) {
      assert(args[cursor + 1] && !args[cursor + 1].startsWith('--') && options[values[arg]] === undefined, `Supply ${arg} once with a value.`);
      options[values[arg]] = args[++cursor];
    } else throw new Error('Usage: node scripts/suscopts-import.mjs --source-dir DIRECTORY --target preview|production [--dry-run | --local FILE] [--apply-migration] [--receipt FILE]. Or supply --source FILE --documents FILE --taxonomy FILE.');
  }
  assert(options.sourceDir || options.source, 'Supply --source-dir or --source.');
  assert(!(options.sourceDir && options.source), 'Choose --source-dir or --source.');
  return options;
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const resources = selectDatabase(JSON.parse(readFileSync(resolve(options.config ?? resolve(ROOT, 'wrangler.jsonc')), 'utf8')), options.target);
  const { prepared, files } = loadSource(options);
  const importedAt = new Date().toISOString();
  let receipt = { collection: 'suscopts-qa', target: options.target, database_name: resources.database_name, ...files, counts: prepared.counts, imported_at: importedAt };
  if (options.dryRun) {
    const statements = buildImportStatements(prepared, importedAt);
    receipt = { ...receipt, mode: 'dry-run', statement_count: statements.length, batch_count: batchStatements(statements).length, validated: true, writes_performed: false };
  } else {
    let execute, localDB;
    if (options.local) {
      const { DatabaseSync } = await import('node:sqlite');
      localDB = new DatabaseSync(resolve(options.local));
      localDB.exec('PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);');
      execute = async batch => {
        localDB.exec('BEGIN');
        try {
          const results = batch.map(({ sql, params }) => {
            if (!params.length && sql === MIGRATION_SQL) { localDB.exec(sql); return { success: true, results: [] }; }
            const statement = localDB.prepare(sql);
            const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
            return { success: true, results: rows };
          });
          localDB.exec('COMMIT'); return results;
        } catch (error) { localDB.exec('ROLLBACK'); throw error; }
      };
    } else {
      const token = process.env.CLOUDFLARE_API_TOKEN;
      assert(token, 'Set CLOUDFLARE_API_TOKEN in the environment before a remote import.');
      execute = async batch => {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${resources.account_id}/d1/database/${resources.database_id}/query`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch }), signal: AbortSignal.timeout(60000),
        });
        let payload;
        try { payload = await response.json(); } catch { throw new Error(`D1 import request failed (${response.status}).`); }
        assert(response.ok && payload.success !== false && Array.isArray(payload.result) && payload.result.every(result => result.success !== false), `D1 import request failed (${response.status}); verify access and rerun the idempotent import.`);
        return payload.result;
      };
    }
    try { receipt = { ...receipt, mode: options.local ? 'local' : 'remote', ...(await executeImport(prepared, execute, { applyMigration: options.applyMigration, importedAt })), writes_performed: true }; }
    finally { localDB?.close(); }
  }
  if (options.receipt) writeFileSync(resolve(options.receipt), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
