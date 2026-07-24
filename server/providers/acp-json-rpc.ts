import { isRecord, numberField, stringField } from '../json.js';
import { LineBuffer } from './line-buffer.js';
import type { RunningChildProcess } from './child-process.js';

interface PendingRpc {
  method: string;
  reject(error: unknown): void;
  resolve(value: Record<string, unknown> | undefined): void;
}

export interface AcpJsonRpcPeerOptions {
  label: string;
  onNotification(message: Record<string, unknown>): Promise<void> | void;
  onRequest(message: Record<string, unknown>): Promise<void> | void;
  onUnstructuredOutput(text: string): Promise<void> | void;
}

export class AcpJsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly error: Record<string, unknown>,
    label: string,
  ) {
    super(jsonRpcErrorMessage(method, error));
    this.name = `${label.replaceAll(/\s+/g, '')}JsonRpcError`;
  }
}

// Transport-only ACP peer: newline framing, JSON-RPC correlation, and request /
// notification routing. Session semantics and provider event mapping stay in each
// adapter because the three ACP CLIs do not share those contracts.
export class AcpJsonRpcPeer {
  private readonly lines = new LineBuffer();
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRpc>();

  constructor(
    private readonly child: RunningChildProcess,
    private readonly options: AcpJsonRpcPeerOptions,
  ) {}

  async acceptStdoutChunk(chunk: string): Promise<void> {
    for (const line of this.lines.accept(chunk)) {
      await this.acceptLine(line);
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const id = this.nextRequestId++;
    const key = String(id);
    return new Promise((resolve, reject) => {
      this.pending.set(key, { method, reject, resolve });
      try {
        this.write({ id, jsonrpc: '2.0', method, params });
      } catch (error) {
        this.pending.delete(key);
        reject(error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: unknown, result: Record<string, unknown>): void {
    if (rpcIdKey(id) === undefined) return;
    this.write({ id, jsonrpc: '2.0', result });
  }

  respondError(id: unknown, code: number, message: string): void {
    if (rpcIdKey(id) === undefined) return;
    this.write({
      error: { code, message },
      id,
      jsonrpc: '2.0',
    });
  }

  rejectAll(error: unknown): void {
    for (const [key, pending] of [...this.pending]) {
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  private async acceptLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      await this.options.onUnstructuredOutput(trimmed);
      return;
    }
    if (!isRecord(parsed)) return;
    if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
      this.handleResponse(parsed);
      return;
    }
    if ('id' in parsed && typeof parsed.method === 'string') {
      await this.options.onRequest(parsed);
      return;
    }
    if (typeof parsed.method === 'string') {
      await this.options.onNotification(parsed);
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const key = rpcIdKey(message.id);
    if (!key) return;
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    const error = isRecord(message.error) ? message.error : undefined;
    if (error) {
      pending.reject(new AcpJsonRpcError(pending.method, error, this.options.label));
      return;
    }
    pending.resolve(isRecord(message.result) ? message.result : undefined);
  }

  private write(payload: Record<string, unknown>): void {
    this.child.writeStdin(`${JSON.stringify(payload)}\n`);
  }
}

function rpcIdKey(id: unknown): string | undefined {
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

function jsonRpcErrorMessage(method: string, error: Record<string, unknown>): string {
  const message = stringField(error, 'message') ?? 'Unknown JSON-RPC error';
  const code = numberField(error, 'code');
  const data = error.data;
  const renderedData = typeof data === 'string' ? data : data === undefined ? undefined : JSON.stringify(data);
  return [
    `${method}: ${message}`,
    code === undefined ? undefined : `code=${code}`,
    renderedData ? `data=${renderedData}` : undefined,
  ].filter(Boolean).join(' ');
}
