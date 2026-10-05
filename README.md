# Christ for Everyone

Static website at <https://christforeveryone.org>, with the existing canonical
hostname <https://www.christforeveryone.org>.

## Development

Use Node.js 24, then run `npm ci` and `npm run dev`.
Edit `index.html` or the Q&A page in `qa/`; `npm run build` copies the website into `dist/`.
Only site files are published, keeping repository files out of the public assets.
Run `npm test` for deployment and preview isolation checks.

## Deployments

Pushes or merges to `main` deploy the `cfe` Cloudflare Worker.
Opening, updating, or reopening an in-repository PR deploys `cfe-pr-N` at
`https://pr-N.christforeveryone.org`. Closing or merging the PR removes its
Worker and custom domain. Previews are public and send a `noindex` header.

See [Cloudflare setup](docs/cloudflare.md) for credentials and local commands.

## Q&A backend

Cloudflare Vectorize, Workers AI embeddings, and D1 support curated English Q&A
similarity search at `/api/qa/search`. See [Q&A setup and data handoff](docs/qa.md)
for the JSON format, import command, API contract, preview isolation and costs.

The [Questions & Answers page](https://www.christforeveryone.org/qa/) searches the
SUSCopts source collection lexically and provides the original topic tree. Full
query phrases rank above matches on significant individual words. See
[SUSCopts data and lexical search](docs/suscopts-qa.md) for the source import,
D1 migration, ranking rules and local development.
