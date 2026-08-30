import test from "node:test";
import assert from "node:assert/strict";

import { slackMessagePreviewsFromAttachments } from "../slack/message-previews.js";
import {
  slackEventMentionsUserId,
  slackVisibleMessageText,
  withCanonicalSlackVisibleText,
} from "../slack/message-text.js";
import { slackTranscriptOutput } from "../tools/slack-transcript.js";
import {
  slackBareUrlAutolink,
  slackEmphasisFlanking,
  slackMarkdownBlockBreaks,
  slackMessageContentForText,
} from "../tools/slack-message-format.js";

test("Slack markdown block content enforces body and fallback limits", () => {
  const content = slackMessageContentForText(`Report\n${"é".repeat(2_000)}`);
  assert.equal(content.format, "markdown");
  assert.equal(content.blockCount, 1);
  assert.deepEqual(content.blocks, [
    { type: "markdown", text: `Report\n${"é".repeat(2_000)}` },
  ]);
  assert.ok(Buffer.byteLength(content.text, "utf8") <= 3500);
  assert.ok(content.text.endsWith("…"));

  assert.throws(
    () => slackMessageContentForText("X".repeat(12_001)),
    /message is too long for Slack markdown block: 12001 characters, Slack allows 12000; send a file instead/,
  );
});

test("canonical Slack text restores trailing user mention past fallback cutoff", () => {
  const agentId = "U0B3ZB0NCLA";
  const prefix = "界".repeat(1_200);
  const fullBody = `${prefix}\nPlease take this <@${agentId}>`;
  const fallback = slackMessageContentForText(fullBody).text;
  assert.ok(fallback.endsWith("…"));
  assert.equal(
    slackEventMentionsUserId({ text: fallback }, agentId),
    false,
    "fallback must cut off before the mention",
  );

  const blocks = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: `${prefix}\nPlease take this ` },
            { type: "user", user_id: agentId },
          ],
        },
      ],
    },
  ];
  const canonical = withCanonicalSlackVisibleText({ blocks, text: fallback });
  assert.equal(slackEventMentionsUserId(canonical, agentId), true);
  assert.match(canonical.text ?? "", new RegExp(`<@${agentId}>$`));
  assert.ok((canonical.text ?? "").includes(prefix.slice(0, 20)));
});

