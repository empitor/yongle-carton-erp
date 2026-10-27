import { extname } from 'node:path';
import { AiConnectionError } from './connection-error.js';
import { responseFailure } from './response-failure.js';
import type { ChatMessage } from './compatible-chat.js';
export type FilePart = { type: 'file'; file: { filename: string; file_data: string } };
const types: Record<string, string> = {
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
};
export function responsesFilePart(filename: string, data: Buffer): FilePart {
  const ext = extname(filename).toLowerCase(),
    mime = types[ext];
  if (
    !mime ||
    !data.length ||
    data.length > 10 * 1024 * 1024 ||
    filename.length > 180 ||
    /[\x00-\x1f/\\]/.test(filename)
  )
    throw new AiConnectionError(
      'validation',
      'Responses文件必须是有效命名的Word、Excel或PDF，且不超过10MB。',
    );
  const magic = data.subarray(0, 8).toString('hex');
  if (
    ext === '.pdf'
      ? !data.subarray(0, 5).equals(Buffer.from('%PDF-'))
      : ['.doc', '.xls'].includes(ext)
        ? magic !== 'd0cf11e0a1b11ae1'
        : !magic.startsWith('504b0304')
  )
    throw new AiConnectionError('validation', '文件扩展名与真实内容不一致，未发送给模型。');
  return {
    type: 'file',
    file: { filename, file_data: 'data:' + mime + ';base64,' + data.toString('base64') },
  };
}
export function responsesInput(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((part) => {
            if (part.type === 'text') return { type: 'input_text', text: part.text };
            if (part.type === 'image_url')
              return {
                type: 'input_image',
                image_url: part.image_url.url,
                detail: part.image_url.detail || 'high',
              };
            const ext = extname(part.file.filename).toLowerCase(),
              mime = types[ext],
              prefix = 'data:' + mime + ';base64,';
            if (
              !mime ||
              !part.file.file_data.startsWith(prefix) ||
              part.file.file_data.length > 14 * 1024 * 1024
            )
              throw new AiConnectionError(
                'validation',
                '文件输入必须使用服务端编码的受支持文件，不能使用外部或本机文件URL。',
              );
            const encoded = part.file.file_data.slice(prefix.length);
            if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
              throw new AiConnectionError('validation', 'Responses文件编码无效，未发送。');
            responsesFilePart(part.file.filename, Buffer.from(encoded, 'base64'));
            return {
              type: 'input_file',
              filename: part.file.filename,
              file_data: part.file.file_data,
              ...(ext === '.pdf' ? { detail: 'high' } : {}),
            };
          }),
  }));
}
export function responsesText(raw: unknown): string {
  const body = raw as any;
  if (
    body?.status === 'incomplete' ||
    body?.status === 'failed' ||
    body?.incomplete_details ||
    body?.error
  )
    throw responseFailure(
      body?.status === 'incomplete' ? 'response.incomplete' : 'response.failed',
      body,
    );
  if (
    body?.status !== 'completed' ||
    body.error ||
    body.incomplete_details ||
    !Array.isArray(body.output)
  )
    throw new AiConnectionError(
      'response',
      'Responses未完整完成（可能失败、截断或仍在处理中），未采用本次结果。',
      422,
    );
  const text: string[] = [];
  for (const item of body.output) {
    if (item.type === 'reasoning') continue;
    if (
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      (item.status && item.status !== 'completed') ||
      !Array.isArray(item.content)
    )
      throw new AiConnectionError(
        'response',
        'Responses返回了未请求的工具调用或不兼容内容，结果已拒绝。',
        422,
      );
    for (const part of item.content) {
      if (part.type === 'refusal')
        throw new AiConnectionError(
          'response',
          'Responses模型拒绝了本次请求，未采用识别结果。',
          422,
        );
      if (part.type !== 'output_text' || typeof part.text !== 'string')
        throw new AiConnectionError('response', 'Responses返回内容不符合文本输出协议。', 422);
      text.push(part.text);
    }
  }
  if (!text.length || !text.join('').trim())
    throw new AiConnectionError(
      'response',
      'Responses没有返回可用文本，不能判定测试或识别成功。',
      422,
    );
  return text.join('');
}
