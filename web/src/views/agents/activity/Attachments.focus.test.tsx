import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ImageLightbox } from './Attachments';
import type { OutboundFile } from '@/lib/activity-feed';

// Focus contract for the Activity image lightbox, adopted from the shared
// `useDialogFocus` primitive (batch A of the residual `aria-modal` work).
//
// Scope note: this is the lightbox in views/agents/activity/Attachments.tsx.
// A DIFFERENT component with the same name lives in views/kb/ImageLightbox.tsx
// with different props and its own hand-rolled focus handling; nothing here
// says anything about that one.
//
// jsdom does not implement native Tab movement, so "focus moved to the next
// control" is not observable. What IS observable is whether the hook cancelled
// the event at a containment boundary, which is the behaviour that keeps focus
// off the page underneath. fireEvent returns dispatchEvent's boolean, so
// `false` means defaultPrevented.
//
// Runs in CI (`pnpm --dir web test`) and locally the same way.

const file: OutboundFile = {
  fileId: 'F123',
  filename: 'diagram.png',
  mimetype: 'image/png',
  permalink: 'https://example.slack.com/files/F123',
  sizeBytes: 2048,
};

function Harness({ withPermalink = true }: { withPermalink?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open preview
      </button>
      <button type="button">decoy after trigger</button>
      {open && (
        <ImageLightbox
          file={file}
          agentId="nora"
          permalink={withPermalink ? file.permalink : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe('Activity ImageLightbox focus contract', () => {
  it('moves focus to Close on open', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open preview' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close preview' }));
  });

  it('contains Tab and Shift+Tab between Close and the Slack link', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open preview' }));
    const close = screen.getByRole('button', { name: 'Close preview' });
    const link = screen.getByRole('link', { name: /Open in Slack/ });

    // Close is first: Shift+Tab off it must wrap to the last control inside the
    // dialog rather than reaching the "decoy after trigger" button behind it.
    const backwardCancelled = fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(backwardCancelled).toBe(false);
    expect(document.activeElement).toBe(link);

    // The link is last: Tab off it must wrap back to Close.
    const forwardCancelled = fireEvent.keyDown(window, { key: 'Tab' });
    expect(forwardCancelled).toBe(false);
    expect(document.activeElement).toBe(close);
  });

  it('keeps a single-control lightbox from losing focus to the page', () => {
    // No permalink, so Close is both the first and the last control. Both
    // directions have to land back on it; a containment check that only
    // handled "wrap from last to first" would let Shift+Tab escape here.
    render(<Harness withPermalink={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'open preview' }));
    const close = screen.getByRole('button', { name: 'Close preview' });
    expect(screen.queryByRole('link', { name: /Open in Slack/ })).toBeNull();

    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(close);
  });

  it('returns focus to the thumbnail that opened it', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'open preview' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(document.activeElement).toBe(trigger);
  });

  it('still closes on Escape, which stays local to the component', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open preview' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
