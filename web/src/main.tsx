import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { router } from './router';
import { queryClient } from './query-client';
import { installGlobalErrorReporting } from './lib/client-error-report';

// Report uncaught errors / rejections to the operator's local client-error log.
// Installed first so it captures errors regardless of the fallback UI below.
installGlobalErrorReporting();

window.addEventListener('error', (event) => {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="padding:24px;font-family:ui-monospace,Menlo,monospace;color:#ef4444;background:#1a0e0e;border:1px solid #2c1414;border-radius:6px;margin:24px;font-size:13px;"><strong>Runtime Error</strong><br/><pre style="white-space:pre-wrap;margin-top:12px;font-size:12px">${event.message}\n${event.error?.stack || ''}</pre></div>`;
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
