import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function previewConfig(base, pr) {
  if (!/^[1-9]\d*$/.test(pr ?? "")) throw new Error("PR_NUMBER must be a positive integer");
  if ((base.d1_databases || base.vectorize) && !base.env?.preview?.d1_databases?.length) {
    throw new Error('Preview data bindings are required; refusing to inherit production resources');
  }
  return {
    ...base,
    ...base.env?.preview,
    env: undefined,
    name: `cfe-pr-${pr}`,
    routes: [{ pattern: `pr-${pr}.christforeveryone.org`, custom_domain: true }],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = previewConfig(JSON.parse(readFileSync("wrangler.jsonc", "utf8")), process.env.PR_NUMBER);
  writeFileSync("wrangler.preview.json", JSON.stringify(config, null, 2) + "\n");
}
