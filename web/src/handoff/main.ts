import './styles.css';

import { encryptSealedTransfer, handoffStateFromFragment } from './page';

const appRoot = document.querySelector<HTMLElement>('#app');
if (!appRoot) throw new Error('Handoff app root is missing');
const app: HTMLElement = appRoot;

const PROOF_LINE =
  "The value is encrypted in this browser. Only your agent's key can open it.";

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

// Static markup only; parsed via innerHTML because the artifact checker forbids
// URL literals in emitted bytes, which rules out createElementNS's namespace string.
function icon(paths: string[], size = 18): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML =
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    paths.map((d) => `<path d="${d}"></path>`).join('') +
    '</svg>';
  return host.firstElementChild as SVGSVGElement;
}

function lockIcon(size = 18): SVGSVGElement {
  return icon(
    [
      'M5 11.5a1.8 1.8 0 0 1 1.8-1.8h10.4a1.8 1.8 0 0 1 1.8 1.8v6.7a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 18.2z',
      'M8.2 9.7V7.3a3.8 3.8 0 0 1 7.6 0v2.4',
      'M12 14v2.2',
    ],
    size,
  );
}

function checkIcon(size = 18): SVGSVGElement {
  return icon(['M5.5 12.5l4.2 4.2L18.5 7.5'], size);
}

function seal(kind: 'lock' | 'check'): HTMLElement {
  const mark = element('div', kind === 'check' ? 'seal success' : 'seal');
  mark.append(kind === 'check' ? checkIcon() : lockIcon());
  return mark;
}

function proofNote(): HTMLElement {
  const note = element('p', 'proof-note');
  note.append(lockIcon(14), document.createTextNode(PROOF_LINE));
  return note;
}

function render(): void {
  const state = handoffStateFromFragment(window.location.hash);
  app.replaceChildren(siteHeader());
  app.append(
    state.kind === 'ready'
      ? encryptionView(state.publicKey)
      : errorView(state.title, state.message),
    siteFooter(),
  );
}

// The Ember mark (open halo + glowing core) from web/src/components/AnimaIcon.tsx,
// inlined because the handoff page cannot import React components. Keep the two
// geometries in sync if the brand mark ever changes.
function animaMark(size = 30): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML =
    `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">` +
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="5.5" ' +
    'd="M48.11 22.93a19 19 0 1 1-32.22 0"></path>' +
    '<circle cx="32" cy="33" r="9"></circle></svg>';
  return host.firstElementChild as SVGSVGElement;
}

function siteHeader(): HTMLElement {
  const header = element('header', 'site-header');
  const brand = element('div', 'brand-lockup');
  const mark = element('span', 'brand-mark');
  mark.append(animaMark());
  brand.append(mark);
  brand.append(element('p', 'brand-name', 'Anima'));
  header.append(brand);
  return header;
}

function siteFooter(): HTMLElement {
  const footer = element('footer', 'site-footer');
  footer.textContent = 'No account · no upload · no storage';
  return footer;
}

function errorView(title: string, message: string): HTMLElement {
  const main = element('main', 'page-shell');
  const panel = element('section', 'panel error-panel');
  panel.setAttribute('aria-labelledby', 'error-title');
  const heading = element('h1', undefined, title);
  heading.id = 'error-title';
  panel.append(
    seal('lock'),
    element('p', 'eyebrow', 'Unable to continue'),
    heading,
    element('p', 'lede', message),
  );
  main.append(panel);
  return main;
}

function encryptionView(publicKey: string): HTMLElement {
  const main = element('main', 'page-shell');
  const panel = element('section', 'panel');
  panel.setAttribute('aria-labelledby', 'handoff-title');
  const heading = element('h1', undefined, 'Encrypt a secret for your agent');
  heading.id = 'handoff-title';
  panel.append(
    seal('lock'),
    heading,
    element('p', 'lede', PROOF_LINE),
    secretForm(publicKey, panel),
  );
  main.append(panel);
  return main;
}

function secretForm(publicKey: string, panel: HTMLElement): HTMLElement {
  const wrapper = element('div', 'form-stack');
  const form = element('form', 'secret-form');
  form.noValidate = true;
  form.autocomplete = 'off';

  const labelRow = element('div', 'label-row');
  const label = element('label', undefined, 'Secret');
  label.htmlFor = 'secret-value';

  const fieldWrap = element('div', 'field-wrap');
  // A native password input: the browser masks the value in the visual paint
  // AND the accessibility tree, and browsers without any masking support do
  // not exist for type=password. CSS-only masking on a textarea leaks the raw
  // value to assistive technology and fails open; multi-line secret entry is
  // a follow-up that needs a purpose-built masking interaction.
  const input = element('input', 'secret-input');
  input.type = 'password';
  input.id = 'secret-value';
  input.name = 'secret';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.required = true;
  input.setAttribute('aria-describedby', 'form-status');

  const show = element('button', 'show-control', 'Show');
  show.type = 'button';
  show.setAttribute('aria-pressed', 'false');
  show.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    show.textContent = reveal ? 'Hide' : 'Show';
    show.setAttribute('aria-pressed', String(reveal));
    input.focus();
  });
  labelRow.append(label, show);
  fieldWrap.append(input);

  const status = element('p', 'form-status');
  status.id = 'form-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const submit = element('button', 'primary-action', 'Encrypt');
  submit.type = 'submit';

  form.append(labelRow, fieldWrap, status, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value) {
      status.textContent = 'Enter a value before encrypting.';
      input.focus();
      return;
    }
    submit.disabled = true;
    status.textContent = 'Encrypting locally…';
    try {
      const transfer = await encryptSealedTransfer(publicKey, input.value);
      input.value = '';
      panel.setAttribute('aria-labelledby', 'result-title');
      panel.replaceChildren(resultView(transfer.fencedBox));
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : 'The value could not be encrypted.';
      submit.disabled = false;
    }
  });

  wrapper.append(form);
  return wrapper;
}

function resultView(fencedBox: string): HTMLElement {
  const result = element('section', 'result-view');
  result.setAttribute('aria-labelledby', 'result-title');
  result.append(seal('check'), element('p', 'eyebrow success', 'Encrypted'));
  const heading = element('h2', undefined, 'Copy the encrypted value');
  heading.id = 'result-title';
  result.append(
    heading,
    element('p', 'lede', 'Send this entire block back to your agent exactly as copied.'),
  );

  const output = element('textarea', 'encrypted-output');
  output.readOnly = true;
  output.value = fencedBox;
  output.rows = 8;
  output.setAttribute('aria-label', 'Encrypted value');
  const copyStatus = element('p', 'form-status');
  copyStatus.setAttribute('role', 'status');
  copyStatus.setAttribute('aria-live', 'polite');
  const copy = element('button', 'primary-action', 'Copy encrypted value');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(fencedBox);
      copy.replaceChildren(checkIcon(16), document.createTextNode('Copied'));
      copy.classList.add('copied');
      copyStatus.textContent = 'Encrypted value copied.';
    } catch {
      output.focus();
      output.select();
      copyStatus.textContent = 'Clipboard access failed. The encrypted value is selected.';
    }
  });
  result.append(output, copy, copyStatus, proofNote());
  return result;
}

window.addEventListener('hashchange', render);
render();
