export type SseEvent = { event: string; data: string };
// 按行处理，支持CRLF、跨网络分块、多行data及心跳注释；不解析不完整事件。
export class SseParser {
  private pending = '';
  private data: string[] = [];
  private name = 'message';
  constructor(
    private emit: (event: SseEvent) => void,
    private maxFrame = 1024 * 1024,
  ) {}
  push(chunk: string) {
    this.pending += chunk;
    let index: number;
    while ((index = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, index).replace(/\r$/, '');
      this.pending = this.pending.slice(index + 1);
      this.line(line);
    }
    if (this.pending.length + this.data.reduce((n, s) => n + s.length, 0) > this.maxFrame)
      throw new Error('SSE事件超出大小限制');
  }
  private line(line: string) {
    if (!line) {
      if (this.data.length) this.emit({ event: this.name, data: this.data.join('\n') });
      this.data = [];
      this.name = 'message';
      return;
    }
    if (line.startsWith(':')) return;
    const at = line.indexOf(':'),
      field = at < 0 ? line : line.slice(0, at),
      value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
    if (field === 'event') this.name = value;
    else if (field === 'data') this.data.push(value);
    if (this.data.reduce((n, s) => n + s.length, 0) > this.maxFrame)
      throw new Error('SSE事件超出大小限制');
  }
  finish() {
    if (this.pending.trim() || this.data.length) throw new Error('SSE连接在完整事件结束前中断');
  }
}
