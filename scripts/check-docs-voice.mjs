#!/usr/bin/env node
// Gate: no em-dash (U+2014) in our prose voice on published docs pages.
//
// Rule: process/writing-guide.md — "No em-dashes in published marketing or docs
// copy. Use parentheses, colons, or periods."
//
// Ruled 2026-07-17 (iris), and already written in 2153498c (#346, 2026-07-02):
//   "Activity events reference: removed prose em-dashes per writing guide
//    (table empty-cell markers kept)"
// The rule governs OUR VOICE, not every U+2014 on the page. A table's n/a
// marker, a fenced code block and an inline code span are depicted or
// structural glyphs, not copy. The rule's own remedy ("use parentheses, colons,
// or periods") is incoherent for an empty table cell, which is how you know the
// rule was never about them.
//
// Design constraints, each paid for by a real misfire on 2026-07-17:
//  1. Prove we READ the artifact before counting. A failed read plus a count of
//     zero is indistinguishable from a clean pass: 0 is the pass value. So
//     assert bytes > 0 per file and a non-empty published set, and self-test the
//     classifier on every run.
//  2. State BOTH units: occurrences (not lines — `grep -c` reads 35 where
//     `grep -o | wc -l` reads 48 on the same file), and the object counted
//     (prose, not placeholders — 48 occurrences OF WHAT).
//  3. Negative control against the REAL artifact, every run, not once by hand.
//     Untested green is not green.
//  4. Never gate a multi-word phrase: grep is line-based and prose reflows, so a
//     phrase silently splits across a newline and reports absent. Single
//     characters survive reflow.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EM_DASH = "—";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(repoRoot, "docs");
const configPath = join(docsRoot, ".vitepress", "config.ts");

/**
 * Count em-dashes in our prose voice, and separately the exempt glyphs.
 * Exempt: whole-cell table placeholders (`| — |`), fenced code, inline code.
 */
export function classify(text) {
  let prose = 0;
  let placeholder = 0;
  let code = 0;
  let inFence = false;

  for (const rawLine of text.split("\n")) {
    const fenceMatch = /^\s*(```|~~~)/.exec(rawLine);
    if (fenceMatch) {
      inFence = !inFence;
      code += countOf(rawLine);
      continue;
    }
    if (inFence) {
      code += countOf(rawLine);
      continue;
    }

    // Inline code spans are depicted, not spoken.
    let line = rawLine;
    line = line.replace(/`[^`]*`/g, (span) => {
      code += countOf(span);
      return " ".repeat(span.length);
    });

    if (line.trimStart().startsWith("|")) {
      for (const cell of line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")) {
        const value = cell.trim();
        if (value === EM_DASH) placeholder += 1;
        else prose += countOf(value);
      }
      continue;
    }

    prose += countOf(line);
  }

  return { code, placeholder, prose };
}

function countOf(text) {
  let n = 0;
  for (const ch of text) if (ch === EM_DASH) n += 1;
  return n;
}

/**
 * Published = every docs/**\/*.md not matched by srcExclude.
 * NOT nav membership: docs/index.md is in no nav entry and is the homepage.
 * NOT presence in dist/: gitignored, never in CI, stale by a different amount
 * on every machine.
 */
function publishedPages() {
  const config = readFileSync(configPath, "utf8");
  const excludeMatch = /srcExclude:\s*\[([^\]]*)\]/.exec(config);
  if (!excludeMatch) {
    fail(
      `could not read srcExclude from ${relative(repoRoot, configPath)}. The ` +
        `published set is derived from it; refusing to guess.`,
    );
  }
  const excluded = [...excludeMatch[1].matchAll(/["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
  if (excluded.length === 0) {
    fail(
      `srcExclude parsed as empty. Refusing to treat every page as published.`,
    );
  }

  const prefixes = excluded.map((glob) => glob.replace(/\/\*\*.*$/, "/"));
  const pages = [];
  walk(docsRoot);
  return { excluded, pages: pages.sort() };

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === ".vitepress") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const rel = relative(docsRoot, full);
      if (prefixes.some((p) => rel.startsWith(p))) continue;
      pages.push(rel);
    }
  }
}

/**
 * Constraint 1 + 3: the classifier must demonstrate, on every run, that it can
 * see a violation. A gate that has never been shown to go red is not a gate.
 * Fixtures are synthetic; the real-artifact control lives in runControls().
 */
