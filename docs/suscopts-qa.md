# SUSCopts source Q&A collection

This collection provides local word search and topic browsing for the complete public linked Q&A export from [qa.suscopts.org](https://qa.suscopts.org/). It contains 2,545 questions, 906 original topics (including empty topics), 814 roots, 2,546 direct memberships, 1,000 ancestor/descendant closure pairs, and 2,682 unique inclusive question/topic memberships. Q&A #2480 belongs directly to both source topics 212 and 253 and appears once in an unfiltered response.

The source requires attribution. Display the returned citation and link to each original `source_url`. Answers are original source text, not newly generated advice. Treat returned question/answer strings as plain text. Original HTML is retained in the stored source record for preservation; sanitize it before any optional HTML rendering.

## Storage and isolation

Migration `migrations/0002_suscopts_qa.sql` creates only `suscopts_` tables, indexes, triggers, and FTS5 collections. The existing `qa_entries`, Workers AI model, Vectorize index, and semantic search endpoint are independent. Neither this migration nor this importer calls AI or Vectorize.

`suscopts_entries` preserves the complete original record in `source_record_json`, including original HTML, hashes, attribution, extraction notes, encoding metadata, links, and source nulls. Separate columns retain the full original question, answer, source URL, publisher, citation JSON, and verified topic paths. Original strings are never trimmed or truncated on import. Only separate FTS index columns are normalized to lowercase alphanumeric tokens with diacritics removed. Topic names remain original in the public response and source metadata.

`suscopts_topics` retains each full source category JSON, original ID/name/parent/root/path, and unique direct/inclusive question counts. `suscopts_entry_topics` stores direct memberships; `suscopts_topic_closure` includes the topic itself and its descendants. Filtering uses `EXISTS` over those relations so multi-topic questions cannot duplicate. The A–Z index is source metadata and is not a topical root or parent. For example, Baptism (45) and Infant Baptism (208) are separate source roots. The source permits duplicate topic names: Divine Liturgy (243) is a root; Divine Liturgy (454) is a child of Nativity (453).

FTS5 external-content indexes are updated by insert/update/delete triggers, including idempotent import reruns. A separate topic-name FTS index checks complete phrases within one source label, so a phrase cannot accidentally span two labels. [Cloudflare D1 documents FTS5 support](https://developers.cloudflare.com/d1/sql-api/sql-statements/); [SQLite describes phrase search and weighted BM25](https://www.sqlite.org/fts5.html).

## API

The Worker dispatches to `lexicalQA(request, env)` and `topicsQA(request, env)` from `qa-lexical.js`, using `env.QA_DB`.

`GET /api/qa/topics` returns:

```json
{"topics":[{"id":383,"name":"Theosis","parent_id":null,"root_id":383,"path_ids":[383],"path_names":["Theosis"],"question_count":0,"direct_question_count":0}],"question_count":2545}
```

The example shows one original topic; the endpoint returns all 906 topics, sorted by numeric source ID.

`GET /api/qa/lexical?topic_id=383&limit=10&offset=0` returns:

```json
{"query":"","topic_id":383,"total_count":0,"offset":0,"limit":10,"results":[],"significant_terms":[]}
```

Each result contains `id` (stable `suscopts-qa-N`), `qa_id` (original numeric ID), `question`, `answer`, `source_url`, `publisher`, `citation`, `topic_paths`, `match_type`, and `matched_terms`. Citation and topic-path objects are preserved from the validated source. `match_type` is `phrase`, `all_words`, or `some_words` for search; it is `null` when browsing. `matched_terms` follows the query's distinct significant-word order.

Omit or leave `q` blank to browse all questions in ascending source-ID order without a search charge or search rate-limit call. Omit `topic_id` for all questions, or pass any original topic ID to include the topic and all descendants. Unknown or malformed IDs return 400. `limit` defaults to 10 and accepts 1–30. `offset` defaults to 0 and accepts 0–100,000. Search text accepts at most 2,000 characters and 24 different significant words. Duplicate query parameters are rejected. POST is rejected with 405. Responses are JSON, `no-store`, and `noindex`.

Search covers full questions, full answers, and original topic names along the question's source paths. Ranking always places a complete normalized whole-query phrase first, then all significant words, then some significant words. Within a tier it orders by matched-word count, weighted FTS5 BM25 (question 8, answer 1, topic names 3), then original source ID. The phrase includes stopwords even though fallback terms omit common English words, single-letter alphabetic tokens, and contraction suffixes. Repeated words count once in fallback ranking. Case, curly apostrophes, diacritics, and punctuation are normalized consistently. Word matches are whole tokens, not arbitrary substring or stemming matches. A nonblank query containing only common words or punctuation returns zero results. User text is tokenized, quoted, and passed as bound MATCH parameters; operator text cannot control FTS syntax or SQL.

The optional existing `QA_SEARCH_LIMITER` protects nonblank searches. Blank browsing and the topics endpoint do not consume that limiter. Search failures return generic errors without database or credential details.

## Validate and import

Use Node 24+ for the optional SQLite test/local-import path. The importer itself has no external runtime packages. Source files are supplied separately; they are not copied into this repository.

```sh
node scripts/suscopts-import.mjs \
  --source-dir /path/to/suscopts-qa-2026-10-03 \
  --target preview --dry-run
```

The source directory must contain `suscopts-qa.json`, `embeddings-openai/search-documents.json`, and `embeddings-openai/taxonomy.json`. Alternatively pass explicit `--source`, `--documents`, and `--taxonomy` files. The target is mandatory even for local/dry-run operations, and resolves `QA_DB` from `wrangler.jsonc` (`--config` can override that file). Production and preview are separate databases.

Before any write the importer validates complete coverage, every content hash, the supplemental source-file SHA256, every original record field, all source category fields, source memberships, hierarchy reciprocity/cycles, every path, ancestor expansion, and all counts. It verifies D1's row-size limit and refuses oversized records instead of shortening them.

To validate a real SQLite import locally:

```sh
node scripts/suscopts-import.mjs \
  --source-dir /path/to/suscopts-qa-2026-10-03 \
  --target preview --local /tmp/suscopts-qa.sqlite --apply-migration
```

For the authorized remote import, provide `CLOUDFLARE_API_TOKEN` through the environment. The importer never reads token files, shells out to retrieve credentials, or prints a token. Choose the target deliberately:

```sh
node scripts/suscopts-import.mjs \
  --source-dir /path/to/suscopts-qa-2026-10-03 \
  --target preview --apply-migration --receipt /tmp/suscopts-preview-import.json
```

`--apply-migration` first applies the idempotent prefixed migration and then records `0002_suscopts_qa.sql` in `d1_migrations`. If migration was already applied through Wrangler, omit that flag. Only after full input validation does either path perform any writes. The importer upserts full source topics parent-first and full records, then reconciles relation rows for those imported IDs, checks both FTS indexes against their external content, records source metadata/hash, and verifies exact final counts and hash. No record is deleted, and existing `qa_entries` rows are untouched. Relation reconciliation deletes only relations of imported IDs inside the new source collection. No omission-driven deletion is performed on unrelated records.

Each statement uses at most 96 bound values and stays below the [D1 statement limits](https://developers.cloudflare.com/d1/platform/limits/). Requests use [the D1 REST batch API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) with at most 40 statements and approximately 512KB of serialized statements. Each successful batch commits; an interrupted import can be rerun. The entire multi-batch import is not one database transaction: complete and verify it before exposing a newly imported collection. A receipt is written only after successful verification and includes counts, source file hashes, target/database name, and import time.

Run the focused tests with:

```sh
node --test scripts/suscopts.test.mjs
```

Tests execute the migration, triggers, import plans, and real FTS5 SQL using Node's SQLite module. They cover phrase precedence, field weights, topic-label phrase boundaries, injection and request guards, blank browse, empty topics, inclusive filtering, duplicate memberships, pagination, source JSON preservation, long questions, answers over 20,000 characters, import reruns, and legacy collection isolation. Set `SUSCOPTS_SOURCE_DIR` to the complete source directory to run the full 2,545-question roundtrip test; it is skipped when the external source export is unavailable.
