import { describe, expect, it } from 'vitest';

import { outletErrorBoundaryKey } from './url-state';

describe('outletErrorBoundaryKey', () => {
  it('collapses KB file deep-links onto the kb id surface', () => {
    expect(outletErrorBoundaryKey('/kb/team')).toBe('kb/team');
    expect(outletErrorBoundaryKey('/kb/team/agents/nicholas/MEMORY.md')).toBe('kb/team');
    expect(outletErrorBoundaryKey('/kb/team/a/b/c.md')).toBe('kb/team');
    expect(outletErrorBoundaryKey('/kb')).toBe('kb');
  });

  it('collapses agent Files deep-links onto the files tab surface', () => {
    expect(outletErrorBoundaryKey('/agents/nicholas/files')).toBe('agents/nicholas/files');
    expect(outletErrorBoundaryKey('/agents/nicholas/files/notes/foo.md')).toBe(
      'agents/nicholas/files',
    );
  });

  it('keeps other agent tabs and non-browser paths distinct', () => {
    expect(outletErrorBoundaryKey('/agents/nicholas/activity')).toBe('agents/nicholas/activity');
    expect(outletErrorBoundaryKey('/agents/nicholas/profile')).toBe('agents/nicholas/profile');
    expect(outletErrorBoundaryKey('/agents/nicholas')).toBe('agents/nicholas');
    expect(outletErrorBoundaryKey('/')).toBe('/');
    expect(outletErrorBoundaryKey('/login')).toBe('/login');
  });

  it('changes key when switching KB or agent surface', () => {
    expect(outletErrorBoundaryKey('/kb/team')).not.toBe(outletErrorBoundaryKey('/kb/code'));
    expect(outletErrorBoundaryKey('/agents/a/files')).not.toBe(
      outletErrorBoundaryKey('/agents/b/files'),
    );
    expect(outletErrorBoundaryKey('/agents/a/files')).not.toBe(
      outletErrorBoundaryKey('/agents/a/activity'),
    );
  });
});
