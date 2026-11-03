import type { LinearSetup } from '@shared/linear-setup';

/**
 * The two routes a public address must forward for Linear. Shown where the
 * address is set (Server settings, and the first-run step in the Linear
 * dialog), never inside the per-agent connection steps.
 */
export function LinearForwardingRoutes({ setup }: { setup: Pick<LinearSetup, 'publicUrl' | 'listener'> }) {
  const host = setup.listener.host.includes(':') ? `[${setup.listener.host}]` : setup.listener.host;
  const routes = [
    { path: '/webhook', target: `${host}:${setup.listener.port}`, mono: true, purpose: 'Linear events' },
    { path: '/api/linear/oauth/callback', target: 'this dashboard on loopback', mono: false, purpose: 'Return after authorizing' },
  ];
  return (
    <div className="rounded-sm border border-border-soft bg-surface-raised">
      <p className="border-b border-border-soft px-3 py-2 font-sans text-[11px] tracking-wide text-text-muted">
        Forward these routes{setup.publicUrl ? (
          <>
            {' '}from <span className="break-all font-mono text-text">{setup.publicUrl}</span>
          </>
        ) : null}
      </p>
      <ul className="divide-y divide-border-soft">
        {routes.map((route) => (
          <li
            key={route.path}
            className="grid gap-x-4 gap-y-0.5 px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          >
            <span className="break-all font-mono text-[12px] text-text">{route.path}</span>
            <span className="font-sans text-[12px] text-text-muted">
              <span aria-hidden="true">→ </span>
              <span className={route.mono ? 'font-mono text-text' : 'text-text'}>{route.target}</span>
              <span className="block text-[11px] text-text-subtle">{route.purpose}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-border-soft px-3 py-2 font-sans text-[11px] leading-relaxed text-text-subtle">
        Everything else can stay private. Anima does not create the tunnel.
      </p>
    </div>
  );
}