test("literal/code mentions do not count as agent address; real entities and markdown tokens do", () => {
  const agentId = "U0B3ZB0NCLA";

  // Markdown block: mention token only inside inline code
  assert.equal(
    slackEventMentionsUserId(
      {
        blocks: [
          { type: "markdown", text: `example literal \`<@${agentId}>\`` },
        ],
        text: `example literal \`<@${agentId}>\``,
      },
      agentId,
    ),
    false,
  );

  // Rich-text code-styled text containing a mention token (renders as `…`)
  assert.equal(
    slackEventMentionsUserId(
      {
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "example literal " },
                  {
                    type: "text",
                    text: `<@${agentId}>`,
                    style: { code: true },
                  },
                ],
              },
            ],
          },
        ],
        text: `example literal \`<@${agentId}>\``,
      },
      agentId,
    ),
    false,
  );

  // Real rich-text user entity (trailing mention after long body)
  assert.equal(
    slackEventMentionsUserId(
      {
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "please handle " },
                  { type: "user", user_id: agentId },
                ],
              },
            ],
          },
        ],
        text: "please handle …",
      },
      agentId,
    ),
    true,
  );

  // Plain rich-text text node with literal `<@U…>` — NOT a user entity, even after
  // blocks→text canonicalization would put that string in input.text.
  const literalRichText = {
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: `literal <@${agentId}>` }],
          },
        ],
      },
    ],
    text: "truncated …",
  };
  const canonicalLiteral = withCanonicalSlackVisibleText(literalRichText);
  assert.match(canonicalLiteral.text ?? "", new RegExp(`<@${agentId}>`));
  assert.equal(slackEventMentionsUserId(canonicalLiteral, agentId), false);

  // Markdown mention token outside code
  assert.equal(
    slackEventMentionsUserId(
      {
        blocks: [{ type: "markdown", text: `please handle <@${agentId}>` }],
        text: "please handle …",
      },
      agentId,
    ),
    true,
  );

  // Mixed: rich_text body without mention + section/mrkdwn real mention → wake
  assert.equal(
    slackEventMentionsUserId(
      {
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "context only" }],
              },
            ],
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `please handle <@${agentId}>` },
          },
        ],
        text: "context only…",
      },
      agentId,
    ),
    true,
  );

  // Mixed: rich_text + section/mrkdwn with mention only inside code → no wake
  assert.equal(
    slackEventMentionsUserId(
      {
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "context only" }],
              },
            ],
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `please handle \`<@${agentId}>\`` },
          },
        ],
        text: "context only…",
      },
      agentId,
    ),
    false,
  );

  // plain_text never parses entities — even with literal `<@U…>` after canonicalize
  for (const block of [
    {
      type: "section",
      text: { type: "plain_text", text: `literal <@${agentId}>` },
    },
    {
      type: "header",
      text: { type: "plain_text", text: `literal <@${agentId}>` },
    },
  ]) {
    const plain = withCanonicalSlackVisibleText({
      blocks: [block],
      text: "fallback without mention",
    });
    assert.match(plain.text ?? "", new RegExp(`<@${agentId}>`));
    assert.equal(slackEventMentionsUserId(plain, agentId), false);
  }

  // Controls-only blocks: no renderable body → raw fallback may still address
  assert.equal(
    slackEventMentionsUserId(
      {
        blocks: [
          { type: "actions", elements: [{ type: "button", value: "approve" }] },
        ],
        text: `please <@${agentId}>`,
      },
      agentId,
    ),
    true,
  );
});

test("Slack visible message text restores complete rich text and tables from blocks", () => {
  const text = slackVisibleMessageText({
    blocks: [
      {
        elements: [
          {
            elements: [
              { type: "user", user_id: "UB0B1" },
              { text: " finished ", type: "text" },
              { style: { bold: true }, text: "S1", type: "text" },
              { text: "\n\nFiles", type: "text" },
            ],
            type: "rich_text_section",
          },
          {
            elements: [
              {
                elements: [
                  { style: { code: true }, text: "one.go", type: "text" },
                ],
                type: "rich_text_section",
              },
            ],
            indent: 0,
            style: "bullet",
            type: "rich_text_list",
          },
        ],
        type: "rich_text",
      },
      {
        rows: [
          [richTextCell("Contract"), richTextCell("Code")],
          [richTextCell("Conservation"), richTextCell("placed | superseded")],
        ],
        type: "table",
      },
      {
        elements: [
          {
            elements: [{ text: "The complete ending survives.", type: "text" }],
            type: "rich_text_section",
          },
        ],
        type: "rich_text",
      },
    ],
    text: "<@UB0B1> finished **S1** …",
  });

  assert.equal(
    text,
    [
      "<@UB0B1> finished **S1**\n\nFiles\n- `one.go`",
      "| Contract | Code |\n| --- | --- |\n| Conservation | placed \\| superseded |",
      "The complete ending survives.",
    ].join("\n\n"),
  );
});

test("Slack visible message text keeps fallback text when blocks contain app controls", () => {
  assert.equal(
    slackVisibleMessageText({
      blocks: [
        { elements: [{ type: "button", value: "approve" }], type: "actions" },
      ],
      text: "Approval requested",
    }),
    "Approval requested",
  );
});

test("Slack visible message text reads a realtime markdown block verbatim", () => {
  assert.equal(
    slackVisibleMessageText({
      blocks: [
        {
          text: "Complete markdown body after the fallback cutoff.",
          type: "markdown",
        },
      ],
      text: "Complete markdown body…",
    }),
    "Complete markdown body after the fallback cutoff.",
  );
});

