export class LineBuffer {
  private text = '';

  accept(chunk: string): string[] {
    this.text += chunk;
    const lines = this.text.split(/\r?\n/);
    this.text = lines.pop() ?? '';
    return lines;
  }
}
