import { mkdir, rm, copyFile } from "node:fs/promises";

// Publish site files only; repository files and credentials must never be assets.
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await copyFile("index.html", "dist/index.html");
