import type { AiProfile } from '../../shared/ai-settings.js';
export type ProviderDiagnostic = {
  protocol: 'custom-json-envelope-v1';
  apiStyle: string;
  stage: string;
  attempt: number;
  endpointHost: string;
  model: string;
  request: any;
  response?: any;
  errorType?: string;
  at: string;
};
export const hasDsml = (text: string) =>
  text.includes('<|DSML|') || text.includes('<｜DSML｜') || text.includes('<DSML');
const safeEnum = (v: unknown, allowed: string[]) =>
  typeof v === 'string' && allowed.includes(v) ? v : 'other';
/** 只保留白名单参数/形状/计数；不序列化消息、文件、密钥、上游错误正文或思考。 */
export class ProtocolDiagnostics {
  private body: any = {};
  private attempt = 0;
  private response: any;
  constructor(
    private profile: AiProfile,
    private key: string,
    private sink?: (v: ProviderDiagnostic) => void,
  ) {}
  request(body: any) {
    this.attempt++;
    this.body = body;
    this.response = undefined;
    this.emit('request');
  }
  result(status: number, raw: any) {
    if (!raw || typeof raw !== 'object') {
      this.response = { ...(this.response || {}), httpStatus: status };
      return;
    }
    const b = raw && typeof raw === 'object' ? raw : {},
      choices = Array.isArray(b.choices) ? b.choices : [],
      output = Array.isArray(b.output) ? b.output : [];
    this.response = {
      ...(this.response || {}),
      httpStatus: status,
      keys: [
        'id',
        'object',
        'created',
        'model',
        'choices',
        'usage',
        'error',
        'status',
        'output',
        'incomplete_details',
      ].filter((k) => Object.hasOwn(b, k)),
      finishReasons: choices.map((c: any) =>
        safeEnum(c.finish_reason, [
          'stop',
          'length',
          'tool_calls',
          'function_call',
          'content_filter',
        ]),
      ),
      responseStatus: b.status
        ? safeEnum(b.status, ['completed', 'incomplete', 'failed', 'in_progress', 'queued'])
        : undefined,
      nativeToolCalls:
        choices.some((c: any) => !!c.message?.tool_calls?.length || !!c.message?.function_call) ||
        output.some((o: any) => ['function_call', 'custom_tool_call'].includes(o.type)),
      outputTypes: output.map((o: any) =>
        safeEnum(o.type, ['message', 'reasoning', 'function_call', 'custom_tool_call']),
      ),
      dsml:
        choices.some((c: any) =>
          hasDsml(typeof c.message?.content === 'string' ? c.message.content : ''),
        ) ||
        output.some((o: any) =>
          o.content?.some?.((c: any) => hasDsml(typeof c.text === 'string' ? c.text : '')),
        ),
    };
  }
  stream(raw: any) {
    this.response ||= {};
    const reasons = (raw?.choices || [])
      .filter((c: any) => c.finish_reason)
      .map((c: any) =>
        safeEnum(c.finish_reason, [
          'stop',
          'length',
          'tool_calls',
          'function_call',
          'content_filter',
        ]),
      );
    if (reasons.length) this.response.finishReasons = reasons;
    if (
      raw?.choices?.some((c: any) => c.delta?.tool_calls?.length || c.delta?.function_call) ||
      ['function_call', 'custom_tool_call'].includes(raw?.item?.type)
    )
      this.response.nativeToolCalls = true;
    if (raw?.response) this.result(200, raw.response);
  }
  text(text: string) {
    if (hasDsml(text)) {
      this.response ||= {};
      this.response.dsml = true;
    }
  }
  emit(stage: string, errorType?: string) {
    if (!this.sink) return;
    const messages = this.body.messages || this.body.input || [],
      max = this.body.max_tokens ?? this.body.max_output_tokens;
    const clean = (v: string) => (v.includes(this.key) ? '[redacted]' : v.slice(0, 100));
    this.sink({
      protocol: 'custom-json-envelope-v1',
      apiStyle: this.profile.apiStyle || 'chat-completions',
      stage,
      attempt: this.attempt,
      endpointHost: clean(new URL(this.profile.endpoint).hostname),
      model: clean(this.profile.model),
      request: {
        stream: this.body.stream === true,
        jsonMode: !!(this.body.response_format || this.body.text?.format),
        maxOutputTokens: max,
        messageCount: messages.length,
        roles: messages.map((m: any) => safeEnum(m.role, ['system', 'user', 'assistant'])),
        nativeToolsDeclared: !!this.body.tools?.length,
        thinkingDisabled:
          this.body.thinking?.type === 'disabled' || this.body.reasoning?.effort === 'none',
      },
      response: this.response ? structuredClone(this.response) : undefined,
      errorType,
      at: new Date().toISOString(),
    });
  }
}
