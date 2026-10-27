import type { AiProfile } from '../../shared/ai-settings.js';
import type { ChatMessage } from './compatible-chat.js';
import { responsesInput, responsesText } from './responses-format.js';
import { secureTransport, type AiTransport } from './transport.js';
import { AiConnectionError, type AiResponseNote } from './connection-error.js';
import { responsesUpstreamError, safeConnectionError } from './adapters.js';
import { ResponsesStream } from './responses-stream.js';
import { AI_REQUEST_TIMEOUT_MS, type AiProgress } from '../../shared/ai-runtime.js';
import { officialDeepSeekEndpoint } from '../../shared/assistant-attachments.js';
import { ProtocolDiagnostics, hasDsml, type ProviderDiagnostic } from './protocol-diagnostics.js';
export type ResponseOptions = {
  onDiagnostic?: (event: ProviderDiagnostic) => void;
  /** 仅服务端诊断/策略使用；不开放给模型或普通HTTP参数。 */
  jsonMode?: 'prefer' | 'required' | 'disabled';
  /** Server-controlled per-operation budget, not a browser/model writable setting. */
  maxOutputTokens?: number;
  disableThinking?: boolean;
  stream?: boolean;
  onProgress?: (event: AiProgress) => void;
  onQueue?: (state: import('./work-queue.js').QueueState) => void;
  onTextDelta?: (text: string) => void;
};
const MAX_NOTE_CHARS = 200_000;
const noteText = (text: string, key: string): string | undefined =>
  !text.trim() || text.includes(key) ? undefined : text.slice(0, MAX_NOTE_CHARS);
const note = (kind: AiResponseNote['kind'], text: string, key: string): AiResponseNote => {
  const safe = noteText(text, key);
  return safe ? { kind, text: safe } : { kind };
};
export async function completeResponses(
  profile: AiProfile,
  key: string,
  messages: ChatMessage[],
  transport: AiTransport = secureTransport,
  signal?: AbortSignal,
  options: ResponseOptions = {},
): Promise<unknown> {
  let received = '';
  const diagnostics = new ProtocolDiagnostics(profile, key, options.onDiagnostic);
  try {
    const started = Date.now(),
      notify = (stage: AiProgress['stage'], receivedChars: number) =>
        options.onProgress?.({ stage, receivedChars, elapsedMs: Date.now() - started });
    let pending = '';
    const stream = options.stream === true,
      collector = new ResponsesStream(
        (stage, count) => notify(stage, count),
        options.onTextDelta
          ? (delta) => {
              received += delta;
              pending += delta;
              if (pending.includes(key))
                throw new AiConnectionError('response', '模型输出包含敏感凭据，结果已丢弃。', 422);
              const safeLength = Math.max(0, pending.length - key.length + 1);
              options.onTextDelta?.(pending.slice(0, safeLength));
              pending = pending.slice(safeLength);
            }
          : undefined,
      );
    notify('connecting', 0);
    const body = {
      model: profile.model,
      input: responsesInput(messages),
      ...(options.jsonMode === 'disabled' ? {} : { text: { format: { type: 'json_object' } } }),
      max_output_tokens: Math.max(1000, Math.min(24000, options.maxOutputTokens || 7000)),
      ...(officialDeepSeekEndpoint(profile.endpoint) && options.disableThinking
        ? { reasoning: { effort: 'none' } }
        : {}),
      stream,
      store: false,
    };
    diagnostics.request(body);
    const result = await transport({
      url: new URL(profile.endpoint + '/responses'),
      headers: { Authorization: 'Bearer ' + key },
      body,
      local: false,
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      maxResponseBytes: stream ? 8 * 1024 * 1024 : 1024 * 1024,
      signal,
      ...(stream
        ? {
            onSseEvent: (e: any) => {
              try {
                diagnostics.stream(JSON.parse(e.data));
              } catch {}
              collector.event(e);
            },
          }
        : {}),
    });
    diagnostics.result(result.status, result.body);
    if (result.status < 200 || result.status >= 300) {
      const error = responsesUpstreamError(result.status, result.body);
      error.upstreamStatus = result.status;
      throw error;
    }
    const text = responsesText(result.streamed || collector.seen ? collector.finish() : result.body)
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '');
    diagnostics.text(text);
    if (text.includes(key))
      throw new AiConnectionError('response', '模型输出包含敏感凭据，结果已丢弃。', 422);
    notify('validating', text.length);
    options.onTextDelta?.(pending);
    try {
      const parsed = JSON.parse(text);
      diagnostics.emit('complete');
      return parsed;
    } catch {
      // 完整文本但不是 JSON：保留文本供调用方安全展示，绝不臆造业务字段。
      throw new AiConnectionError(
        'response',
        'AI 服务返回的文本不是可解析的 JSON 业务数据。',
        422,
        hasDsml(text)
          ? {
              kind: 'protocol',
              text: '模型返回DSML控制文本，与当前JSON信封协议不兼容；未从文本提取或执行工具。',
            }
          : note('invalid-json', text, key),
      );
    }
  } catch (error) {
    const safe = safeConnectionError(error);
    diagnostics.text(received);
    diagnostics.emit(
      'error',
      safe.responseNote?.kind ? safe.code + ':' + safe.responseNote.kind : safe.code,
    );
    if (safe.code === 'timeout' && !(error instanceof AiConnectionError))
      throw new AiConnectionError(
        'timeout',
        'Responses网络或连接超时；本地上限600秒，外部网关另有限制。未采用本次结果。',
        504,
      );
    // 响应处理失败或未完整结束时，把已安全接收的文字交给调用方决定是否展示。
    if (!safe.responseNote && received.trim() && ['response', 'timeout'].includes(safe.code)) {
      const safeText = noteText(received, key);
      if (safeText) safe.responseNote = { kind: 'incomplete', text: safeText };
    }
    throw safe;
  }
}
