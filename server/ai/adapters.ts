import { randomBytes } from 'node:crypto';
import type { AiProfile } from '../../shared/ai-settings.js';
import { AiConnectionError } from './connection-error.js';
import { secureTransport, type AiTransport, type WireRequest } from './transport.js';
import { responsesText } from './responses-format.js';

export function responsesUpstreamError(status: number, body: unknown): AiConnectionError {
  const classified = upstreamError(status, body);
  if (['authentication', 'permission', 'quota', 'rate_limit', 'endpoint'].includes(classified.code))
    return classified;
  if ([404, 405, 501].includes(status))
    return new AiConnectionError(
      'model',
      '此服务的Responses API路径不可用或不受支持。请检查地址及模型，或保留原Chat Completions协议。',
      422,
    );
  if ([400, 415, 422].includes(status))
    return new AiConnectionError(
      'model',
      '服务不接受本次Responses请求；可能不支持该协议、文件类型、模型或结构化输出参数。未切换到聊天补全，也未判定成功。',
      422,
    );
  return classified;
}

export function upstreamError(status: number, body: unknown): AiConnectionError {
  if (status === 524)
    return new AiConnectionError(
      'gateway_timeout',
      '外部API网关返回HTTP 524（上游等待超时）。本机600秒设置不能解除服务商约120～125秒的网关限制；请联系服务商确认网关超时和SSE事件转发。未保存不完整结果。',
      504,
    );
  const upstream = typeof body === 'object' && body !== null ? (body as any).error : null;
  const code = [
    upstream?.code,
    upstream?.status,
    upstream?.type,
    ...(Array.isArray(upstream?.details) ? upstream.details.map((d: any) => d?.reason) : []),
  ]
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(' ');
  if (status === 401 || /invalid_api_key|authentication_error|API_KEY_INVALID/i.test(code))
    return new AiConnectionError(
      'authentication',
      '密钥无效、已撤销或所属项目不正确，请检查并重新输入 API Key。',
      422,
    );
  if (status === 403)
    return new AiConnectionError(
      'permission',
      '服务拒绝访问：请检查 API 权限、地区限制或项目授权。',
      422,
    );
  if (status === 404 || /model_not_found|NOT_FOUND/i.test(code))
    return new AiConnectionError(
      'model',
      '模型或 API 路径不可用。请核对模型 ID、账号访问权限和 API 根地址。',
      422,
    );
  if (status === 402 || /insufficient_quota|billing|RESOURCE_EXHAUSTED/i.test(code))
    return new AiConnectionError(
      'quota',
      '服务额度或计费余额不足，请在服务商控制台检查额度。',
      422,
    );
  if (status === 429)
    return new AiConnectionError(
      'rate_limit',
      '服务请求过于频繁或额度受限，请稍后重试并检查账号限额。',
      429,
    );
  if (status >= 300 && status < 400)
    return new AiConnectionError(
      'endpoint',
      '服务返回重定向。为避免密钥泄漏，本系统不会跟随跳转，请核对最终 API 根地址。',
      422,
    );
  if (status === 400 || status === 422)
    return new AiConnectionError(
      'model',
      '服务不接受该模型或测试参数，请核对模型 ID 及该端点支持的接口协议。',
      422,
    );
  return new AiConnectionError(
    'upstream',
    `服务商返回 HTTP ${status}，请稍后重试或检查服务状态。`,
    502,
  );
}
export function safeConnectionError(error: unknown): AiConnectionError {
  if (error instanceof AiConnectionError) return error;
  const e = error as { code?: string; name?: string; cause?: { code?: string } };
  const code = e?.code || e?.cause?.code || '';
  if (e?.name === 'AbortError' || /TIMEOUT|TIMEDOUT/.test(code))
    return new AiConnectionError(
      'timeout',
      '连接测试超时（45 秒）。请检查后端网络；本地模型首次加载较慢时可稍后重试。',
      504,
    );
  if (/ENOTFOUND|EAI_AGAIN/.test(code))
    return new AiConnectionError(
      'dns',
      '无法解析 API 域名，请检查地址、DNS 和 ERP 所在电脑的网络。',
      502,
    );
  if (/CERT|TLS|SSL/.test(code))
    return new AiConnectionError(
      'tls',
      'TLS 证书验证失败，请检查服务证书和电脑时间；系统不会跳过证书校验。',
      502,
    );
  return new AiConnectionError(
    'network',
    '无法连接 AI 服务。请检查 ERP 后端网络、服务地址及服务是否启动；浏览器能上网不代表后端连接可用。',
    502,
  );
}

