import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

export function signalWake(agentId: string): void {
  emitter.emit(agentId);
}

export function onWake(agentId: string, listener: () => void): () => void {
  emitter.on(agentId, listener);
  return () => emitter.off(agentId, listener);
}
