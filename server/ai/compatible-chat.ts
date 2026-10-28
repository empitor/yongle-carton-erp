import { usageCollector } from './usage.js';
import type { AiProfile } from '../../shared/ai-settings.js';
import { AiConnectionError, type AiResponseNote } from './connection-error.js';
import { safeConnectionError, upstreamError } from './adapters.js';
import { secureTransport, type AiTransport } from './transport.js';
import type { FilePart } from './responses-format.js';
import { AI_REQUEST_TIMEOUT_MS } from '../../shared/ai-runtime.js';
import type { ResponseOptions } from './compatible-responses.js';
import { officialDeepSeekEndpoint } from '../../shared/assistant-attachments.js';
import { ProtocolDiagnostics, hasDsml } from './protocol-diagnostics.js';
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | (
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'high' | 'auto' } }
        | FilePart
      )[];
};
// 已接收文本只用于安全展示；含密钥或为空的片段一律不携带。
const MAX_NOTE_CHARS = 200_000;
const noteText = (text: string, key: string): string | undefined =>
  !text.trim() || text.includes(key) ? undefined : text.slice(0, MAX_NOTE_CHARS);
const note = (kind: AiResponseNote['kind'], text: string, key: string): AiResponseNote => {
  const safe = noteText(text, key);
  return safe ? { kind, text: safe } : { kind };
};
export async function completeCompatible(
  profile: AiProfile,
  key: string,
  messages: ChatMessage[],
  transport: AiTransport = secureTransport,
  signal?: AbortSignal,
  options: ResponseOptions = {},
): Promise<unknown> {
  const diagnostics = new ProtocolDiagnostics(profile, key, options.onDiagnostic);
  const usage = usageCollector(options.onUsage);
  try {
    let received = '',
      pending = '',
      finished = false,
      seen = false;
    const started = Date.now();
    const delta = (part: string) => {
      received += part;
      diagnostics.text(received);
      pending += part;
      if (received.length > 1024 * 1024 || pending.includes(key))
        throw new AiConnectionError('response', '模型输出不安全或过大，已拒绝。', 422);
      const safe = Math.max(0, pending.length - key.length + 1);
      options.onTextDelta?.(pending.slice(0, safe));
      pending = pending.slice(safe);
      options.onProgress?.({
        stage: 'receiving',
        receivedChars: received.length,
        elapsedMs: Date.now() - started,
      });
    };
    if (messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'file')))
      throw new AiConnectionError(
        'validation',
        'Word、Excel等原始文件输入请选用Responses API；聊天补全流程保持文字/图片输入。',
      );
    const request = {
      url: new URL(profile.endpoint + '/chat/completions'),
      headers: { Authorization: 'Bearer ' + key },
      local: false,
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      maxResponseBytes: 1024 * 1024,
      signal,
      ...(options.stream
        ? {
            onSseEvent: ({ data }: { data: string }) => {
              if (data.trim() === '[DONE]') return;
              const v = JSON.parse(data);
              usage.capture(v.usage);
              diagnostics.stream(v);
              seen = true;
              for (const c of v.choices || []) {
                if (c.delta?.tool_calls || c.delta?.function_call || c.delta?.refusal)
                  throw new AiConnectionError('response', '模型返回未请求的调用或拒答。', 422);
                if (typeof c.delta?.content === 'string') delta(c.delta.content);
                if (c.finish_reason) {
                  if (c.finish_reason !== 'stop')
                    throw new AiConnectionError(
                      'response',
                      '聊天补全流没有完整结束（可能截断或协议不兼容），未采用为业务数据。',
                      422,
                      note(
                        c.finish_reason === 'length' ? 'truncated' : 'incomplete',
                        received,
                        key,
                      ),
                    );
                  finished = true;
                }
              }
            },
          }
        : {}),
    };
    const body = {
      model: profile.model,
      messages,
      max_tokens: Math.max(1000, Math.min(24000, options.maxOutputTokens || 7000)),
      ...(officialDeepSeekEndpoint(profile.endpoint) && options.disableThinking
        ? { thinking: { type: 'disabled' } }
        : {}),
      stream: options.stream === true,
      ...(options.stream && officialDeepSeekEndpoint(profile.endpoint)
        ? { stream_options: { include_usage: true } }
        : {}),
    };
    const initialBody =
      options.jsonMode === 'disabled'
        ? body
        : { ...body, response_format: { type: 'json_object' } };
    diagnostics.request(initialBody);
    let res = await transport({
      ...request,
      body: initialBody,
    });
    diagnostics.result(res.status, res.body);
    usage.capture((res.body as any)?.usage);
    // 部分兼容站没有 JSON mode；只有明确拒绝此参数才降级，结果仍必须通过 JSON 和业务契约校验。
    const formatError = res.body as { error?: { param?: unknown; message?: unknown } } | null;
    const formatMessage = formatError?.error?.message;
    if (
      options.jsonMode !== 'disabled' &&
      options.jsonMode !== 'required' &&
      !seen &&
      !received &&
      [400, 422].includes(res.status) &&
      (formatError?.error?.param === 'response_format' ||
        (typeof formatMessage === 'string' &&
          /response_format|json_object/i.test(formatMessage))) &&
      ((typeof formatMessage === 'string' &&
        /not.support|not.allowed|unsupported|unknown|unrecognized|不支持/i.test(formatMessage)) ||
        ['unsupported_parameter', 'unknown_parameter', 'unsupported_value'].includes(
          String((formatError?.error as any)?.code),
        ))
    ) {
      diagnostics.emit('json-mode-unsupported');
      diagnostics.request(body);
      res = await transport({ ...request, body });
      diagnostics.result(res.status, res.body);
    }
    if (res.status < 200 || res.status >= 300) {
      if (
        [400, 422].includes(res.status) &&
        messages.some(
          (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'),
        )
      )
        throw new AiConnectionError(
          'model',
          '当前模型或 API 拒绝标准 Chat Completions 图像请求。未自动降级 OCR，也未生成识别结果；请检查该预设的视觉能力或重试。',
          422,
        );
      throw upstreamError(res.status, res.body);
    }
    if ((seen || res.streamed) && !finished)
      throw new AiConnectionError(
        'response',
        '聊天补全流中断，未采用本次结果。',
        422,
        note('incomplete', received, key),
      );

    const b = (
        seen ? { choices: [{ finish_reason: 'stop', message: { content: received } }] } : res.body
      ) as any,
      c = b?.choices?.[0];
    if (c?.message?.tool_calls?.length || c?.message?.function_call)
      throw new AiConnectionError(
        'response',
        '当前使用JSON信封，服务返回了未启用的原生工具调用，未执行。',
        422,
        { kind: 'protocol' },
      );
    if (c?.finish_reason !== 'stop' || typeof c?.message?.content !== 'string' || c.message.refusal)
      throw new AiConnectionError(
        'response',
        'AI 服务没有完成本次文本输出（可能截断、拒答或协议不兼容），未采用为业务数据。',
        422,
        note(
          c?.message?.refusal
            ? 'refusal'
            : c?.finish_reason === 'length'
              ? 'truncated'
              : 'incomplete',
          typeof c?.message?.content === 'string' ? c.message.content : received,
          key,
        ),
      );
    const content = c.message.content
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '');
    diagnostics.text(content);
    if (content.includes(key))
      throw new AiConnectionError('response', '模型输出包含敏感凭据，结果已丢弃。', 422);
    options.onTextDelta?.(pending);
    try {
      const parsed = JSON.parse(content);
      diagnostics.emit('complete');
      return parsed;
    } catch {
      // 合法文本但不是 JSON：把文本交给调用方决定是否安全展示，绝不臆造字段。
      throw new AiConnectionError(
        'response',
        'AI 服务返回的文本不是可解析的 JSON 业务数据。',
        422,
        hasDsml(content)
          ? {
              kind: 'protocol',
              text: '模型返回DSML控制文本，与当前JSON信封协议不兼容；未从文本提取或执行工具。',
            }
          : note('invalid-json', content, key),
      );
    }
  } catch (error) {
    const safe = safeConnectionError(error);
    diagnostics.emit(
      'error',
      safe.responseNote?.kind ? safe.code + ':' + safe.responseNote.kind : safe.code,
    );
    if (safe.code === 'timeout' && !(error instanceof AiConnectionError))
      throw new AiConnectionError(
        'timeout',
        'AI 请求网络或连接超时；本地上限600秒，外部网关另有限制。未采用不完整结果。',
        504,
      );
    throw safe;
  } finally {
    usage.report();
  }
}
