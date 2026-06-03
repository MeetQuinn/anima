import { useParams } from 'react-router-dom';
import { Outlet } from 'react-router-dom';
import AgentHeader from '@/components/AgentHeader';

/**
 * Agent shell — renders the agent-level chrome (header + tab bar) and the
 * matched tab view via <Outlet>. Lives at route `/agents/:agentId`.
 *
 * All agents (connected or not) use the same tabbed layout. Not-connected
 * agents land on Profile via reconcileLocation — which shows the connection
 * surface.
 */
export default function AgentLayout() {
  const { agentId } = useParams<{ agentId: string }>();

  if (!agentId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-text-subtle">
        Select an agent from the sidebar.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentHeader />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