test("Slack visible message text degrades unsupported blocks and elements locally", () => {
  const prefix = "界".repeat(1_200);
  const tail = "TAIL KEPT after every unsupported node.";
  const fallback = slackMessageContentForText(`${prefix}\n${tail}`).text;
  assert.doesNotMatch(fallback, /TAIL KEPT/);

  const text = slackVisibleMessageText({
    blocks: [
      richTextBlock([{ type: "text", text: prefix }]),
      { type: "divider" },
      { type: "header", text: { type: "plain_text", text: "Review findings" } },
      {
        type: "image",
        alt_text: "Evidence diagram",
        image_url: "https://example.com/evidence.png",
      },
      {
        type: "future_control_block",
        elements: [{ type: "button", value: "approve" }],
      },
      {
        elements: [
          {
            elements: [
              { type: "text", text: "Before inline. " },
              { type: "future_inline", text: "Unknown inline words. " },
              { type: "link", text: "Link label without a URL. " },
              { type: "future_opaque_inline", opaque: true },
              { type: "text", text: "After inline." },
            ],
            type: "rich_text_section",
          },
          { type: "future_rich_text", text: "Unknown rich-text words." },
          {
            elements: [{ type: "text", text: tail }],
            type: "rich_text_section",
          },
        ],
        type: "rich_text",
      },
    ],
    text: fallback,
  });

  assert.match(text ?? "", /^界+/);
  assert.match(text ?? "", /---/);
  assert.match(text ?? "", /Review findings/);
  assert.match(text ?? "", /Evidence diagram/);
  assert.match(text ?? "", /\[unsupported block: future_control_block\]/);
  assert.match(
    text ?? "",
    /Before inline\. Unknown inline words\. Link label without a URL\. \[unsupported inline element: future_opaque_inline\]After inline\./,
  );
  assert.match(text ?? "", /Unknown rich-text words\./);
  assert.match(text ?? "", /TAIL KEPT after every unsupported node\.$/);
});

test("Slack message unfurl attachments normalize into explicit previews", () => {
  const previews = slackMessagePreviewsFromAttachments([
    {
      author_id: "U-iris",
      author_name: "Iris",
      channel_id: "D-private",
      from_url:
        "https://example.slack.com/archives/D-private/p1770000100000001",
      is_msg_unfurl: true,
      private_channel_prompt: true,
      text: "Private note preview",
      ts: "1770000100.000001",
    },
    {
      is_msg_unfurl: true,
      text: "missing target is ignored",
    },
  ]);

  assert.deepEqual(previews, [
    {
      authorId: "U-iris",
      authorName: "Iris",
      channelId: "D-private",
      fromUrl: "https://example.slack.com/archives/D-private/p1770000100000001",
      isPrivate: true,
      messageTs: "1770000100.000001",
      text: "Private note preview",
    },
  ]);
});

function richTextCell(text: string): object {
  return {
    elements: [
      { elements: [{ text, type: "text" }], type: "rich_text_section" },
    ],
    type: "rich_text",
  };
}

function richTextBlock(elements: object[]): object {
  return {
    elements: [{ elements, type: "rich_text_section" }],
    type: "rich_text",
  };
}

test("Slack transcript output includes message preview annotations without reading the target channel", () => {
  const output = slackTranscriptOutput(
    [
      {
        attachments: [
          {
            author_name: "Iris",
            channel_id: "D-private",
            from_url:
              "https://example.slack.com/archives/D-private/p1770000100000001",
            is_msg_unfurl: true,
            private_channel_prompt: true,
            text: "Preview delivered by Slack",
            ts: "1770000100.000001",
          },
        ],
        text: "can you see this?",
        ts: "1770000200.000001",
        user: "U-today",
      },
    ],
    { channel: "D-milo", limit: 1 },
    {
      actors: new Map([["U-today", "@totoday"]]),
      channelMentions: new Map(),
      timezones: new Map(),
      userMentions: new Map(),
    },
    { hasMore: false, nextCursor: "" },
  );

  assert.match(
    output,
    /preview: slack_preview private=true author="Iris" channel_id=D-private message_ts=1770000100\.000001/,
  );
  assert.match(output, /> Preview delivered by Slack/);
});

