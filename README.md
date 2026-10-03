# Christ for Everyone

Static website at <https://christforeveryone.org>, with the existing canonical
hostname <https://www.christforeveryone.org>.

## Development

Use Node.js 24, then run `npm ci` and `npm run dev`.
Edit `index.html`; `npm run build` copies the website into `dist/`.
Only site files are published, keeping repository files out of the public assets.
Run `npm test` for deployment and preview isolation checks.

## Deployments

Pushes or merges to `main` deploy the `cfe` Cloudflare Worker.
Opening, updating, or reopening an in-repository PR deploys `cfe-pr-N` at
`https://pr-N.christforeveryone.org`. Closing or merging the PR removes its
Worker and custom domain. Previews are public and send a `noindex` header.

See [Cloudflare setup](docs/cloudflare.md) for credentials and local commands.
