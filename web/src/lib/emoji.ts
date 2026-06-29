// Slack shortcode → Unicode emoji lookup.
//
// Slack reactions arrive as a colon-stripped name (`white_check_mark`). To
// render them as the actual glyph in the web app (mirroring what Slack
// itself shows), we map the common set to their Unicode codepoints.
//
// Scope: the high-frequency reactions an Anima user would actually use
// against a chat thread — acks, sentiment, work signals, common objects.
// Workspace-custom emoji (e.g. `:party_parrot:`) have no Unicode equivalent
// and stay as `:name:` in the chrome (caller's fallback).
//
// Keep this list focused. Pulling in the whole CLDR set would bloat the
// bundle for marginal coverage; reactions in practice cluster on a few
// dozen names.

const SHORTCODE_TO_GLYPH: Record<string, string> = {
  // acks / decisions
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  ballot_box_with_check: '☑️',
  x: '❌',
  heavy_multiplication_x: '✖️',
  negative_squared_cross_mark: '❎',
  question: '❓',
  grey_question: '❔',
  exclamation: '❗',
  warning: '⚠️',
  no_entry: '⛔',

  // sentiment / approval
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  ok_hand: '👌',
  clap: '👏',
  raised_hands: '🙌',
  muscle: '💪',
  pray: '🙏',
  wave: '👋',
  point_up: '☝️',
  eyes: '👀',

  // celebration / energy
  tada: '🎉',
  fire: '🔥',
  rocket: '🚀',
  sparkles: '✨',
  star: '⭐',
  star2: '🌟',
  '100': '💯',
  zap: '⚡',
  boom: '💥',

  // hearts
  heart: '❤️',
  yellow_heart: '💛',
  green_heart: '💚',
  blue_heart: '💙',
  purple_heart: '💜',
  black_heart: '🖤',
  white_heart: '🤍',
  orange_heart: '🧡',
  broken_heart: '💔',

  // faces
  smile: '😄',
  grinning: '😀',
  laughing: '😆',
  joy: '😂',
  rofl: '🤣',
  sweat_smile: '😅',
  wink: '😉',
  blush: '😊',
  thinking_face: '🤔',
  thinking: '🤔',
  pensive: '😔',
  cry: '😢',
  sob: '😭',
  rage: '😡',
  angry: '😠',
  exploding_head: '🤯',
  nerd_face: '🤓',
  sunglasses: '😎',
  flushed: '😳',
  scream: '😱',
  raised_eyebrow: '🤨',
  face_with_monocle: '🧐',
  robot_face: '🤖',
  see_no_evil: '🙈',
  hear_no_evil: '🙉',
  speak_no_evil: '🙊',

  // work / tools
  gear: '⚙️',
  hammer_and_wrench: '🛠️',
  wrench: '🔧',
  hammer: '🔨',
  lock: '🔒',
  unlock: '🔓',
  key: '🔑',
  mag: '🔍',
  mag_right: '🔎',
  bell: '🔔',
  no_bell: '🔕',
  bookmark: '🔖',
  pushpin: '📌',
  paperclip: '📎',
  link: '🔗',
  memo: '📝',
  pencil: '📝',
  pencil2: '✏️',
  notebook: '📓',
  scroll: '📜',
  bulb: '💡',
  flashlight: '🔦',

  // charts / data
  chart_with_upwards_trend: '📈',
  chart_with_downwards_trend: '📉',
  bar_chart: '📊',
  calendar: '📅',
  spiral_calendar_pad: '🗓️',
  hourglass: '⌛',
  hourglass_flowing_sand: '⏳',
  clock: '🕐',
  alarm_clock: '⏰',

  // misc common reactions
  speech_balloon: '💬',
  thought_balloon: '💭',
  email: '📧',
  'e-mail': '📧',
  inbox_tray: '📥',
  outbox_tray: '📤',
  package: '📦',
  computer: '💻',
  iphone: '📱',
  bug: '🐛',
  ghost: '👻',
  alien: '👽',
  crown: '👑',
  trophy: '🏆',
  medal: '🏅',
  art: '🎨',
  rainbow: '🌈',

  // observed in team reactions but missing above — keep the curated set in step
  // with what people actually react with so reactions render as glyphs.
  handshake: '🤝',
  saluting_face: '🫡',
  dart: '🎯',
  clapper: '🎬',
  crescent_moon: '🌙',
  microscope: '🔬',
  heavy_plus_sign: '➕',
  gem: '💎',
};

/**
 * Resolve a Slack shortcode to its Unicode glyph. Returns undefined when no
 * Unicode equivalent exists (workspace-custom emoji); callers should fall
 * back to `:name:` text rendering.
 *
 * Accepts either bare `name` or `:name:` form.
 */
export function emojiGlyph(shortcode: string): string | undefined {
  if (!shortcode) return undefined;
  const key = shortcode.replace(/^:|:$/g, '').toLowerCase();
  return SHORTCODE_TO_GLYPH[key];
}

// Same shortcode shape the mrkdwn tokenizer recognises (`:name:`). Lowercase
// letters/digits plus `_ + -`, so `:white_check_mark:` and `:+1:` both match.
const SHORTCODE_RE = /:([a-z0-9_+-]+):/g;

/**
 * Replace known emoji shortcodes inside a plain-text string with their Unicode
 * glyphs, leaving unknown (workspace-custom) shortcodes as `:name:` text.
 *
 * For step / tool-output text, which renders as raw plain text rather than
 * through the mrkdwn renderer. Keeps a string in / string out so callers can
 * keep rendering inside a `<pre>` or a single-line preview without switching to
 * React nodes. Mirrors what `renderMrkdwn` already does for message bodies.
 */
export function replaceEmojiShortcodes(text: string): string {
  if (!text || !text.includes(':')) return text;
  return text.replace(SHORTCODE_RE, (whole, name: string) => emojiGlyph(name) ?? whole);
}
