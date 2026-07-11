#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../dist/handoff");
const files = await filesUnder(root);
const required = ["_headers", "index.html", "robots.txt"];
for (const name of required) {
  if (!files.some((file) => file === join(root, name))) {
    throw new Error(`handoff artifact is missing ${name}`);
  }
}

const textFiles = files.filter((file) =>
  [".css", ".html", ".js", ".txt", ""].includes(extname(file)),
);
const texts = await Promise.all(
  textFiles.map(async (file) => ({ file, text: await readFile(file, "utf8") })),
);
const forbidden = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bserviceWorker\b/,
  /https?:\/\//,
];
for (const { file, text } of texts) {
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      throw new Error(`handoff artifact ${file} contains forbidden ${pattern}`);
    }
  }
}

const headers = await readFile(join(root, "_headers"), "utf8");
for (const directive of [
  "default-src 'none'",
  "connect-src 'none'",
  "frame-ancestors 'none'",
  "Referrer-Policy: no-referrer",
  "X-Frame-Options: DENY",
]) {
  if (!headers.includes(directive)) {
    throw new Error(`handoff headers are missing ${directive}`);
  }
}

console.log(
  `handoff artifact verified: ${files.length} files, no network/storage primitives`,
);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}
