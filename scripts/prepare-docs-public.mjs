import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(repoRoot, "scripts/install.sh");
const target = resolve(repoRoot, "docs/public/install.sh");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
chmodSync(target, 0o755);
