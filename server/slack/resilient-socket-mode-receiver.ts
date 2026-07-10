import { SocketModeReceiver, type SocketModeReceiverOptions } from '@slack/bolt';
import { UnrecoverableSocketModeStartError } from '@slack/socket-mode';
import { ErrorCode as WebApiErrorCode, type AppsConnectionsOpenResponse } from '@slack/web-api';

import { errorMessage } from '../ids.js';

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

interface ResilientSocketModeReceiverOptions extends SocketModeReceiverOptions {
  random?: () => number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  runtimeLogger?: Pick<Console, 'error' | 'log' | 'warn'>;
}

// Slack's built-in reconnect path drops a rejected Promise when shutdown races
// a reconnect. Own the retry loop so every connection attempt is observed.
export class ResilientSocketModeReceiver extends SocketModeReceiver {
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly random: () => number;
  private readonly runtimeLogger: Pick<Console, 'error' | 'log' | 'warn'>;
  private reconnectLoop?: Promise<void>;
  private retryDelay?: { resolve(): void; timer: NodeJS.Timeout };
  private started = false;
  private stopping = false;

  constructor(options: ResilientSocketModeReceiverOptions) {
    const {
      reconnectDelayMs = RECONNECT_DELAY_MS,
      reconnectMaxDelayMs = MAX_RECONNECT_DELAY_MS,
      random = Math.random,
      runtimeLogger = console,
      ...receiverOptions
    } = options;
    super({ ...receiverOptions, autoReconnectEnabled: false });
    this.reconnectDelayMs = reconnectDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.random = random;
    this.runtimeLogger = runtimeLogger;
    this.client.on('disconnected', () => this.onDisconnected());
  }

  override async start(): Promise<AppsConnectionsOpenResponse> {
    this.stopping = false;
    const response = await this.connectUntilStopped();
    if (!response) throw new Error('Slack Socket Mode startup stopped before connecting');
    this.started = true;
    return response;
  }

  override async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    this.releaseRetryDelay();
    await this.disconnectClient();
    await this.reconnectLoop;
  }

  private onDisconnected(): void {
    if (!this.started || this.stopping || this.reconnectLoop) return;
    const loop = this.reconnectAfterDisconnect();
    this.reconnectLoop = loop;
    void this.finishReconnectLoop(loop).catch((error: unknown) => {
      this.runtimeLogger.warn(`Slack Socket Mode reconnect cleanup failed: ${errorMessage(error)}`);
    });
  }

  private async finishReconnectLoop(loop: Promise<void>): Promise<void> {
    try {
      await loop;
    } finally {
      if (this.reconnectLoop === loop) this.reconnectLoop = undefined;
    }
  }

  private async reconnectAfterDisconnect(): Promise<void> {
    try {
      const response = await this.connectUntilStopped();
      if (response && !this.stopping) {
        this.runtimeLogger.log('Slack Socket Mode reconnected.');
      }
    } catch (error) {
      this.runtimeLogger.error(`Slack Socket Mode reconnect stopped: ${errorMessage(error)}`);
    }
  }

  private async connectUntilStopped(): Promise<AppsConnectionsOpenResponse | undefined> {
    let failures = 0;
    while (!this.stopping) {
      try {
        const response = await this.client.start();
        if (!this.stopping) return response;
        await this.disconnectClient();
        return undefined;
      } catch (error) {
        if (this.stopping) return undefined;
        if (fatalSocketStartError(error)) {
          this.runtimeLogger.error(`Slack Socket Mode connection failed permanently: ${errorMessage(error)}`);
          throw error;
        }
        failures += 1;
        const delayMs = reconnectDelayWithJitter(
          this.reconnectDelayMs,
          this.reconnectMaxDelayMs,
          failures,
          this.random,
        );
        this.runtimeLogger.warn(
          `Slack Socket Mode connection failed; retrying in ${delayMs}ms: ${errorMessage(error)}`,
        );
        await this.waitForRetry(delayMs);
        if (this.stopping) return undefined;
      }
    }
    return undefined;
  }

  private waitForRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.retryDelay?.resolve === finish) this.retryDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      this.retryDelay = { resolve: finish, timer };
    });
  }

  private releaseRetryDelay(): void {
    const delay = this.retryDelay;
    if (!delay) return;
    this.retryDelay = undefined;
    clearTimeout(delay.timer);
    delay.resolve();
  }

  private async disconnectClient(): Promise<void> {
    await this.client.disconnect().catch((error: unknown) => {
      this.runtimeLogger.warn(`Slack Socket Mode disconnect failed: ${errorMessage(error)}`);
    });
  }
}

function fatalSocketStartError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (!('code' in error) || error.code !== WebApiErrorCode.PlatformError) return false;
  if (
    !('data' in error)
    || !error.data
    || typeof error.data !== 'object'
    || !('error' in error.data)
  ) return false;
  const providerError = error.data.error;
  return typeof providerError === 'string'
    && Object.values<string>(UnrecoverableSocketModeStartError).includes(providerError);
}

function reconnectDelayWithJitter(
  baseMs: number,
  maxMs: number,
  failures: number,
  random: () => number,
): number {
  const exponentialMs = baseMs * (2 ** Math.max(0, failures - 1));
  const cappedMs = Math.max(0, Math.min(exponentialMs, maxMs));
  const floorMs = Math.floor(cappedMs / 2);
  const randomValue = Math.max(0, Math.min(random(), 1));
  return Math.floor(floorMs + (randomValue * (cappedMs - floorMs)));
}
