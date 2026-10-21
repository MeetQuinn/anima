/**
 * Splits a byte stream into lines. Only each new chunk is searched for a line
 * break, and the pieces of a partial line are joined once, when its break
 * arrives. Re-splitting the whole pending text on every chunk made a long line
 * quadratic: a multi-megabyte line from a provider CLI kept the event loop busy
 * for minutes.
 */
export class LineBuffer {
  private pending: string[] = [];

  accept(chunk: string): string[] {
    const lastBreak = chunk.lastIndexOf('\n');
    if (lastBreak === -1) {
      if (chunk) this.pending.push(chunk);
      return [];
    }
    // Keep the break in the joined text so a CR at the end of the previous
    // chunk still pairs with it.
    const complete = this.pending.join('') + chunk.slice(0, lastBreak + 1);
    this.pending = lastBreak + 1 < chunk.length ? [chunk.slice(lastBreak + 1)] : [];
    const lines = complete.split(/\r?\n/);
    lines.pop();
    return lines;
  }
}
