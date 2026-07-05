import { beforeEach, describe, expect, it } from 'vitest';

import {
  CODE_WRAP_STORAGE_KEY,
  VIEW_MODE_STORAGE_KEY,
  loadSessionViewMode,
  loadSessionWrap,
  saveSessionViewMode,
  saveSessionWrap,
} from './view-prefs';

describe('KB view preferences', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips the preview/code session view mode', () => {
    expect(loadSessionViewMode()).toBe('preview');
    saveSessionViewMode('code');
    expect(sessionStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe('code');
    expect(loadSessionViewMode()).toBe('code');
    saveSessionViewMode('preview');
    expect(loadSessionViewMode()).toBe('preview');
  });

  it('falls back to preview for invalid stored view mode values', () => {
    sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, 'diff');
    expect(loadSessionViewMode()).toBe('preview');
  });

  it('round-trips the code wrap preference', () => {
    expect(loadSessionWrap()).toBe(true);
    saveSessionWrap(false);
    expect(sessionStorage.getItem(CODE_WRAP_STORAGE_KEY)).toBe('off');
    expect(loadSessionWrap()).toBe(false);
    saveSessionWrap(true);
    expect(sessionStorage.getItem(CODE_WRAP_STORAGE_KEY)).toBe('on');
    expect(loadSessionWrap()).toBe(true);
  });

  it('treats invalid stored wrap values as enabled', () => {
    sessionStorage.setItem(CODE_WRAP_STORAGE_KEY, 'maybe');
    expect(loadSessionWrap()).toBe(true);
  });
});
