// Provider protocol frames that are pure streaming noise: raw deltas, stream
// internals, per-part tool frames. These produce thousands of rows with no
// diagnostic value (the 21k `claude.stream.message_stop` case).
//
// This predicate is the single source of truth for BOTH sides of the
// activity log:
//   - write side (server shouldPersistRuntimeEvent): noise is never persisted.
//     One documented exception lives at that call site: ACP context stats
//     is persisted because it feeds runtime session stats.
//   - read side (web hiddenRuntimeEvent): noise is never rendered, even in
//     "show all steps" — including any ACP context stats rows already on
//     disk from the write-side exception.
// Before this module the two sides carried hand-synchronized copies of this
// list; any edit here changes both persistence (disk growth) and rendering.
export function isRuntimeEventNoise(eventType: string): boolean {
  if (eventType === 'provider.reasoning') return true;
  if (eventType.endsWith('.context.stats')) return true;
  if (eventType.endsWith('.system.init')) return true;
  if (eventType.includes('.stream.')) return true;
  if (eventType.includes('.reasoning.')) return true;
  if (eventType.endsWith('.thinking.delta')) return true;
  if (eventType.endsWith('.content.part')) return true;
  if (eventType.endsWith('.tool.call.part')) return true;
  if (eventType.endsWith('.tool_result')) return true;
  if (eventType.endsWith('.hook.triggered') || eventType.endsWith('.hook.resolved')) return true;
  if (eventType.endsWith('.plan.display') || eventType.endsWith('.plan.updated')) return true;
  if (eventType.endsWith('.diff.updated')) return true;
  if (eventType.endsWith('.subagent.event')) return true;
  if (eventType.endsWith('.mcp.progress')) return true;
  if (eventType.endsWith('.raw_response_item.completed')) return true;
  if (eventType.endsWith('.steer.consumed')) return true;
  if (eventType.endsWith('.turn.started') || eventType.endsWith('.turn.completed')) return true;
  if (eventType.endsWith('.step.started')) return true;
  if (eventType.includes('.outputDelta')) return true;
  if (eventType.includes('.patchUpdated')) return true;
  return false;
}
