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
import { fileURLToPath, pathToFileURL } from "node:url";

import { SRC_EXCLUDE } from "../docs/.vitepress/published.mjs";

const EM_DASH = "—";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(repoRoot, "docs");

/**
 * Count em-dashes in our prose voice, and separately the exempt glyphs.
 * Exempt: whole-cell table placeholders (`| — |`), fenced code, inline code.
 *
 * DO NOT "upgrade" this to a markdown or HTML parser, and do not teach it to
 * skip HTML blocks or strip frontmatter. It is line-based and HTML-blind on
 * purpose.
 *
 * docs/index.md contains no markdown prose at all: it is `layout: home`, raw
 * HTML plus frontmatter. Its landing headline, its hero dek, and the
 * frontmatter `description:` that search engines print are our most published
 * sentences in the repo, and they are inside this gate ONLY because this
 * function does not know what HTML is. The same goes for `aria-label`, which a
 * screen reader speaks aloud: it is our voice, and it is covered for the same
 * accidental reason.
 *
 * Every "obvious" cleanup here (parse the HTML, honour frontmatter, exempt
 * attributes) silently removes the homepage from the gate, and every page stays
 * green afterwards. Additions get complained about. Subtractions are never
 * noticed. If you change this function, first inject an em-dash into the
 * landing dek and confirm it still reds.
 */
export function classify(text) {
  let prose = 0;
  let placeholder = 0;
  let code = 0;

  // CommonMark fenced code: the opening fence fixes both the character and the
  // minimum length. A closing fence must use the SAME character and be at least
  // as long. Toggling on any ``` or ~~~ is wrong in both directions: a ~~~ used
  // as content inside a ``` block would close it (later prose then silently
  // counts as code, a false green), and a longer fence reopening it reds.
  let fenceChar = null;
  let fenceLength = 0;

  for (const rawLine of text.split("\n")) {
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (fence) {
      const [, marker, rest] = fence;
      const char = marker[0];
      if (fenceChar === null) {
        // An opening backtick fence may not contain a backtick in its info
        // string; that would be a code span, not a fence.
        if (!(char === "`" && rest.includes("`"))) {
          fenceChar = char;
          fenceLength = marker.length;
          code += countOf(rawLine);
          continue;
        }
      } else if (
        char === fenceChar &&
        marker.length >= fenceLength &&
        rest.trim() === ""
      ) {
        fenceChar = null;
        fenceLength = 0;
        code += countOf(rawLine);
        continue;
      }
    }
    if (fenceChar !== null) {
      code += countOf(rawLine);
      continue;
    }

    const { spoken, spans } = stripCodeSpans(rawLine);
    code += spans;

    if (spoken.trimStart().startsWith("|")) {
      for (const cell of spoken
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")) {
        const value = cell.trim();
        if (value === EM_DASH) placeholder += 1;
        else prose += countOf(value);
      }
      continue;
    }

    prose += countOf(spoken);
  }

  return { code, placeholder, prose };
}

/**
 * Remove CommonMark inline code spans, returning what is left to be spoken and
 * how many em-dashes the spans swallowed.
 *
 * A code span opens on a run of N backticks and closes on the next run of
 * EXACTLY N. A run with no matching closer is literal text, not code. A
 * backslash-escaped backtick is literal and cannot delimit anything.
 *
 * The naive /`[^`]*`/ this replaces got all three wrong: it could not see a
 * ``double-backtick`` span (false red, since the content counted as prose), and
 * it treated \`escaped backticks\` as a span (false green, hiding real prose).
 */