function selfTest() {
  const cases = [
    ["prose is seen", `A sentence ${EM_DASH} with a dash.`, { prose: 1 }],
    [
      "placeholder is exempt",
      `| a | ${EM_DASH} | b |`,
      { placeholder: 1, prose: 0 },
    ],
    ["prose inside a cell is seen", `| a ${EM_DASH} b | c |`, { prose: 1 }],
    [
      "fenced code is exempt",
      ["```", `sh ${EM_DASH} out`, "```"].join("\n"),
      { code: 1, prose: 0 },
    ],
    [
      "inline code is exempt",
      `Text \`x ${EM_DASH} y\` more.`,
      { code: 1, prose: 0 },
    ],
    ["clean prose is zero", "Nothing here at all.", { prose: 0 }],
  ];
  for (const [name, input, expected] of cases) {
    const got = classify(input);
    for (const [key, value] of Object.entries(expected)) {
      if (got[key] !== value) {
        fail(
          `classifier self-test failed: ${name} — expected ${key}=${value}, ` +
            `got ${key}=${got[key]}. The instrument is broken; its counts mean ` +
            `nothing. Fix the classifier before trusting any number below.`,
        );
      }
    }
  }
}

/**
 * Constraint 3, on the real artifact rather than a fixture: inject an em-dash
 * into a live published page and require the count to move. This is what turns
 * "it printed 0" into "it printed 0 and it can print 1".
 */
function runControls(pages) {
  const anchor = pages.find((p) => p === "index.md") ?? pages[0];
  const text = readFileSync(join(docsRoot, anchor), "utf8");
  const base = classify(text).prose;

  const proseLine = text
    .split("\n")
    .findIndex(
      (line) =>
        line.trim().length > 0 &&
        !line.trimStart().startsWith("|") &&
        !line.trimStart().startsWith("```") &&
        !line.trimStart().startsWith("#") &&
        !line.includes("`"),
    );
  if (proseLine === -1) {
    fail(
      `no prose line found in ${anchor} to run the negative control against.`,
    );
  }
  const lines = text.split("\n");
  lines[proseLine] = `${lines[proseLine]} ${EM_DASH}`;
  const injected = classify(lines.join("\n")).prose;

  if (injected !== base + 1) {
    fail(
      `negative control failed on ${anchor}: injected one ${EM_DASH} into a ` +
        `prose line, expected prose ${base} -> ${base + 1}, got ${injected}. ` +
        `A gate that cannot go red on a real page is not a gate.`,
    );
  }
  return { anchor, base, injected };
}

function fail(message) {
  console.error(`\ncheck-docs-voice: ${message}\n`);
  process.exit(1);
}

// --- run ------------------------------------------------------------------

selfTest();

const { excluded, pages } = publishedPages();
if (pages.length === 0) {
  fail(
    `published set is empty. Either docs/ moved or the walk failed; an empty ` +
      `set would count zero violations and pass, which is exactly how a broken ` +
      `checker looks identical to a clean tree.`,
  );
}

const control = runControls(pages);

let prose = 0;
let placeholder = 0;
let code = 0;
const offenders = [];

for (const page of pages) {
  const full = join(docsRoot, page);
  const bytes = statSync(full).size;
  if (bytes === 0) {
    fail(
      `${page} is empty (0 bytes). Refusing to count it: a file that was never ` +
        `read yields zero violations, and zero is the pass value.`,
    );
  }
  const text = readFileSync(full, "utf8");
  if (text.trim().length === 0) {
    fail(
      `${page} has bytes but no non-whitespace content. Refusing to count it: a ` +
        `page that was not really read yields zero violations, and zero is the ` +
        `pass value.`,
    );
  }
  const counts = classify(text);
  prose += counts.prose;
  placeholder += counts.placeholder;
  code += counts.code;
  if (counts.prose > 0) offenders.push({ page, prose: counts.prose });
}

const scope = excluded.join(", ");
console.log(
  `check-docs-voice: published = docs/**/*.md minus srcExclude [${scope}]`,
);
console.log(`  pages read:        ${pages.length}`);
console.log(
  `  control:           ${control.anchor} prose ${control.base} -> ${control.injected} on injection (gate can go red)`,
);
console.log(
  `  em-dash, prose:    ${prose}   <- gated, must be 0 (unit: occurrences)`,
);
console.log(
  `  em-dash, exempt:   ${placeholder} placeholder cells, ${code} in code`,
);

if (offenders.length > 0) {
  console.error(
    `\ncheck-docs-voice: em-dash in published prose. The writing guide says to ` +
      `use parentheses, colons, or periods.\n`,
  );
  for (const { page, prose: n } of offenders) {
    console.error(`  docs/${page}: ${n} occurrence${n === 1 ? "" : "s"}`);
  }
  console.error(
    `\nExempt and not counted: whole-cell table placeholders (| ${EM_DASH} |), ` +
      `fenced code, inline code spans.\n`,
  );
  process.exit(1);
}

console.log(`\ncheck-docs-voice: ok`);