test("Slack transcript lines decode Slack HTML escapes", () => {
  const output = slackTranscriptOutput(
    [
      {
        text: "A &amp; B, x &lt; y, literal &amp;gt; stays",
        ts: "1770000200.000002",
        user: "U-today",
      },
    ],
    { channel: "D-milo", limit: 1 },
    {
      actors: new Map([["U-today", "@totoday"]]),
      channelMentions: new Map(),
      timezones: new Map(),
      userMentions: new Map(),
    },
    { hasMore: false, nextCursor: "" },
  );
  assert.match(output, /A & B, x < y, literal &gt; stays/);
});

test("Slack markdown block ends lists and quotes before a plain line", () => {
  // Plain lines keep their single newlines (Slack renders them as lines).
  assert.equal(slackMarkdownBlockBreaks("one\ntwo\nthree"), "one\ntwo\nthree");
  // A plain line right after a list would be swallowed into the last item.
  assert.equal(
    slackMarkdownBlockBreaks("- a\n- b\nAfter list"),
    "- a\n- b\n\nAfter list",
  );
  assert.equal(
    slackMarkdownBlockBreaks("1. a\n2) b\nAfter"),
    "1. a\n2) b\n\nAfter",
  );
  assert.equal(
    slackMarkdownBlockBreaks("> quoted\nplain"),
    "> quoted\n\nplain",
  );
  // Already separated, indented continuations, nested items, and block starts are untouched.
  assert.equal(slackMarkdownBlockBreaks("- a\n\nAfter"), "- a\n\nAfter");
  assert.equal(
    slackMarkdownBlockBreaks("- a\n  wrapped\n  - nested\nAfter"),
    "- a\n  wrapped\n  - nested\n\nAfter",
  );
  assert.equal(slackMarkdownBlockBreaks("- a\n# Heading"), "- a\n# Heading");
  assert.equal(
    slackMarkdownBlockBreaks("- a\n| t |\n|---|"),
    "- a\n| t |\n|---|",
  );
  // Fenced code is never touched, and a fence closes any open list.
  assert.equal(
    slackMarkdownBlockBreaks("- a\n```\n- not a list\nplain\n```\nafter"),
    "- a\n```\n- not a list\nplain\n```\nafter",
  );
  // Applied on the send path.
  assert.deepEqual(slackMessageContentForText("- a\nb").blocks, [
    { type: "markdown", text: "- a\n\nb" },
  ]);
});