function stripCodeSpans(line) {
  let spoken = "";
  let spans = 0;
  let index = 0;

  while (index < line.length) {
    const char = line[index];

    if (char === "\\" && index + 1 < line.length) {
      spoken += line.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (char !== "`") {
      spoken += char;
      index += 1;
      continue;
    }

    let openLength = 0;
    while (line[index + openLength] === "`") openLength += 1;

    const closer = findCloser(line, index + openLength, openLength);
    if (closer === -1) {
      // Unmatched run: literal backticks, and whatever follows is still spoken.
      spoken += line.slice(index, index + openLength);
      index += openLength;
      continue;
    }

    spans += countOf(line.slice(index, closer + openLength));
    index = closer + openLength;
  }

  return { spans, spoken };
}

function findCloser(line, from, length) {
  let index = from;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 0;
    while (line[index + run] === "`") run += 1;
    if (run === length) return index;
    index += run;
  }
  return -1;
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
  const excluded = SRC_EXCLUDE;
  if (!Array.isArray(excluded) || excluded.length === 0) {
    fail(
      `SRC_EXCLUDE from docs/.vitepress/published.mjs is empty or not an array. ` +
        `Refusing to guess the published set.`,
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

    // CommonMark conformance. HTML-blindness above is a deliberate exemption;
    // it is not a licence to implement a syntax subset here. Each of these was
    // a real defect: a ~~~ inside a backtick fence closed it and hid every
    // later prose em-dash (false green); a ``double-backtick`` span counted as
    // prose (false red); an escaped \` counted as a span and hid prose (false
    // green).
    [
      "a ~~~ inside a backtick fence does not close it",
      ["```", "~~~", "```", `prose ${EM_DASH}`].join("\n"),
      { prose: 1 },
    ],
    [
      "a longer closing fence closes a shorter one",
      ["```", `x ${EM_DASH}`, "````", `prose ${EM_DASH}`].join("\n"),
      { code: 1, prose: 1 },
    ],
    [
      "double-backtick span is code",
      `x \`\`a ${EM_DASH} b\`\` y`,
      { code: 1, prose: 0 },
    ],
    [
      "escaped backticks are literal, not a span",
      `\\\`not code ${EM_DASH} here\\\``,
      { code: 0, prose: 1 },
    ],
    [
      "an unmatched backtick run does not swallow the line",
      `a \` b ${EM_DASH} c`,
      { code: 0, prose: 1 },
    ],

    // The homepage's coverage is accidental (see classify's note): index.md is
    // raw HTML plus frontmatter, and it is gated only because this classifier
    // is HTML-blind. These four lock that accident in. A comment cannot go red;
    // these can. If a future refactor teaches classify to parse HTML or honour
    // frontmatter, it fails HERE instead of silently dropping the landing page
    // out of the gate and leaving every run green.
    [
      "landing HTML copy is our voice",
      `<p class="landing-dek">A dek ${EM_DASH} here.</p>`,
      { prose: 1 },
    ],
    [
      "frontmatter copy is our voice (search engines print it)",
      ["---", `titleTemplate: AI teammates ${EM_DASH} in Slack`, "---"].join(
        "\n",
      ),
      { prose: 1 },
    ],
    [
      "aria-label is our voice (a screen reader speaks it)",
      `<button aria-label="Close ${EM_DASH} now">x</button>`,
      { prose: 1 },
    ],
    [
      "an HTML heading is our voice",
      `<h1 class="howit-title">Watch the team ${EM_DASH} ship</h1>`,
      { prose: 1 },
    ],
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
 * Constraint 3, on the real artifact rather than a fixture: put real published
 * prose in front of the real classifier and require it to red.
 *
 * The injected text is a standalone Markdown paragraph appended to the real
 * page. That is prose by Markdown's own definition, so nothing here has to
 * guess which existing line counts as prose, and there is no second opinion to
 * drift from classify().
 *
 * Two earlier versions were wrong in the same way, from opposite ends. The
 * first picked a line with its own startsWith() checks: a second copy of the
 * prose rule, untested by construction. Asking classify() instead fixed the
 * duplication but not the control, because it then anchored on index.md line 1
 * (`---`, the frontmatter delimiter) and proved only that appending a character
 * to a delimiter is counted. Neither proved the thing that matters: that real
 * published prose reds the gate.
 */
function runControls(pages) {
  const anchor = pages.find((page) => page === "index.md") ?? pages[0];
  const text = readFileSync(join(docsRoot, anchor), "utf8");
  const base = classify(text).prose;

  const injected = classify(
    `${text}\n\nA control paragraph ${EM_DASH} not part of the page.\n`,
  ).prose;

  if (injected !== base + 1) {
    fail(
      `negative control failed on ${anchor}: appended a Markdown paragraph ` +
        `containing one ${EM_DASH} and prose went ${base} -> ${injected}, ` +
        `expected ${base + 1}. A gate that cannot be shown to red on real ` +
        `published prose is not a gate.`,
    );
  }
  return { anchor, base, injected };
}

function fail(message) {
  console.error(`\ncheck-docs-voice: ${message}\n`);
  process.exit(1);
}

// --- run ------------------------------------------------------------------

// Only when invoked as a script. classify() is exported for reuse, and an
// importer must not trigger a process.exit.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

function main() {
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
    `  control:           ${control.anchor} prose ${control.base} -> ${control.injected} on an appended prose paragraph (gate reds on real prose)`,
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
}
