// Copy text to the clipboard with a non-secure-context fallback.
//
// `navigator.clipboard` only exists in secure contexts (HTTPS or localhost).
// The dashboard is commonly reached over plain HTTP via a LAN host/IP
// (e.g. http://my-mac:4174), where `navigator.clipboard` is undefined — calling
// `.writeText` there throws. So we try the async Clipboard API when available
// and fall back to the legacy `execCommand('copy')` with a temporary textarea.
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy copy path for browsers that block Clipboard API.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy returned false');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
