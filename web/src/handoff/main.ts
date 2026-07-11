import './styles.css';

import {
  encryptHumanTransfer,
  localExpiry,
  requestStateFromFragment,
  type HumanHandoffRequest,
} from './page';

const appRoot = document.querySelector<HTMLElement>('#app');
if (!appRoot) throw new Error('Handoff app root is missing');
const app: HTMLElement = appRoot;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(): void {
  const state = requestStateFromFragment(window.location.hash);
  app.replaceChildren(siteHeader());
  if (state.kind === 'error') {
    app.append(errorView(state.title, state.message), siteFooter());
    return;
  }
  document.title = `${state.request.targetKey} | Anima Secure Handoff`;
  app.append(requestView(state.request), siteFooter());
}

function siteHeader(): HTMLElement {
  const header = element('header', 'site-header');
  const brand = element('div', 'brand-lockup');
  brand.append(element('span', 'brand-mark', 'A'));
  const names = element('div');
  names.append(
    element('p', 'brand-name', 'Anima'),
    element('p', 'brand-product', 'Secure Handoff'),
  );
  brand.append(names);
  header.append(brand, element('p', 'origin-note', 'Browser-only encryption'));
  return header;
}

function siteFooter(): HTMLElement {
  const footer = element('footer', 'site-footer');
  footer.append(
    element('span', undefined, 'No account · no upload · no storage'),
    element('span', undefined, 'Anima Secure Handoff v1'),
  );
  return footer;
}

function errorView(title: string, message: string): HTMLElement {
  const main = element('main', 'error-layout');
  const panel = element('section', 'error-panel');
  panel.setAttribute('aria-labelledby', 'error-title');
  const eyebrow = element('p', 'eyebrow', 'Unable to continue');
  const heading = element('h1', undefined, title);
  heading.id = 'error-title';
  panel.append(eyebrow, heading, element('p', 'error-copy', message));
  const boundary = element('p', 'boundary-copy');
  boundary.textContent = 'No secret input is available for an invalid or expired request.';
  panel.append(boundary);
  main.append(panel);
  return main;
}

function requestView(request: HumanHandoffRequest): HTMLElement {
  const main = element('main', 'handoff-layout');
  const intro = element('section', 'request-summary');
  intro.setAttribute('aria-labelledby', 'handoff-title');
  intro.append(element('p', 'eyebrow', 'Secret requested'));
  const heading = secretKeyHeading(request.targetKey);
  heading.id = 'handoff-title';
  intro.append(
    heading,
    element(
      'p',
      'request-lede',
      `${request.recipientAgentId} is requesting this secret for a specific task. Confirm the request in Slack before continuing.`,
    ),
    requestLedger(request),
    authenticityNote(request.recipientAgentId),
  );

  const action = element('section', 'handoff-action');
  action.setAttribute('aria-label', 'Encrypt secret');
  action.append(secretForm(request));
  main.append(intro, action);
  return main;
}

function secretKeyHeading(key: string): HTMLHeadingElement {
  const heading = element('h1', 'secret-key');
  const parts = key.split('_');
  parts.forEach((part, index) => {
    const separator = index < parts.length - 1 ? '_' : '';
    heading.append(document.createTextNode(`${part}${separator}`));
    if (separator) heading.append(document.createElement('wbr'));
  });
  return heading;
}

function requestLedger(request: HumanHandoffRequest): HTMLElement {
  const expiry = localExpiry(request);
  const list = element('dl', 'request-ledger');
  const rows: Array<[string, string, string?]> = [
    ['Recipient', request.recipientAgentId],
    ['Slack workspace', request.workspaceName, request.workspaceId],
    ['Purpose', request.purpose],
    ['Destination', `${request.recipientAgentId}'s local encrypted env`],
    ['Expires', expiry.formatted, expiry.timezone],
  ];
  for (const [label, value, note] of rows) {
    const row = element('div', 'ledger-row');
    row.append(element('dt', undefined, label));
    const detail = element('dd');
    detail.append(document.createTextNode(value));
    if (note) detail.append(element('span', 'ledger-note', note));
    row.append(detail);
    list.append(row);
  }
  return list;
}

