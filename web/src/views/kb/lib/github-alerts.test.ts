import { describe, expect, it } from 'vitest';

import { ALERT_MARKER, alertTypeFromClassName } from './github-alerts';

describe('GitHub alert helpers', () => {
  it('detects alert classes from arrays and strings', () => {
    expect(alertTypeFromClassName(['markdown-alert', 'markdown-alert-note'])).toBe('note');
    expect(alertTypeFromClassName('markdown-alert markdown-alert-warning')).toBe('warning');
    expect(alertTypeFromClassName('markdown-alert-warning')).toBeNull();
    expect(alertTypeFromClassName(['markdown-alert'])).toBeNull();
  });

  it('matches supported alert markers case-insensitively', () => {
    expect(ALERT_MARKER.exec('[!NOTE] hello')?.[1]).toBe('NOTE');
    expect(ALERT_MARKER.exec('[!tip]\nbody')?.[1]).toBe('tip');
    expect(ALERT_MARKER.test('[!IMPORTANT]')).toBe(true);
    expect(ALERT_MARKER.test('[!CAUTION]')).toBe(true);
    expect(ALERT_MARKER.test('[!UNKNOWN]')).toBe(false);
  });
});