test("Slack markdown block pads emphasis runs that Slack cannot pair next to CJK text", () => {
  const hair = " ";
  // Closer squeezed between ASCII punctuation and CJK punctuation or text.
  assert.equal(
    slackEmphasisFlanking("可以。**S3 支持 `CopyObject`**；单次"),
    `可以。**S3 支持 \`CopyObject\`**${hair}；单次`,
  );
  assert.equal(
    slackEmphasisFlanking("**支持 `x`**后面"),
    `**支持 \`x\`**${hair}后面`,
  );
  assert.equal(
    slackEmphasisFlanking("**固定成 (bucket)**，只支持"),
    `**固定成 (bucket)**${hair}，只支持`,
  );
  assert.equal(
    slackEmphasisFlanking('*强调 "x"*。后面'),
    `*强调 "x"*${hair}。后面`,
  );
  // Opener squeezed between CJK text and ASCII punctuation.
  assert.equal(
    slackEmphasisFlanking("中文**`code` 开头**后面"),
    `中文${hair}**\`code\` 开头**后面`,
  );
  assert.equal(
    slackEmphasisFlanking("说明，**(注) 开头** 后面"),
    `说明，${hair}**(注) 开头** 后面`,
  );
  // Already well-formed emphasis and prose are untouched.
  for (const text of [
    "有**工程级测试**，覆盖率高",
    "**Title** and *body* with snake_case_names and 2*3*4",
    "(see)**注意**后面",
    "**a** (b)**c**",
    "`**S3 支持 `CopyObject`**；` inside code",
    "- item\n* item\n_ _",
    "**粗体。**后面",
  ]) {
    assert.equal(slackEmphasisFlanking(text), text);
  }
  // Fenced code is never touched; paragraph state resets at blank lines.
  assert.equal(
    slackEmphasisFlanking("```\n**支持 `x`**后面\n```"),
    "```\n**支持 `x`**后面\n```",
  );
  assert.equal(
    slackEmphasisFlanking("**open `x`**后\n\n(b)**c**"),
    `**open \`x\`**${hair}后\n\n(b)**c**`,
  );
  assert.deepEqual(slackMessageContentForText("**支持 `x`**，后面").blocks, [
    { type: "markdown", text: `**支持 \`x\`**${hair}，后面` },
  ]);
});

test("bare URLs are wrapped as autolinks so Slack links them next to CJK text", () => {
  // The trigger case (nico 08-30): a URL glued to a full-width colon renders
  // as dead text in Slack's markdown block; the <url> form links.
  assert.equal(
    slackBareUrlAutolink("PR：https://github.com/MeetQuinn/lunapark-infra/pull/158，请看"),
    "PR：<https://github.com/MeetQuinn/lunapark-infra/pull/158>，请看",
  );
  // Full-width punctuation is not a URL character, so it ends the match.
  assert.equal(
    slackBareUrlAutolink("- https://example.com/pull/8814，checks 全绿"),
    "- <https://example.com/pull/8814>，checks 全绿",
  );
  // Standalone URLs are wrapped too — a render no-op that keeps one code path.
  assert.equal(
    slackBareUrlAutolink("see https://example.com/a"),
    "see <https://example.com/a>",
  );
  // Trailing ASCII sentence punctuation stays outside the link.
  assert.equal(
    slackBareUrlAutolink("Docs: https://example.com/a. Next"),
    "Docs: <https://example.com/a>. Next",
  );
  // A `)` closing an unmatched `(` inside the URL is kept (wikipedia paths);
  // a `)` closing prose parentheses is not.
  assert.equal(
    slackBareUrlAutolink("https://en.wikipedia.org/wiki/Foo_(bar)"),
    "<https://en.wikipedia.org/wiki/Foo_(bar)>",
  );
  assert.equal(
    slackBareUrlAutolink("(见 https://example.com/a)"),
    "(见 <https://example.com/a>)",
  );
});

test("URL autolinking leaves existing links and code untouched", () => {
  for (const text of [
    "<https://example.com/a>，后面",
    "<https://example.com/a|label> 后面",
    "[label](https://example.com/a) 后面",
    "`https://example.com/a` 后面",
    "```\nhttps://example.com/a\n```",
    "xhttps://example.com not a scheme",
    "说明 https:// 而已",
  ]) {
    assert.equal(slackBareUrlAutolink(text), text);
  }
  // Mixed line: code span skipped, plain URL wrapped.
  assert.equal(
    slackBareUrlAutolink("`curl https://a.example` 之后打开https://example.com/b。"),
    "`curl https://a.example` 之后打开<https://example.com/b>。",
  );
  // End-to-end through the full pipeline.
  assert.deepEqual(slackMessageContentForText("看：https://example.com/a，好").blocks, [
    { type: "markdown", text: "看：<https://example.com/a>，好" },
  ]);
});
