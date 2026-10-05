import { mkdir, rm, copyFile } from "node:fs/promises";

// Publish site files only; repository files and credentials must never be assets.
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await copyFile("index.html", "dist/index.html");
await mkdir("dist/qa", { recursive: true });
for (const file of ["index.html", "qa.css", "qa-client.js"]) {
  await copyFile(`qa/${file}`, `dist/qa/${file}`);
}
