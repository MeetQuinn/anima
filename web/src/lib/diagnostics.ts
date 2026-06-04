import type { AgentDiagnosticsBundle } from '@shared/diagnostics';

export function formatAgentDiagnostics(bundle: AgentDiagnosticsBundle): string {
  return JSON.stringify(bundle, null, 2);
}