export async function probeModel(
  profile: AiProfile,
  key: string | null,
  transport: AiTransport = secureTransport,
): Promise<void> {
  const marker = 'ERP_OK_' + randomBytes(6).toString('hex');
  const prompt = 'Connection test. Reply with exactly this text and nothing else: ' + marker;
  const message = { role: 'user', content: prompt };
  let path: string,
    body: unknown,
    headers: Record<string, string> = {};
  switch (profile.provider) {
    case 'openai':
      path = '/responses';
      headers = { Authorization: 'Bearer ' + key };
      body = { model: profile.model, input: prompt, max_output_tokens: 128, store: false };
      break;
    case 'compatible':
      headers = { Authorization: 'Bearer ' + key };
      if (profile.apiStyle === 'responses') {
        path = '/responses';
        body = { model: profile.model, input: prompt, max_output_tokens: 128, store: false };
      } else {
        path = '/chat/completions';
        body = { model: profile.model, messages: [message], max_tokens: 128, stream: false };
      }
      break;
    case 'gemini':
      path =
        '/models/' +
        encodeURIComponent(profile.model.replace(/^models\//, '')) +
        ':generateContent';
      headers = { 'x-goog-api-key': key! };
      body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 256,
          ...(profile.model.replace(/^models\//, '').startsWith('gemini-2.5-flash')
            ? { thinkingConfig: { thinkingBudget: 0 } }
            : {}),
        },
      };
      break;
    case 'anthropic':
      path = '/messages';
      headers = { 'x-api-key': key!, 'anthropic-version': '2023-06-01' };
      body = { model: profile.model, max_tokens: 128, messages: [message] };
      break;
    case 'ollama':
      path = '/api/chat';
      body = {
        model: profile.model,
        messages: [message],
        stream: false,
        options: { num_predict: 128, temperature: 0 },
      };
      break;
  }
  const request: WireRequest = {
    url: new URL(profile.endpoint + path),
    headers,
    body,
    local: profile.provider === 'ollama',
  };
  try {
    const res = await transport(request);
    if (res.status < 200 || res.status >= 300)
      throw profile.provider === 'openai' || profile.apiStyle === 'responses'
        ? responsesUpstreamError(res.status, res.body)
        : upstreamError(res.status, res.body);
    const b = res.body as any;
    let text = '';
    let complete = false;
    switch (profile.provider) {
      case 'openai':
        text = responsesText(b);
        complete = true;
        break;
      case 'compatible':
        if (profile.apiStyle === 'responses') {
          text = responsesText(b);
          complete = true;
        } else {
          complete = b?.choices?.[0]?.finish_reason === 'stop';
          text = b?.choices?.[0]?.message?.content;
        }
        break;
      case 'gemini':
        complete = b?.candidates?.[0]?.finishReason === 'STOP';
        text = b?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('');
        break;
      case 'anthropic':
        complete = b?.type === 'message' && b?.stop_reason === 'end_turn';
        text = Array.isArray(b?.content)
          ? b.content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('')
          : '';
        break;
      case 'ollama':
        complete = b?.done === true && b?.done_reason !== 'length';
        text = b?.message?.content;
        break;
    }
    if (
      !complete ||
      typeof text !== 'string' ||
      !text.includes(marker) ||
      (!!key && text.includes(key))
    )
      throw new AiConnectionError(
        'response',
        '服务已响应，但未完成预期的短文本生成（可能拒答、截断或协议不匹配）。未判定连接成功，请核对模型后重试。',
        422,
      );
  } catch (error) {
    throw safeConnectionError(error);
  }
}

// 免费目录检查独立于模型推理，公开目录不能证明凭据有效。
export async function connectCompatible(
  profile: AiProfile,
  key: string,
  transport: AiTransport = secureTransport,
) {
  try {
    const url = new URL(profile.endpoint + '/models');
    const result = await transport({
      url,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key },
      local: false,
    });
    if ([404, 405, 501].includes(result.status))
      return {
        status: 'unverified' as const,
        message: '服务可访问，但不支持模型列表接口。凭据尚未验证，请手动填写模型 ID 后测试连接。',
      };
    if (result.status < 200 || result.status >= 300)
      throw upstreamError(result.status, result.body);
    if (!Array.isArray((result.body as any)?.data))
      return {
        status: 'unverified' as const,
        message: '服务已响应，但模型列表格式不受支持。凭据尚未验证，可手动填写模型 ID 后测试。',
      };
    const anonymous = await transport({ url, method: 'GET', headers: {}, local: false }).catch(
      () => null,
    );
    if (anonymous && [401, 403].includes(anonymous.status))
      return {
        status: 'verified' as const,
        message: `API 连接成功，已通过模型目录验证凭据。接下来选择模型并测试${profile.apiStyle === 'responses' ? 'Responses' : '聊天补全'}。`,
      };
    return {
      status: 'unverified' as const,
      message: 'API 可访问，模型目录无需认证或无法验证权限。密钥是否可用需通过模型测试确认。',
    };
  } catch (error) {
    throw safeConnectionError(error);
  }
}

export async function readModelIds(
  profile: AiProfile,
  key: string | null,
  transport: AiTransport = secureTransport,
): Promise<{ models: string[]; truncated: boolean }> {
  const headers: Record<string, string> =
    profile.provider === 'ollama'
      ? {}
      : profile.provider === 'gemini'
        ? { 'x-goog-api-key': key! }
        : profile.provider === 'anthropic'
          ? { 'x-api-key': key!, 'anthropic-version': '2023-06-01' }
          : { Authorization: 'Bearer ' + key };
  try {
    const result = await transport({
      url: new URL(profile.endpoint + (profile.provider === 'ollama' ? '/api/tags' : '/models')),
      headers,
      local: profile.provider === 'ollama',
      method: 'GET',
    });
    if (result.status < 200 || result.status >= 300)
      throw upstreamError(result.status, result.body);
    const b = result.body as any;
    const rows =
      profile.provider === 'ollama' || profile.provider === 'gemini' ? b?.models : b?.data;
    if (!Array.isArray(rows))
      throw new AiConnectionError(
        'response',
        '服务未返回受支持的模型列表格式，你仍可手动填写模型 ID。',
        422,
      );
    const ids: string[] = [
      ...new Set<string>(
        rows
          .map((r: any) =>
            profile.provider === 'ollama' || profile.provider === 'gemini' ? r?.name : r?.id,
          )
          .filter(
            (id: unknown): id is string =>
              typeof id === 'string' &&
              id.length <= 160 &&
              /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id) &&
              (!key || !id.includes(key)),
          ),
      ),
    ];
    return {
      models: ids.slice(0, 300),
      truncated: ids.length > 300 || !!b?.has_more || !!b?.nextPageToken,
    };
  } catch (error) {
    throw safeConnectionError(error);
  }
}
