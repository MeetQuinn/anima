import { ChevronDown, CircleAlert, ExternalLink, Loader2, RotateCw, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import type { AgentFeishuRecommendedScopeStatusItem } from '@shared/agent-config';
import { feishuOfficialScopeName } from './feishu-scope-names';

// Shared "Authorize Feishu permissions" guided checklist. Rendered by both the
// onboarding Step 3 surface and the agent-profile diagnostic card so the two
// stay visually and behaviourally identical: add the permissions in Feishu,
// publish a new app version by hand, then recheck. The two surfaces differ only
// in their wrappers (onboarding adds a Skip control + connected handoff; the
// profile adds a connected/healthy success state and a render-null guard).

// Numbered step marker. `alert` rings it red to point the user back to the step
// that most likely needs attention (the manual publish).
export function FeishuStepBadge({ n, alert = false }: { n: number; alert?: boolean }) {
  return (
    <span
      className={`flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full font-sans text-[11px] font-medium ${
        alert
          ? 'bg-health-error-soft text-health-error ring-1 ring-health-error/40'
          : 'bg-canvas text-text-subtle'
      }`}
    >
      {n}
    </span>
  );
}

// The recheck-came-back-still-missing verdict. Points the user back at the
// manual publish step (the most common reason new permissions don't apply).
export function FeishuPublishNotAppliedVerdict() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-health-error/30 bg-health-error-soft px-3 py-2">
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-health-error" aria-hidden />
      <div className="space-y-0.5">
        <p className="font-serif text-[13px] font-semibold leading-snug text-text">
          Not authorized yet.
        </p>
        <p className="font-serif text-[12px] leading-snug text-text-muted">
          Feishu hasn’t applied the new permissions. This usually means step 2 wasn’t published yet.
          Publish a new app version, then recheck. If you just published, give it a moment and
          recheck.
        </p>
      </div>
    </div>
  );
}

interface ChecklistProps {
  scopes: AgentFeishuRecommendedScopeStatusItem[];
  authUrl?: string;
  /**
   * A recheck confirmed the scopes are still ungranted: shows the red verdict
   * banner, flips the permission rows to ✗ ("What’s still missing"), rings the
   * publish step, and force-opens the list. Stays false until a recheck so we
   * never assert a false-unhealthy verdict before actually checking (#222).
   */
  confirmedMissing: boolean;
  showPerms: boolean;
  onTogglePerms: () => void;
  onRecheck: () => void;
  isRechecking: boolean;
  /** Verdict banner shown above the steps when confirmedMissing. */
  banner?: ReactNode;
  /** Small status line under the steps (last-check / could-not-check). */
  statusLine?: ReactNode;
  /** Footer under the card body (e.g. the onboarding Skip control). */
  footer?: ReactNode;
}

export function FeishuRecommendedPermissionsChecklist({
  scopes,
  authUrl,
  confirmedMissing,
  showPerms,
  onTogglePerms,
  onRecheck,
  isRechecking,
  banner,
  statusLine,
  footer,
}: ChecklistProps) {
  const open = showPerms || confirmedMissing;
  return (
    <div className="space-y-4 rounded-md border border-border-soft bg-surface px-4 py-4">
      <div className="space-y-1.5">
        <div className="font-serif text-[15px] font-semibold leading-tight text-text">
          Authorize Feishu permissions
        </div>
        <p className="font-serif text-[13px] leading-relaxed text-text-muted">
          These let your Feishu bot recognize teammates by name, take part in group chats, and look
          people up by email or phone.
        </p>
      </div>

      {confirmedMissing && banner}

      <ol className="space-y-3.5">
        <li className="flex items-start gap-3">
          <FeishuStepBadge n={1} />
          <div className="flex-1 space-y-2">
            <span className="font-serif text-[13px] leading-snug text-text">
              Add the permissions
            </span>
            {authUrl && (
              <Button
                size="sm"
                className="w-full sm:w-auto"
                render={<a href={authUrl} rel="noreferrer" target="_blank" />}
              >
                Open Feishu
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
            <div className="pt-0.5">
              <button
                type="button"
                onClick={onTogglePerms}
                aria-expanded={open}
                className="inline-flex items-center gap-1 font-sans text-[12px] text-text-muted transition-colors hover:text-text"
              >
                {confirmedMissing ? 'What’s still missing' : 'What you’ll add in Feishu'}
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
                  aria-hidden
                />
              </button>
              {open && (
                <ul className="mt-2 space-y-1">
                  {scopes.map((scope) => (
                    <li
                      key={scope.scope}
                      className="flex items-start gap-2 font-serif text-[12px] leading-snug text-text-muted"
                    >
                      {confirmedMissing ? (
                        <X
                          className="mt-[1px] h-3.5 w-3.5 shrink-0 text-health-error"
                          strokeWidth={2.75}
                          aria-hidden
                        />
                      ) : (
                        <span
                          className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-text-subtle/50"
                          aria-hidden
                        />
                      )}
                      <span>{feishuOfficialScopeName(scope.scope, scope.label)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </li>

        <li className="flex items-start gap-3">
          <FeishuStepBadge n={2} alert={confirmedMissing} />
          <div className="flex-1">
            <span className="font-serif text-[13px] leading-snug text-text">
              Publish a new app version
            </span>
            <p className="font-serif text-[12px] leading-snug text-text-subtle">
              Feishu applies the new permissions only after you publish a version by hand.
            </p>
          </div>
        </li>

        <li className="flex items-start gap-3">
          <FeishuStepBadge n={3} />
          <div className="flex-1 space-y-2">
            <span className="font-serif text-[13px] leading-snug text-text">Verify access</span>
            <div>
              <button
                type="button"
                onClick={onRecheck}
                disabled={isRechecking}
                className="inline-flex min-h-8 items-center justify-center gap-1 rounded-sm font-sans text-[12px] text-text-muted underline decoration-text-subtle/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isRechecking ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCw className="h-3 w-3" aria-hidden />
                )}
                Recheck access
              </button>
            </div>
          </div>
        </li>
      </ol>

      {statusLine}
      {footer}
    </div>
  );
}
