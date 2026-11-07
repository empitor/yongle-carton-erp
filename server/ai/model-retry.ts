import { ZodError } from 'zod';
import { AiConnectionError } from './connection-error.js';
import { ImportError } from '../import/errors.js';

/**
 * 模型偶尔会返回空对象、夹着说明文字的 JSON 或缺字段的结果，这和文件内容无关，再调一次通常就好。
 * 只重试“模型输出不合格”，不重试网络、限流、配额和取消，这些有各自的处理。
 */
export function isBadModelOutput(error: unknown) {
  if (error instanceof ZodError) return true;
  if (error instanceof ImportError) return error.code === 'model-schema';
  return error instanceof AiConnectionError && error.code === 'response' && error.responseNote?.kind === 'invalid-json';
}

export async function retryBadModelOutput<T>(
  job: () => Promise<T>,
  signal?: AbortSignal,
  attempts = 2,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await job();
    } catch (error) {
      if (attempt >= attempts || signal?.aborted || !isBadModelOutput(error)) throw error;
    }
  }
}

/**
 * 部分服务商会在正文前面夹一段内部文字，比如安全判定（……</ds_safety>）或思考过程（<think>……</think>）。
 * 这些不是模型的回答，既不能让 JSON 解析失败，也不能展示给用户。
 */
export function dropModelPreamble(text: string) {
  return text
    .replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '')
    .replace(/^[\s\S]{0,4000}?<\/[a-z_]*safety>\s*/i, '');
}

/**
 * 模型偶尔把下一步也写出来，一次回 {...}{...}。整段都是连着的对象时取第一个，
 * 后面那段是它没等工具结果就写的，不能算数。夹着文字的不算，文字里的示例不能当调用。
 */
function firstOfJoinedObjects(body: string) {
  const ends: number[] = [];
  let depth = 0,
    inString = false,
    escaped = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (depth === 0) {
      if (/\s/.test(c)) continue;
      if (c !== '{') return null;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) ends.push(i);
      if (depth < 0) return null;
    }
  }
  if (depth !== 0 || ends.length < 2) return null;
  return body.slice(0, ends[0] + 1);
}

/**
 * 从模型文字里取 JSON。默认只去掉代码围栏；lenient 再容忍前后夹的说明文字，
 * 只给识别类调用用。助手的回复不用：文字里的 JSON 示例不能被当成工具调用。
 */
export function parseModelJson(text: string, lenient = false): unknown {
  const body = dropModelPreamble(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(body);
  } catch (error) {
    const first = firstOfJoinedObjects(body);
    if (first) return JSON.parse(first);
    if (!lenient) throw error;
    const start = body.indexOf('{'),
      end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw error;
    return JSON.parse(body.slice(start, end + 1));
  }
}
