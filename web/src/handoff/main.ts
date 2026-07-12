import './styles.css';

import { encryptHumanTransfer, requestStateFromFragment } from './page';

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
  app.append(
    state.kind === 'ready'
      ? encryptionView(state.publicKey)
      : errorView(state.title, state.message),
    siteFooter(),
  );
}

function siteHeader(): HTMLElement {
  const header = element('header', 'site-header');
  const brand = element('div', 'brand-lockup');
  brand.append(element('span', 'brand-mark', 'A'));
  const names = element('div');
  names.append(
    element('p', 'brand-name', 'Anima'),
    element('p', 'brand-product', 'Local encryption'),
  );
  brand.append(names);
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
  panel.append(element('p', 'eyebrow', 'Browser-only'));
  const heading = element('h1', undefined, 'Encrypt a secret');
  heading.id = 'handoff-title';
  panel.append(
    heading,
    element(
      'p',
      'lede',
      'The value is encrypted in this browser. Only the matching private key can open it.',
    ),
    secretForm(publicKey),
  );
  main.append(panel);
  return main;
}

function secretForm(publicKey: string): HTMLElement {
  const wrapper = element('div', 'form-stack');
  const form = element('form', 'secret-form');
  form.noValidate = true;
  form.autocomplete = 'off';

  const labelRow = element('div', 'label-row');
  const label = element('label', undefined, 'Secret');
  label.htmlFor = 'secret-value';
  const show = element('button', 'show-control', 'Show');
  show.type = 'button';
  show.setAttribute('aria-pressed', 'false');
  labelRow.append(label, show);

  const input = element('input', 'secret-input');
  input.id = 'secret-value';
  input.name = 'secret';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.required = true;
  input.type = 'password';
  input.setAttribute('aria-describedby', 'form-status');

  show.addEventListener('click', () => {
    const masked = input.type === 'password';
    input.type = masked ? 'text' : 'password';
    show.textContent = masked ? 'Hide' : 'Show';
    show.setAttribute('aria-pressed', String(masked));
    input.focus();
  });

  const status = element('p', 'form-status');
  status.id = 'form-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const submit = element('button', 'primary-action', 'Encrypt');
  submit.type = 'submit';

  form.append(labelRow, input, status, submit);
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
      const transfer = await encryptHumanTransfer(publicKey, input.value);
      input.value = '';
      wrapper.replaceChildren(resultView(transfer.fencedBox));
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
  result.append(element('p', 'eyebrow success', 'Encrypted'));
  const heading = element('h2', undefined, 'Copy the encrypted value');
  heading.id = 'result-title';
  result.append(heading, element('p', 'lede', 'Send this entire block back exactly as copied.'));

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
      copy.textContent = 'Copied';
      copyStatus.textContent = 'Encrypted value copied.';
    } catch {
      output.focus();
      output.select();
      copyStatus.textContent = 'Clipboard access failed. The encrypted value is selected.';
    }
  });
  result.append(output, copy, copyStatus);
  return result;
}

window.addEventListener('hashchange', render);
render();
