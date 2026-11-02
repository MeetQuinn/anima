import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { LinearCallbackOutcome } from '../linear/identity.service.js';

// The OAuth return lands here from Linear, a cross-site navigation. A 303 to
// the profile would keep that cross-site initiator, and the restricted LAN
// listener exempts only /complete. This page instead navigates on its own, so
// the profile request is same-origin. The destination is built here from an
// agent id the server has already tied to this session; nothing in it comes
// from the query string.
const SCRIPT = "location.replace(document.getElementById('next').href)";
const STYLE =
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3ed;color:#2b2722;font:15px/1.6 Georgia,serif}' +
  'main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:20px;margin:0 0 .5rem}p{margin:0 0 1rem;color:#5c554b}a{color:#b3401f}';
const hash = (source: string) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
const CSP = [
  "default-src 'none'",
  `script-src ${hash(SCRIPT)}`,
  `style-src ${hash(STYLE)}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const copy: Record<LinearCallbackOutcome, string> = {
  connected: 'Linear is connected.',
  declined: 'Authorization was declined in Linear.',
  failed: 'Authorization didn’t finish.',
};

function send(reply: FastifyReply, status: number, body: string, script: boolean): FastifyReply {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', CSP)
    .type('text/html; charset=utf-8')
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">' +
        `<title>Anima</title><style>${STYLE}</style></head><body><main>${body}</main>` +
        (script ? `<script>${SCRIPT}</script>` : '') +
        '</body></html>',
    );
}

/** Return to the agent's profile, which opens its Linear dialog and reads the real state. */
export function sendLinearCompletionPage(reply: FastifyReply, agentId: string, outcome: LinearCallbackOutcome): FastifyReply {
  const href = `/agents/${encodeURIComponent(agentId)}/profile?linear=${outcome}`;
  return send(
    reply,
    200,
    `<h1>${escapeHtml(copy[outcome])}</h1><p>Returning to Anima…</p><a id="next" href="${escapeHtml(href)}">Return to Anima</a>`,
    true,
  );
}

/**
 * The callback could not be tied to an attempt in this session. Name no agent
 * and guess nothing; the user starts again from the dashboard. `link` is false
 * on the public relay, where the dashboard is not reachable.
 */
export function sendLinearRetryPage(reply: FastifyReply, link: boolean): FastifyReply {
  return send(
    reply,
    400,
    '<h1>This authorization can’t be completed</h1>' +
      '<p>It expired, was replaced, or was started in another browser session. Open the agent in Anima and authorize again.</p>' +
      (link ? '<a href="/">Open Anima</a>' : ''),
    false,
  );
}
