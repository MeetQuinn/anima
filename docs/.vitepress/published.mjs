// The single source of truth for what the public docs site publishes.
//
// VitePress reads this as its `srcExclude` (docs/.vitepress/config.ts), and
// scripts/check-docs-voice.mjs imports this same value to decide which pages
// its copy rules apply to. Both import the array; neither re-describes it.
//
// It lives here, in its own importable module, because the checker used to
// recover this list by running a regex over config.ts. That is a second
// implementation of the rule, and the second implementation is the one nobody
// tests. It was fooled by a comment: a line reading
//   // Keep "guide/**" published.
// inside the array made the checker treat guide/** as excluded, and it then
// reported a confident green over 16 pages instead of 29, having silently
// stopped looking at 13 live ones. A shrinking domain is invisible: the count
// goes down, every remaining page passes, and nothing is red.
//
// So: no parsing, no inference, no second opinion. If you add an exclusion,
// add it here and both sides learn about it at once.
export const SRC_EXCLUDE = ["design/**"];
