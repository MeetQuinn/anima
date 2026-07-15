import slackifyMarkdown from 'slackify-markdown';

export function slackMrkdwnForMarkdown(markdown: string): string {
  const mrkdwn = slackifyMarkdown(markdown);
  return mrkdwn.endsWith('\n') ? mrkdwn.slice(0, -1) : mrkdwn;
}

// A caption is not pure GFM. It is GFM *plus whatever Slack syntax the author
// already typed* — and slackify-markdown reads `<...>` as autolink/HTML, so it
// destroys Slack's own entities (#541):
//
//   '<#C0B8U0ZR2AW|code-review>' -> '<#C0B8U0ZR2AW|code-review&gt;'
//        closing bracket escaped -> no longer an entity -> renders as literal text
//   '<https://example.com|Docs>' -> 'https://example.com|Docs'
//        brackets stripped -> link survives but LOSES ITS LABEL, and the label
//        leaks into the message as visible junk
//
// Both rendered correctly before any conversion existed. `<@U…>` and `<!here>`
// survive only by luck: they do not look like GFM autolinks. The `|label` forms do.
//
// Rather than protect every entity form — channel, user, broadcast, labelled
// URL, each with escaped-pipe (`\|`, which Markdown tables force) and malformed
// variants, plus a placeholder scheme that must itself never collide with
// caption text — this takes the conservative branch: any caption carrying a `<`
// goes to Slack verbatim, on the path proven correct before #540.
//
// `<` is precisely the entity-forming character, so this is narrow rather than a
// blanket bail-out. `&` and `>` alone stay on the conversion path: slackify
// escapes them to `&amp;`/`&gt;`, which LOOKS like mangling but is correct —
// Slack unescapes both, so `a & b` and `100% > 50%` render with their literal
// characters intact (verified against real Slack, not reasoned about).
//
// The cost, chosen deliberately: a mixed caption ('**bold** cc <@U…>') keeps its
// entity and loses GFM rendering. Better to under-render an author's formatting
// than to corrupt a link they typed by hand — the first is a visible nuisance,
// the second silently destroys meaning.
export function slackCaptionText(caption: string): string {
  return caption.includes('<') ? caption : slackMrkdwnForMarkdown(caption);
}
