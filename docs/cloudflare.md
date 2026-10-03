# Cloudflare deployment setup

This follows tizmagik/whatamipraying#112: GitHub Actions deploys one Worker per PR
using an exact custom domain. Cloudflare provisions DNS and HTTPS automatically;
no wildcard DNS record is required.

| Event | Worker | Hostname |
| --- | --- | --- |
| Push/merge to `main` | `cfe` | `christforeveryone.org` and `www.christforeveryone.org` |
| Open/update/reopen PR N | `cfe-pr-N` | `pr-N.christforeveryone.org` |
| Close/merge PR N | Delete `cfe-pr-N` | Remove the preview custom domain |

The apex redirects to `www`, preserving the current site's canonical URL.
Preview hostnames serve the site directly and send `X-Robots-Tag: noindex, nofollow`.
The existing HTML is unchanged. The build copies only `index.html` into `dist/`;
add future public assets explicitly in `scripts/build.mjs`.

## GitHub credentials

Configure these in `tizmagik/cfe`:

- Repository variable `CLOUDFLARE_ACCOUNT_ID`: `91511fba40bf3d2e840c3f4e74f49165`.
- Repository secret `CLOUDFLARE_API_TOKEN`: persistent Cloudflare token with
  Account → Workers Scripts → Edit for that account, plus Zone → Workers Routes → Edit,
  DNS → Edit, and Zone → Read for **christforeveryone.org only**.

Local Wrangler OAuth authentication is for local deployments; never copy its
short-lived access or refresh tokens into GitHub. Cloudflare's
[custom domain documentation](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
and [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/)
describe routing and required access.

Fork PRs cannot deploy. Workflows use `pull_request` and restrict deployments to
branches in this repository. Anyone allowed to push repository branches must be
trusted with deployment access. Each PR's deploy and teardown share a concurrency
group with cancellation disabled, so cleanup waits for active deployment.

The smoke check verifies HTTPS, rendered HTML, and the exact PR head commit via
`/.well-known/deployment` before updating the preview comment. The metadata
endpoint is uncached. Initial DNS/TLS provisioning can take several minutes.
Cleanup refuses to detach a hostname assigned to a different Worker, tolerates
already-deleted resources, and verifies that both domain and Worker are removed.
Cloudflare may retain an unused automatically issued certificate after cleanup.

## Local commands

```sh
npm ci
npm test
npm run dev
npm run build
npx wrangler deploy --dry-run
npm run deploy

PR_NUMBER=123 node scripts/preview-config.mjs
npx wrangler deploy --config wrangler.preview.json
# Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN:
PR_NUMBER=123 node scripts/delete-preview.mjs
```

## Production migration

The current GitHub Pages site remains available until the initial production
Worker takes over the apex and `www` DNS records. Preserve MX/TXT records and
unrelated subdomains. After production HTTPS is verified, disable GitHub Pages
in repository settings to avoid duplicate publishing. The old `CNAME` file is
retained as a reference and is excluded from the Worker assets.

Production automation starts once these workflows merge to `main`.
