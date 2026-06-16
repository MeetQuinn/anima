// Presentational pieces of the onboarding flow, extracted from index.tsx so the
// flow file stays about orchestration. No logic lives here — step indicator,
// platform picker cards, and the platform brand icons only.
import { Loader2 } from 'lucide-react';
import type { WorkspacePlatform } from '@shared/server-settings';

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

export function StepDot({
  last = false,
  n,
  current,
  done,
  onClick,
}: {
  last?: boolean;
  n: number;
  current: number;
  done: boolean;
  onClick?: () => void;
}) {
  const isActive = n === current;
  return (
    <div className="flex items-center gap-2">
      <span
        onClick={onClick}
        title={onClick ? 'Go back to this step' : undefined}
        className={[
          'font-sans flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors',
          done
            ? 'border-health-ok bg-health-ok-soft text-health-ok'
            : isActive
              ? 'border-accent bg-accent text-white'
              : 'border-border-soft text-text-subtle',
          onClick ? 'cursor-pointer hover:opacity-60' : '',
        ].join(' ')}
      >
        {n}
      </span>
      {!last && (
        <span className={['h-px w-8 transition-colors', n < current ? 'bg-health-ok/40' : 'bg-border-soft'].join(' ')} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace platform picker
// ---------------------------------------------------------------------------

export function WorkspacePlatformStep({
  error,
  onChoose,
  saving,
  value,
}: {
  error?: string;
  onChoose: (platform: WorkspacePlatform) => void;
  saving: boolean;
  value: WorkspacePlatform;
}) {
  // Platform is a one-time, remembered workspace choice. Click a card to pick
  // and advance in a single action (no separate Confirm) so first-run stays
  // fast. The pending highlight only appears on the card being saved.
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <PlatformCard
          label="Slack"
          platform="slack"
          disabled={saving}
          pending={saving && value === 'slack'}
          enterClassName="animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 delay-150 motion-reduce:animate-none"
          onChoose={() => onChoose('slack')}
        />
        <PlatformCard
          label="Feishu"
          platform="feishu"
          disabled={saving}
          pending={saving && value === 'feishu'}
          enterClassName="animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 delay-200 motion-reduce:animate-none"
          onChoose={() => onChoose('feishu')}
        />
      </div>
      {error && (
        <p className="font-sans mt-4 text-center text-[12px] text-health-error">{error}</p>
      )}
    </div>
  );
}

// Faint brand-tinted hover glow so each card has its own identity through
// light, not words. Resting state stays neutral; the warm accent is reserved
// for the chosen (pending) state, so hover and selected never collide.
// Brand colors live as tokens in index.css (--color-brand-* / --shadow-brand-*).
const PLATFORM_BRAND_HOVER: Record<WorkspacePlatform, string> = {
  slack: 'hover:border-brand-slack/45 hover:shadow-brand-slack',
  feishu: 'hover:border-brand-feishu/45 hover:shadow-brand-feishu',
};

function PlatformCard({
  disabled,
  enterClassName,
  label,
  onChoose,
  pending,
  platform,
}: {
  disabled: boolean;
  enterClassName?: string;
  label: string;
  onChoose: () => void;
  pending: boolean;
  platform: WorkspacePlatform;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={disabled}
      className={[
        'group relative flex flex-col items-center gap-3.5 rounded-lg border px-4 py-8 text-center transition-all duration-200',
        enterClassName ?? '',
        pending
          ? 'border-accent bg-accent-soft/40 shadow-sm'
          : `border-border-soft bg-surface hover:-translate-y-0.5 hover:bg-surface-elevated ${PLATFORM_BRAND_HOVER[platform]}`,
        disabled && !pending ? 'opacity-50' : '',
        disabled ? 'cursor-wait' : 'cursor-pointer active:translate-y-0 active:scale-[0.98]',
      ].join(' ')}
    >
      <span
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-md bg-white shadow-sm ring-1 ring-border-soft transition-transform duration-200 group-hover:scale-105"
      >
        {platform === 'slack' ? (
          <SlackAppIcon className="h-7 w-7" />
        ) : (
          <FeishuAppIcon className="h-7 w-7" />
        )}
      </span>
      <span className="font-sans text-[13px] font-medium tracking-wide text-text-muted">
        {label}
      </span>
      {pending && (
        <span className="absolute right-2.5 top-2.5" aria-hidden>
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Platform brand icons (official assets; colors are brand, not UI tokens)
// ---------------------------------------------------------------------------

function SlackAppIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 2447.6 2452.5" xmlns="http://www.w3.org/2000/svg">
      <g clipRule="evenodd" fillRule="evenodd">
        <path
          d="m897.4 0c-135.3.1-244.8 109.9-244.7 245.2-.1 135.3 109.5 245.1 244.8 245.2h244.8v-245.1c.1-135.3-109.5-245.1-244.9-245.3.1 0 .1 0 0 0m0 654h-652.6c-135.3.1-244.9 109.9-244.8 245.2-.2 135.3 109.4 245.1 244.7 245.3h652.7c135.3-.1 244.9-109.9 244.8-245.2.1-135.4-109.5-245.2-244.8-245.3z"
          fill="#36C5F0"
        />
        <path
          d="m2447.6 899.2c.1-135.3-109.5-245.1-244.8-245.2-135.3.1-244.9 109.9-244.8 245.2v245.3h244.8c135.3-.1 244.9-109.9 244.8-245.3zm-652.7 0v-654c.1-135.2-109.4-245-244.7-245.2-135.3.1-244.9 109.9-244.8 245.2v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.3z"
          fill="#2EB67D"
        />
        <path
          d="m1550.1 2452.5c135.3-.1 244.9-109.9 244.8-245.2.1-135.3-109.5-245.1-244.8-245.2h-244.8v245.2c-.1 135.2 109.5 245 244.8 245.2zm0-654.1h652.7c135.3-.1 244.9-109.9 244.8-245.2.2-135.3-109.4-245.1-244.7-245.3h-652.7c-135.3.1-244.9 109.9-244.8 245.2-.1 135.4 109.4 245.2 244.7 245.3z"
          fill="#ECB22E"
        />
        <path
          d="m0 1553.2c-.1 135.3 109.5 245.1 244.8 245.2 135.3-.1 244.9-109.9 244.8-245.2v-245.2h-244.8c-135.3.1-244.9 109.9-244.8 245.2zm652.7 0v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.2v-653.9c.2-135.3-109.4-245.1-244.7-245.3-135.4 0-244.9 109.8-244.8 245.1 0 0 0 .1 0 0"
          fill="#E01E5A"
        />
      </g>
    </svg>
  );
}

// Feishu's CURRENT brand mark (the blue+teal flying bird; Feishu rebranded
// away from the older origami paper-plane+pen-tip around 2021). The official
// colored vector isn't published publicly — icon CDNs carry only the "Lark"
// wordmark or monochrome glyphs — so this is the official raster pulled from
// feishu.cn (256px, transparent), served from /public. Swap to the official
// brand-kit SVG if/when we obtain one; the interface stays the same.
function FeishuAppIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <img
      src="/feishu-logo.png"
      alt="Feishu"
      className={className}
      draggable={false}
    />
  );
}
