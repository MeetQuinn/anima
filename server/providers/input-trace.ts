import type { AgentRuntimeInputReceipt, AgentRuntimeInputTraceContext } from './contract.js';

interface InputTraceObservation {
  phase: 'input.prepared' | 'input.accepted' | 'input.written' | 'input.native_lifecycle'
    | 'input.rejected_before_write' | 'input.unconfirmed_on_exit' | 'input.run_failed' | 'result.observed';
  context?: AgentRuntimeInputTraceContext;
  receipt?: AgentRuntimeInputReceipt;
  controllerInstanceId?: string;
  nativeState?: string;
  resultOrdinal?: number;
  owner?: 'current' | 'background' | 'unknown';
}

// Observations never gate stdin or recovery. Build an allowlist so extending a
// caller's input cannot accidentally persist its prompt, environment or error.
export function observeInputTrace(
  record: (payload: Record<string, unknown>) => Promise<unknown>,
  observation: InputTraceObservation,
): void {
  const payload: Record<string, unknown> = {
    eventType: 'runtime.input.trace',
    observedAt: new Date().toISOString(),
    phase: observation.phase,
  };
  if (observation.context) {
    payload.batchId = observation.context.batchId;
    payload.activeItemId = observation.context.activeItemId;
    payload.itemIds = [...observation.context.itemIds];
  }
  if (observation.receipt) {
    payload.controllerInstanceId = observation.receipt.controllerInstanceId;
    payload.nativeInputId = observation.receipt.nativeInputId;
  } else if (observation.controllerInstanceId) {
    payload.controllerInstanceId = observation.controllerInstanceId;
  }
  if (observation.nativeState) payload.nativeState = observation.nativeState;
  if (observation.resultOrdinal !== undefined) payload.resultOrdinal = observation.resultOrdinal;
  if (observation.owner) payload.owner = observation.owner;
  const warn = () => console.warn('Runtime input trace persistence failed');
  try {
    void record(payload).catch(warn);
  } catch {
    warn();
  }
}
