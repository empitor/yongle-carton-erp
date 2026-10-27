import type { SseEvent } from '../../shared/sse.js';
import { AiConnectionError } from './connection-error.js';
import { responseFailure } from './response-failure.js';
export class ResponsesStream {
  private completed: unknown;
  private terminal = false;
  private chars = 0;
  seen = false;
  constructor(
    private notify: (stage: 'processing' | 'receiving', chars: number) => void,
    private delta?: (text: string) => void,
  ) {}
  event = ({ event, data }: SseEvent) => {
    if (data.trim() === '[DONE]' || event === 'ping' || event === 'heartbeat') return;
    let value: any;
    try {
      value = JSON.parse(data);
    } catch {
      throw new AiConnectionError('response', 'Responses流式事件不是合法JSON，未保存草稿。', 422);
    }
    const type = value?.type || event;
    this.seen = true;
    if (this.terminal)
      throw new AiConnectionError('response', 'Responses完成事件后又收到内容，未保存草稿。', 422);
    if (event !== 'message' && value.type && event !== value.type)
      throw new AiConnectionError('response', 'Responses流式事件类型不一致。', 422);
    if (
      type === 'error' ||
      type === 'response.failed' ||
      type === 'response.incomplete' ||
      type === 'response.cancelled'
    )
      throw responseFailure(type, value, this.chars);
    if (type === 'response.refusal.delta' || type === 'response.refusal.done')
      throw new AiConnectionError('response', 'Responses模型拒绝了本次请求，未保存草稿。', 422);
    if (type === 'response.output_text.delta') {
      if (typeof value.delta !== 'string')
        throw new AiConnectionError('response', 'Responses增量格式无效。', 422);
      this.chars += value.delta.length;
      if (this.chars > 1024 * 1024)
        throw new AiConnectionError('response', '模型输出过大，未保存草稿。', 422);
      this.notify('receiving', this.chars);
      this.delta?.(value.delta);
    } else if (type === 'response.completed') {
      if (!value.response)
        throw new AiConnectionError('response', '完成事件缺少完整响应，未保存草稿。', 422);
      this.completed = value.response;
      this.terminal = true;
    } else if (type === 'response.created' || type === 'response.in_progress')
      this.notify('processing', this.chars);
  };
  finish() {
    if (!this.terminal)
      throw new AiConnectionError(
        'response',
        '流式连接已结束，但没有response.completed完整响应；未保存草稿。',
        422,
      );
    return this.completed;
  }
}
