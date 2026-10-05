# Q&A search infrastructure

Cloudflare resources are provisioned in account `91511fba40bf3d2e840c3f4e74f49165`.

| Purpose | Production | Preview |
| --- | --- | --- |
| Vectorize index (384 dimensions, cosine) | `cfe-qa` | `cfe-qa-preview` |
| D1 database | `cfe-qa` | `cfe-qa-preview` |
| Worker bindings | `QA_INDEX`, `QA_DB`, `AI`, `QA_SEARCH_LIMITER` | Same names, separate resources |

All PR Workers use the shared preview collection, never production. Preview data
persists when PR Workers are removed. Use public, non-sensitive test content here.
Production starts empty; the preview collection contains the two examples from
`data/qa.example.json`, based on the existing website.

This change supplies the backend and import tooling. The existing landing page
stays intact; the colleague building the Q&A section can call the API below.

## Data handoff and import

Prepare a JSON array following [the example](../data/qa.example.json):

```json
[
  {
    "id": "stable-question-id",
    "question": "A question in English?",
    "aliases": ["Another way to ask the same question?"],
    "answer": "The complete reviewed answer, as plain text.",
    "source": "https://example.org/reference",
    "published": true
  }
]
```

- Keep IDs stable: 1–64 lowercase letters, numbers, hyphens or underscores.
- Question and optional aliases together may contain up to 500 characters.
  We embed this concise search text, rather than truncating long answers into the
  embedding model's 512-token window. Choose aliases that reflect likely queries.
- Answers may contain up to 20,000 characters and are stored in full in D1.
- Source is an optional http(s) URL. Render answers with `textContent`, and validate
  source links in the UI; do not render imported answers as raw HTML.
- `published` is required. Set it to `false` to save a draft or unpublish an entry.
  Only reviewed, intentionally public answers should be marked `true`.
- Each import accepts 1–1,000 entries. Split larger collections into files.

Use Node 24 and `npm ci`, then authenticate using `npx wrangler login` (an account
member with appropriate permissions) or a local `CLOUDFLARE_API_TOKEN` with
account-scoped Workers AI Read, Vectorize Write, and D1 Edit permissions.
Do not use the GitHub deployment token for data imports or share tokens in chat.
The importer captures the Wrangler credential in memory without printing it.

```sh
npm run qa:import -- data/qa.example.json --target preview
npm run qa:import -- /path/to/reviewed-qa.json --target production
```

The target is mandatory. Importing the same IDs updates their records and vectors;
omitting an ID does **not** delete it. To remove an entry from public search, import
that record with `published: false`. Run one import at a time for each collection.

Vectorize writes are asynchronous. The command reports mutation IDs when accepted;
wait for indexing and verify a representative search before considering it live.
On failure, rerun the same file: upserts are repeatable. Search compares the vector
revision with the D1 revision, hiding mismatches during partial imports or updates.
There is no public data-write/admin endpoint. Imports run through Cloudflare's
authenticated APIs.

## Import embeddings generated offline

### Regenerate OpenAI embeddings with Cloudflare

For an export generated with `text-embedding-3-large`, use `--regenerate` to
explicitly discard the supplied vectors and create new 384-dimension BGE vectors
from each question and its aliases. This accepts either a plain entry array or
the export envelope below. Full answer text remains in D1.

```sh
npm run qa:import -- /path/to/openai-export.json --target preview --regenerate
npm run qa:import -- /path/to/openai-export.json --target production --regenerate
```

This requires Cloudflare Workers AI Read in addition to D1 Edit and Vectorize
Edit/Write, or an authorized local `wrangler login` session. The colleague's
`CFE Q&A Offline Imports` token currently has D1 and Vectorize access only: it can
import compatible precomputed vectors, but cannot call Workers AI to regenerate
them. An authorized account operator can run the regeneration command.

The deployed search Worker uses its AI binding and needs no OpenAI API key.
The active indexes remain `cfe-qa` and `cfe-qa-preview` at 384 dimensions. Empty
`cfe-qa-1536` and `cfe-qa-preview-1536` indexes were provisioned while evaluating
reuse of the OpenAI vectors; they are unused and incur no vector storage usage.

### Preserve compatible offline embeddings

The same command accepts a precomputed export. Wrap the entries in an object with
`embeddingProfile`, and add a `vector` array to each published entry. The importer
uploads those vectors unchanged and skips Workers AI embedding generation entirely.
It still stores the full answers in D1 and manages publication and revision checks.

The following example is **abbreviated**: replace the three sample numbers with
the complete 384-element vector from the offline export before importing.

```json
{
  "embeddingProfile": {
    "model": "@cf/baai/bge-small-en-v1.5",
    "dimensions": 384,
    "pooling": "mean",
    "metric": "cosine"
  },
  "entries": [
    {
      "id": "stable-question-id",
      "question": "A question in English?",
      "answer": "The complete reviewed answer.",
      "published": true,
      "vector": [0.12, -0.04, 0.08]
    }
  ]
}
```

