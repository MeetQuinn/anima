export type ViewMode = 'preview' | 'code';

export const VIEW_MODE_STORAGE_KEY = 'kb-file-view-mode';

// Remember the reader's last choice for the tab session (default Preview on a
// fresh session). A power user inspecting raw source across several files
// shouldn't have to re-toggle each time, but newcomers still land on the
// friendly rendered view first.
export function loadSessionViewMode(): ViewMode {
  try {
    return window.sessionStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'code' ? 'code' : 'preview';
  } catch {
    return 'preview';
  }
}

export function saveSessionViewMode(mode: ViewMode): void {
  try {
    window.sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // sessionStorage can be unavailable (private mode / disabled) — non-fatal.
  }
}

export const CODE_WRAP_STORAGE_KEY = 'kb-code-wrap';

// Wrap defaults ON; only an explicit 'off' disables it.
export function loadSessionWrap(): boolean {
  try {
    return window.sessionStorage.getItem(CODE_WRAP_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveSessionWrap(wrap: boolean): void {
  try {
    window.sessionStorage.setItem(CODE_WRAP_STORAGE_KEY, wrap ? 'on' : 'off');
  } catch {
    // non-fatal
  }
}
