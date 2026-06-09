import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { fetchDashboardAuthSession, loginDashboard } from '@/api/auth';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = useMemo(() => safeNextPath(searchParams.get('next')), [searchParams]);
  const { data: session, isLoading } = useQuery({
    queryKey: ['dashboard-auth-session'],
    queryFn: fetchDashboardAuthSession,
    retry: false,
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!session) return;
    if (!session.enabled || session.authenticated) navigate(nextPath, { replace: true });
  }, [navigate, nextPath, session]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await loginDashboard(password);
      navigate(nextPath, { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-dvh bg-page px-4 py-8 text-text-on-spine sm:px-6">
      <div className="mx-auto flex w-full max-w-md flex-col justify-center">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-md border border-avatar-ring-spine bg-spine-elevated text-text-on-spine">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <div>
            <p className="chrome text-xs uppercase tracking-[0.16em] text-text-on-spine-subtle">Anima dashboard</p>
            <h1 className="display text-3xl font-semibold text-text-on-spine">Sign in</h1>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-lg border border-spine-border bg-surface p-5 text-text shadow-deep sm:p-6"
        >
          <div className="mb-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <LockKeyhole className="size-4 text-accent" aria-hidden="true" />
              <span>Dashboard password</span>
            </div>
            <p className="text-sm text-text-muted">
              Enter the password configured for this Anima runtime.
            </p>
          </div>

          <label className="chrome mb-2 block text-xs font-medium uppercase tracking-[0.12em] text-text-subtle" htmlFor="dashboard-password">
            Password
          </label>
          <input
            id="dashboard-password"
            autoComplete="current-password"
            autoFocus
            className="h-11 w-full rounded-md border border-border-soft bg-surface-raised px-3 font-sans text-base text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-soft"
            disabled={submitting || isLoading}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />

          {error && (
            <p className="mt-3 rounded-md border border-health-error/20 bg-health-error-soft px-3 py-2 text-sm text-health-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || isLoading || password.length === 0}
            className="chrome mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-55"
          >
            {submitting ? 'Signing in' : 'Continue'}
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </form>
      </div>
    </main>
  );
}

function safeNextPath(value: string | null): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
