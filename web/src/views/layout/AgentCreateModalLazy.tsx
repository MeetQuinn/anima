// Lazy entry for the "Add agent" modal (sidebar + mobile nav).
//
// The onboarding module is 988 lines and statically imports the profile
// connect steppers (SlackConnectStepper, FeishuOnboardingConnect,
// OwnerPickerForm — ~1500 more lines). The router already code-splits it for
// /onboarding; loading the modal through the same dynamic import keeps all of
// that out of the eager layout chunk instead of dragging it back in via
// Sidebar's static import.
import { Suspense, lazy } from 'react';
import type { TeamConfig } from '@shared/server-settings';

const AgentCreateModalInner = lazy(() =>
  import('@/views/onboarding').then((m) => ({ default: m.AgentCreateModal })),
);

export function AgentCreateModal(props: {
  onClose: () => void;
  teams?: TeamConfig[];
  defaultTeamId?: string;
}) {
  return (
    <Suspense
      // Backdrop-only fallback: the modal's own overlay chrome, so the click
      // reads as instant while the onboarding chunk loads.
      fallback={<div className="fixed inset-0 z-50 bg-page/70 backdrop-blur-sm" />}
    >
      <AgentCreateModalInner {...props} />
    </Suspense>
  );
}