function authenticityNote(recipientAgentId: string): HTMLElement {
  const note = element('aside', 'authenticity-note');
  note.append(
    element('p', 'note-title', 'Confirm the sender in Slack'),
    element(
      'p',
      undefined,
      `This link controls who can decrypt what you enter: only ${recipientAgentId}. It does not prove who asked you to fill it. Use the originating Slack conversation as the identity check.`,
    ),
  );
  return note;
}

function secretForm(request: HumanHandoffRequest): HTMLElement {
  const wrapper = element('div', 'form-stack');
  const heading = element('h2', undefined, 'Encrypt in this browser');
  wrapper.append(
    heading,
    element(
      'p',
      'local-proof',
      'Encryption happens locally in your browser. This page does not store, send, or see your secret.',
    ),
  );

  const form = element('form', 'secret-form');
  form.noValidate = true;
  form.autocomplete = 'off';
  const labelRow = element('div', 'label-row');
  const label = element('label', undefined, 'Secret value');
  label.htmlFor = 'secret-value';
  const show = element('button', 'show-control', 'Show');
  show.type = 'button';
  show.setAttribute('aria-pressed', 'false');
  labelRow.append(label, show);

  const input = element('input', 'secret-input');
  input.id = 'secret-value';
  input.name = 'secret';
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.required = true;
  input.setAttribute('aria-describedby', 'secret-boundary form-status');

  show.addEventListener('click', () => {
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    show.textContent = visible ? 'Show' : 'Hide';
    show.setAttribute('aria-pressed', String(!visible));
    input.focus();
  });

  const boundary = element(
    'p',
    'category-boundary',
    'This transfers an anima env secret. Provider logins (Claude/Codex) and Slack/Feishu credentials cannot be transferred here.',
  );
  boundary.id = 'secret-boundary';
  const status = element('p', 'form-status');
  status.id = 'form-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const submit = element('button', 'primary-action', `Encrypt for ${request.recipientAgentId}`);
  submit.type = 'submit';

  form.append(labelRow, input, boundary, status, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value) {
      status.textContent = 'Enter the secret value before encrypting.';
      input.focus();
      return;
    }
    submit.disabled = true;
    status.textContent = 'Encrypting locally…';
    try {
      const transfer = await encryptHumanTransfer(request, input.value);
      input.value = '';
      input.type = 'password';
      show.textContent = 'Show';
      show.setAttribute('aria-pressed', 'false');
      wrapper.replaceChildren(resultView(transfer.fencedBox, transfer.fingerprint));
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : 'The secret could not be encrypted.';
      submit.disabled = false;
    }
  });

  wrapper.append(form);
  return wrapper;
}

function resultView(fencedBox: string, fingerprint: string): HTMLElement {
  const result = element('section', 'result-view');
  result.setAttribute('aria-labelledby', 'result-title');
  result.append(element('p', 'eyebrow success', 'Encrypted locally'));
  const heading = element('h2', undefined, 'Return to Slack');
  heading.id = 'result-title';
  result.append(
    heading,
    element(
      'p',
      'result-copy',
      'Copy the encrypted block, return to the originating Slack conversation, and paste the entire block exactly as copied.',
    ),
  );

  const output = element('textarea', 'encrypted-output');
  output.readOnly = true;
  output.value = fencedBox;
  output.rows = 7;
  output.setAttribute('aria-label', 'Encrypted handoff block');
  const copyStatus = element('p', 'form-status');
  copyStatus.setAttribute('role', 'status');
  copyStatus.setAttribute('aria-live', 'polite');
  const copy = element('button', 'primary-action', 'Copy encrypted block');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(fencedBox);
      copy.textContent = 'Copied';
      copyStatus.textContent =
        'Encrypted block copied. Paste it into the originating Slack conversation.';
    } catch {
      output.focus();
      output.select();
      copyStatus.textContent =
        'Clipboard access failed. The encrypted block is selected for manual copying.';
    }
  });

  const confirm = element('div', 'confirmation-code');
  confirm.append(
    element('span', undefined, 'Confirmation code'),
    element('code', undefined, fingerprint),
  );
  const caution = element(
    'p',
    'fingerprint-note',
    'The receiver should report the same code after accepting. This short code is only a confirmation aid for high-entropy tokens; it is not safe evidence for passwords, PINs, or other guessable values.',
  );
  result.append(output, copy, copyStatus, confirm, caution);
  return result;
}

window.addEventListener('hashchange', render);
render();
