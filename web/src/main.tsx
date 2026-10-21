import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { router } from './router';
import { queryClient } from './query-client';
import { installGlobalErrorReporting } from './lib/client-error-report';
import { ErrorBoundary } from './components/ErrorBoundary';

// Report uncaught errors / rejections to the operator's local client-error log.
// Reporting is all a window-level error gets: an error from an event handler,
// a timer, a browser extension or a ResizeObserver loop leaves the React tree
// intact, so the app must keep running. Render errors are caught by the route
// `errorElement`s and, for anything that escapes the router, the boundary below;
// both render the message as text.
installGlobalErrorReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
