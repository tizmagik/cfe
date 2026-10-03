import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function previewConfig(base, pr) {
  if (!/^[1-9]\d*$/.test(pr ?? "")) throw new Error("PR_NUMBER must be a positive integer");
  return {
    ...base,
    name: `cfe-pr-${pr}`,
    routes: [{ pattern: `pr-${pr}.christforeveryone.org`, custom_domain: true }],
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = previewConfig(JSON.parse(readFileSync("wrangler.jsonc", "utf8")), process.env.PR_NUMBER);
  writeFileSync("wrangler.preview.json", JSON.stringify(config, null, 2) + "\n");
}
