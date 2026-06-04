import { createBrowserRouter } from 'react-router-dom';
import Layout from './views/layout';
import AgentLayout from './views/agents/layout';
import RouteErrorBoundary from './components/RouteErrorBoundary';

// ---------------------------------------------------------------------------
// Route tree
//
// Views are code-split via the route `lazy` property — react-router handles
// both the dynamic import and the Suspense boundary internally. No manual
// React.lazy() or <Suspense> needed at the route level.
//
// /onboarding is a standalone root-level route — accessible at any time
// (e.g. for testing) without needing agents.length === 0. Layout redirects
// here automatically on first run.
// ---------------------------------------------------------------------------

export const router = createBrowserRouter([
  {
    path: 'onboarding',
    lazy: () => import('./views/onboarding').then((m) => ({ Component: m.OnboardingPage })),
    errorElement: <RouteErrorBoundary />,
  },
  {
    path: '/',
    element: <Layout />,
    // Chunk-load errors from lazy children bubble up to the nearest errorElement.
    // This catches stale-asset failures after a runtime upgrade and reloads.
    errorElement: <RouteErrorBoundary />,
    children: [
      // Agent detail — nested tabs
      {
        path: 'agents/:agentId',
        element: <AgentLayout />,
        children: [
          // No index redirect — AgentReconciler fills the default tab:
          // connected → activity, not-connected → profile.
          {
            path: 'activity',
            lazy: () => import('./views/agents/activity').then((m) => ({ Component: m.default })),
          },
          {
            path: 'profile',
            lazy: () => import('./views/agents/profile').then((m) => ({ Component: m.default })),
          },
          {
            path: 'reminders',
            lazy: () => import('./views/agents/reminders').then((m) => ({ Component: m.default })),
          },
        ],
      },
      // Kb browser — /kb/:id/optional/path
      {
        path: 'kb/:id/*',
        lazy: () => import('./views/kb').then((m) => ({ Component: m.default })),
      },
    ],
  },
]);