```sh
npm run qa:import -- /path/to/qa-with-vectors.json --target preview
npm run qa:import -- /path/to/qa-with-vectors.json --target production
```

Each vector must have exactly 384 finite numeric values and be nonzero. Drafts
(`published: false`) can omit the vector. Validation runs before any remote writes.
Changing a vector also changes the revision used to keep search results consistent.
Offline-only imports require Vectorize Write and D1 Edit; Workers AI access is
unnecessary for importing them (the deployed search Worker still embeds queries).

**Confirm the actual offline model before importing.** The profile is a declaration
of how the vectors were generated, not a conversion instruction. Matching dimension
counts alone does not establish compatibility. Current search uses Cloudflare's
`@cf/baai/bge-small-en-v1.5` with `mean` pooling; offline exports must use compatible
weights, pooling and preprocessing. Do not relabel embeddings from another model to
pass validation. If the colleague used another model or pooling mode, configure
matching query-time inference and, when dimensions differ, provision a matching
index first. The importer rejects incompatible profiles rather than mixing spaces.

Plain JSON arrays remain supported for generating new embeddings. Supplying
`vector` in that legacy format is rejected so existing offline work cannot be
silently ignored and regenerated.

## Search API

```text
GET https://www.christforeveryone.org/api/qa/search?q=Can%20I%20join%20Bible%20study%3F&limit=5
GET https://pr-N.christforeveryone.org/api/qa/search?q=Can%20I%20join%3F
```

`q` is required (1–500 normalized characters). `limit` defaults to 5 and accepts
integers from 1 to 10. Results are ranked by cosine similarity:

```json
{
  "query": "Can I join?",
  "results": [
    {
      "id": "bible-study-welcome",
      "question": "Can I attend Bible study if I have never read the Bible?",
      "answer": "Everyone is welcome...",
      "source": "https://www.christforeveryone.org/",
      "score": 0.86
    }
  ]
}
```

Scores indicate similarity, not factual certainty. `QA_MIN_SCORE` starts at 0.65;
evaluate it with representative questions after real data arrives. Unrelated
queries, unpublished records, or an empty collection return `results: []`.
The client should show a friendly no-results message. The API retrieves curated
answers; it does not generate theological answers.

Invalid input returns 400; unsupported methods 405; excessive requests 429 with
`Retry-After`; dependency/quota failures 503. Unknown `/api/` routes return 404.
The apex domain redirects to www, as before. Use the www URL directly in clients.

Search is limited to 20 requests per minute per IP per Cloudflare location. IPs
can be shared (for example church Wi-Fi); tune this if legitimate usage is blocked.
Cloudflare's limiter is approximate and is not a global spending cap.
Responses use `no-store` so unpublishing is not delayed by cached answers.
Visitor questions and answer text are not explicitly logged by the application.

## Cost and model

The model is `@cf/baai/bge-small-en-v1.5`, 384 dimensions, explicitly using `mean`
pooling for both imports and queries. Changing model, pooling, or search-text
preprocessing requires re-embedding the entire collection; different dimensions
or distance metrics also require a new index.

At 100 entries, each collection stores 38,400 vector dimensions. Even 10,000
searches per month plus 100 inserted vectors use about 3.88 million queried
dimensions, comfortably within the current Vectorize Free allowances of 5 million
stored dimensions and 30 million queried dimensions per month. These allowances
are account-wide and shared with previews and other projects.

Workers AI includes 10,000 neurons per day; the selected embedding model's listed
price is $0.0202 per million input tokens before the free allowance. D1 Free
includes 5 million rows read/day, 100,000 written/day, and 5 GB total storage.
An empty collection does not call Workers AI. No paid plan was purchased for this
setup. Modest traffic should have no incremental service cost within the shared
allowances; paid-account overages can still incur usage charges.

Pricing checked October 4, 2026:
[Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/),
[Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[embedding model](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/).

## Schema and development

Both remote databases already have `migrations/0001_qa.sql` applied. For future
schema changes, apply migrations before deploying dependent code:

```sh
npx wrangler d1 migrations apply QA_DB --remote --env=""
npx wrangler d1 migrations apply QA_DB --remote --env preview
```

Schema migrations are deliberately run by an authorized operator, not by PR CI;
the deployment token does not receive database write access for data imports.

For local schema work, use `npx wrangler d1 migrations apply QA_DB --local --env preview`.
Local D1 does not contain the remote imported records, and Vectorize has no local
simulator. Use deployed PR previews for end-to-end search tests. `npm test` verifies
validation, publication/revision safety, import ordering and resource isolation.
The build's asset allow-list publishes only `index.html`; imported JSON files,
migrations and tools are not public assets.
