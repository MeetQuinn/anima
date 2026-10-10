import { join } from 'node:path';
import { z } from 'zod';
import { LinearListenerConfig, LinearListenerFailure } from '../../../shared/linear.js';
import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';

const Observation = z.object({
  state: z.enum(['listening', 'failed', 'stopped']),
  address: LinearListenerConfig,
  reason: LinearListenerFailure.optional(),
  observedAt: z.string().datetime(),
  processId: z.number().int().positive(),
}).strict();
export type LinearListenerObservation = z.infer<typeof Observation>;
const ListenerFile = z.object({ observation: Observation.optional() }).strict();

export class LinearListenerStore {
  private readonly file: JsonStore<{ observation?: LinearListenerObservation }>;
  constructor(animaHome = resolveAnimaHome()) {
    this.file = new JsonStore({
      path: () => join(animaHome, 'run', 'linear-listener.json'), writeRoot: () => animaHome,
      mode: 0o600, empty: () => ({}), parse: (value) => ListenerFile.parse(value),
    });
  }
  async read(): Promise<LinearListenerObservation | undefined> { return (await this.file.read()).observation; }
  async write(observation: LinearListenerObservation): Promise<void> { await this.file.write({ observation }); }
}
