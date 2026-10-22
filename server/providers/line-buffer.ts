// Provider CLIs write events of at most tens of megabytes; an image or PDF sent
// as base64 stays under 50 MB. A longer line is a runaway, and near V8's limit
// of about 2^29 characters per string it costs gigabytes to join and parse, or
// cannot be joined at all. Drop such a line and keep reading the ones after it.
const MAX_LINE_LENGTH = 64 * 1024 * 1024;

interface LineBufferOptions {
  maxLineLength?: number;
  onLineDropped?(length: number): void;
}

/**
 * Splits a byte stream into lines. Only each new chunk is searched for a line
 * break, and the pieces of a partial line are joined once, when its break
 * arrives. Re-splitting the whole pending text on every chunk made a long line
 * quadratic: a multi-megabyte line from a provider CLI kept the event loop busy
 * for minutes.
 */
export class LineBuffer {
  private pending: string[] = [];
  private pendingLength = 0;
  // Characters seen so far of a line that is too long, while skipping to its end.
  private dropping?: number;
  private readonly maxLineLength: number;
  private readonly onLineDropped: (length: number) => void;

  constructor(options: LineBufferOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? MAX_LINE_LENGTH;
    this.onLineDropped = options.onLineDropped ?? ((length) => {
      console.warn(`Dropped a provider output line of ${length} characters (limit ${this.maxLineLength}).`);
    });
  }

  accept(chunk: string): string[] {
    const lastBreak = chunk.lastIndexOf('\n');
    if (lastBreak === -1) {
      this.hold(chunk);
      return [];
    }
    const firstBreak = chunk.indexOf('\n');
    let complete: string;
    // One extra character allows for the CR of a CRLF break.
    if (this.dropping !== undefined || this.pendingLength + firstBreak > this.maxLineLength + 1) {
      this.onLineDropped((this.dropping ?? this.pendingLength) + firstBreak);
      complete = chunk.slice(firstBreak + 1, lastBreak + 1);
    } else {
      // Keep the break in the joined text so a CR at the end of the previous
      // chunk still pairs with it.
      complete = this.pending.join('') + chunk.slice(0, lastBreak + 1);
    }
    this.pending = [];
    this.pendingLength = 0;
    this.dropping = undefined;
    this.hold(chunk.slice(lastBreak + 1));
    const lines = complete.split(/\r?\n/);
    lines.pop();
    return lines.filter((line) => {
      if (line.length <= this.maxLineLength) return true;
      this.onLineDropped(line.length);
      return false;
    });
  }

  private hold(text: string): void {
    if (!text) return;
    if (this.dropping !== undefined) {
      this.dropping += text.length;
      return;
    }
    this.pending.push(text);
    this.pendingLength += text.length;
    if (this.pendingLength > this.maxLineLength + 1) {
      this.dropping = this.pendingLength;
      this.pending = [];
      this.pendingLength = 0;
    }
  }
}
