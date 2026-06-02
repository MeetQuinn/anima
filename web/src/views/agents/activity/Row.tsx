import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Bell, ChevronDown } from 'lucide-react';
import type { SurfaceChip } from '@/lib/activity-feed';

export const COLOR_INBOUND = 'var(--color-activity-inbound)';
export const COLOR_OUTBOUND = 'var(--color-activity-outbound)';
// Reminder wakes share the inbound register (they are wake sources, parallel
// to a Slack message arriving — iris framing `1779213328.332169`) but use
// the aubergine reminder hue instead of the muted teal so the user can
// tell "scheduler woke me" apart from "person messaged me" at a glance.
export const COLOR_REMINDER = 'var(--color-activity-reminder)';

export function SurfaceText({ chip }: { chip: SurfaceChip }) {
  // channel/thread/dm labels already carry their kind marker in text
  // (`#prod` / `@handle`); a leading icon doubles it (the `# #prod` bug).
  // Icon only for kinds with no in-text marker.
  const Icon = chip.kind === 'reminder' ? Bell : null;
  return (
    <span className="inline-flex items-center gap-1 font-sans text-text-muted">
      {Icon && <Icon className="h-3 w-3 shrink-0" />}
      <span className="truncate">{chip.label}</span>
    </span>
  );
}

/**
 * Editorial row primitive. Variants:
 *   register='editorial' → message rows. Serif title at 16px, body at 15px,
 *                           generous leading. The dispatch / published-log voice.
 *   register='chrome'    → tool/step rows. Sans (Albert) caps title at 12px,
 *                           tighter rhythm. Audit/utility register, not voice.
 *   voice='outbound'     → adds margin pull-rule (accent) under the dot. The
 *                           accent NEVER fills the body — chrome-only signal.
 *                           Reserved for message/file weight; react uses the
 *                           accent dot alone (lighter byline-trace weight).
 *   failed=true          → row-failed left rule (2px deep ink red) + AlertCircle
 *                           + bumped title weight. Three redundant signals so a
 *                           failure reads even without color (a11y + accent
 *                           disambiguation per iris's gut-check #2).
 *   expandableBody       → expand affordance for chrome rows. Pass the
 *                           untruncated content; Row detects whether the
 *                           secondary slot actually overflows (ResizeObserver
 *                           on scrollWidth vs clientWidth) OR the displayed
 *                           target was upstream-truncated, and only then
 *                           reveals the chevron + click semantics. Editorial
 *                           rows show full body already; they don't opt in.
 */
export function Row({
  time,
  dotColor,
  title,
  secondary,
  body,
  register = 'editorial',
  voice,
  failed,
  expandableBody,
}: {
  time: string;
  dotColor: string;
  title: ReactNode;
  secondary?: ReactNode;
  body?: ReactNode;
  register?: 'editorial' | 'chrome';
  voice?: 'outbound';
  failed?: boolean;
  // Pass the full, untruncated content (string OR ReactNode) when this row
  // should support click-to-expand. Row figures out whether the affordance
  // is actually needed — visual overflow OR upstream-truncated `…` in the
  // displayed secondary — and gates the chevron + click on that.
  expandableBody?: {
    full: ReactNode;
    upstreamTruncated?: boolean;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const secondaryRef = useRef<HTMLSpanElement>(null);

  // Only watch overflow when the row could be expandable; skip the
  // ResizeObserver setup entirely for rows that don't opt in.
  const optedIn = !!expandableBody && !!secondary;

  useEffect(() => {
    if (!optedIn) return;
    const el = secondaryRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [optedIn, secondary, expanded]);

  const upstreamTruncated = !!expandableBody?.upstreamTruncated;
  const expandable = optedIn && (overflowing || upstreamTruncated);
  const clickable = expandable;

  const rowCls = [
    'relative grid grid-cols-[2.5rem_0.75rem_minmax(0,1fr)] items-baseline gap-2 py-2 pr-2 md:grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] md:gap-3 md:py-2.5 md:pr-3',
    voice === 'outbound' ? 'voice-outbound' : '',
    failed ? 'row-failed' : '',
    // min-h-[44px]: ensures the expand/collapse hit target meets 44px spec on mobile
    // (a single chrome row can be ~30px; clickable = user must tap it, so 44px matters).
    clickable
      ? 'cursor-pointer min-h-[44px] rounded-sm transition-colors hover:bg-surface-elevated/60'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const titleCls =
    register === 'chrome'
      ? [
          'chrome text-[11px] font-medium uppercase tracking-[0.14em]',
          failed ? 'text-health-error' : 'text-text-muted',
        ].join(' ')
      : [
          'font-serif text-[16px] leading-[1.4] text-text',
          failed ? 'font-semibold' : 'font-medium',
        ].join(' ');
  const titleCluster = (
    <span className="flex shrink-0 items-baseline gap-x-2">
      {failed && (
        <AlertCircle className="h-3.5 w-3.5 shrink-0 self-center text-health-error" aria-hidden />
      )}
      <span className={titleCls}>{title}</span>
    </span>
  );
  const secondaryNode =
    secondary && !(expandable && expanded) ? (
      <span
        ref={secondaryRef}
        className="chrome min-w-0 truncate text-[11px] tracking-wide text-text-subtle"
      >
        {secondary}
      </span>
    ) : null;
  const chevronNode = expandable ? (
    <ChevronDown
      className={[
        'h-3 w-3 shrink-0 self-center text-text-subtle transition-transform',
        expanded ? 'rotate-180' : '',
      ].join(' ')}
      aria-hidden
    />
  ) : null;
  const onToggle = () => setExpanded((v) => !v);
  const interactiveProps = useMemo(
    () =>
      clickable
        ? {
            role: 'button' as const,
            tabIndex: 0,
            onClick: onToggle,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle();
              }
            },
            'aria-expanded': expanded,
          }
        : {},
    [clickable, expanded],
  );
  return (
    <div className={rowCls} {...interactiveProps}>
      <span className="text-right font-mono text-[10px] leading-6 text-text-subtle md:text-[11px]">
        {time}
      </span>
      <span className="flex h-6 items-center self-start" aria-hidden>
        {/* Center the dot in a line-height-tall box (h-6 = leading-6) rather
            than a magic top offset, so it tracks the text center at any font
            size; self-start keeps it on the first line for multi-line rows. */}
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: dotColor }} />
      </span>
      <div className="min-w-0 overflow-hidden">
        {/* Secondary follows the title inline (small gap), no fixed title
            column. Typography differs by
            register via titleCls; the layout is shared. */}
        <div className="flex items-baseline gap-x-2.5 leading-6">
          {titleCluster}
          {secondaryNode}
          {chevronNode}
        </div>
        {(body || (expandable && expanded)) && (
          <div
            className={
              register === 'chrome'
                ? 'mt-0.5 font-sans text-[12px] leading-[1.55] text-text-muted'
                : // Cap the editorial reading measure. Without this the body
                  // tracks the full content column (~1000px+ on wide screens →
                  // ~140ch/line), which fights the editorial reading surface
                  // (KB content is likewise capped). ~68ch keeps a comfortable
                  // line length; the avatar/timestamp rail is unaffected.
                  'mt-1 max-w-[68ch] font-serif text-[15px] leading-[1.65] text-text'
            }
          >
            {expandable && expanded ? expandableBody!.full : body}
          </div>
        )}
      </div>
    </div>
  );
}
