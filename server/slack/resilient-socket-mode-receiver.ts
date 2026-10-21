import { SocketModeReceiver, type SocketModeReceiverOptions } from '@slack/bolt';
import { UnrecoverableSocketModeStartError } from '@slack/socket-mode';
import { ErrorCode as WebApiErrorCode, type AppsConnectionsOpenResponse } from '@slack/web-api';

import { errorMessage } from '../ids.js';

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
// The SDK pings Slack every third of this timeout and drops the socket once the
// last pong is older than the timeout. With its 5 s default, a stall of about 5 s,
// in a proxy or in the event loop of the process that holds every agent's socket,
// drops them all at once. Allow 30 s, the same as the SDK's timeout for pings
// from Slack.
const CLIENT_PING_TIMEOUT_MS = 30_000;

interface ResilientSocketModeReceiverOptions extends SocketModeReceiverOptions {
  random?: () => number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  runtimeLogger?: Pick<Console, 'error' | 'log' | 'warn'>;
}

type SocketConnectOutcome =
  | { kind: 'connected'; response: AppsConnectionsOpenResponse }
  | { kind: 'stopped' };

// Slack's built-in reconnect path drops a rejected Promise when shutdown races
// a reconnect. Own the retry loop so every connection attempt is observed.
export class ResilientSocketModeReceiver extends SocketModeReceiver {
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly random: () => number;
  private readonly runtimeLogger: Pick<Console, 'error' | 'log' | 'warn'>;
  private lastSocketError?: unknown;
  private reconnectLoop?: Promise<void>;
  private retryDelay?: { resolve(): void; timer: NodeJS.Timeout };
  private started = false;
  private stopping = false;

  constructor(options: ResilientSocketModeReceiverOptions) {
    const {
      clientPingTimeout = CLIENT_PING_TIMEOUT_MS,
      reconnectDelayMs = RECONNECT_DELAY_MS,
      reconnectMaxDelayMs = MAX_RECONNECT_DELAY_MS,
      random = Math.random,
      runtimeLogger = console,
      ...receiverOptions
    } = options;
    super({ ...receiverOptions, autoReconnectEnabled: false, clientPingTimeout });
    this.reconnectDelayMs = reconnectDelayMs;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.random = random;
    this.runtimeLogger = runtimeLogger;
    this.client.on('disconnected', () => this.onDisconnected());
    this.client.on('error', (error: unknown) => {
      this.lastSocketError = error;
    });
  }

  override async start(): Promise<AppsConnectionsOpenResponse> {
    this.stopping = false;
    let outcome: SocketConnectOutcome;
    try {
      outcome = await this.connectUntilStopped();
    } catch (error) {
      // Only an unrecoverable apps.connections.open error gets here, and that
      // call is the one that checks the app token.
      throw new Error(`app token apps.connections.open failed: ${errorMessage(error)}`, { cause: error });
    }
    if (outcome.kind === 'stopped') throw new Error('Slack Socket Mode startup stopped before connecting');
    this.started = true;
    return outcome.response;
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
      const outcome = await this.connectUntilStopped();
      if (outcome.kind === 'connected' && !this.stopping) {
        this.runtimeLogger.log('Slack Socket Mode reconnected.');
      }
    } catch (error) {
      this.runtimeLogger.error(`Slack Socket Mode reconnect stopped: ${errorMessage(error)}`);
    }
  }

  private async connectUntilStopped(): Promise<SocketConnectOutcome> {
    let failures = 0;
    while (!this.stopping) {
      this.lastSocketError = undefined;
      try {
        const response = await this.client.start();
        // The SDK resolves undefined after a real successful hello despite its
        // declared AppsConnectionsOpenResponse return type.
        if (!this.stopping) return { kind: 'connected', response };
        await this.disconnectClient();
        return { kind: 'stopped' };
      } catch (error) {
        if (this.stopping) return { kind: 'stopped' };
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
          `Slack Socket Mode connection failed; retrying in ${delayMs}ms: ${connectFailureMessage(error, this.lastSocketError)}`,
        );
        await this.waitForRetry(delayMs);
        if (this.stopping) return { kind: 'stopped' };
      }
    }
    return { kind: 'stopped' };
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

// The SDK rejects start() with no reason when the WebSocket closes before
// Slack's hello. Its WebSocket error event, if any, carries the cause.
function connectFailureMessage(error: unknown, socketError: unknown): string {
  if (error !== undefined) return errorMessage(error);
  const closed = 'WebSocket closed before Slack sent hello';
  return socketError === undefined ? closed : `${closed}: ${errorMessage(socketError)}`;
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
