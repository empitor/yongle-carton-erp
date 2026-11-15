/**
 * 假 DeepSeek 除对话以外的地址：上传和删除文件、语音识别、朗读、联网搜索、读网页、余额。
 * 按官方规则做最小的核对，不对的回和官方一样的错误码。
 */
import { jsonResponse, streamResponse, type FakeCall } from './fake-deepseek-wire.js';

export type FakeFile = { id: string; filename: string; purpose: string; bytes: number; expiresSeconds?: number; data: Buffer };
export type FakeToolOptions = {
  balance?: { is_available: boolean; balance_infos: unknown[] };
  asrText?: string;
  search?: (query: string) => unknown[];
  pages?: Record<string, { title: string; content: string } | 403 | 404>;
  ttsBytes?: number;
};
/** 假服务的状态：上传过的文件和编号计数（对话编号、文件编号共用一个） */
type FakeState ={ files: Map<string, FakeFile>; nextId: () => number };

const docs = ['.pdf', '.doc', '.docx', '.ppt', '.pptx'];
const images = ['.png', '.jpg', '.jpeg', '.webp'];
const userData = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.xls', '.xlsx', '.txt', '.md', '.csv', '.json'];
const ext = (name: string) => (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? '').toLowerCase();
/** WAV 头 44 字节；语音识别最大 8MB */
const WAV_HEADER = 44;
const ASR_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TTS_BYTES = 4800;
const DEFAULT_SEARCH_COUNT = 10;
const defaultSearch = [
  {
    title: '虚构搜索结果',
    url: 'https://example.com/fictional',
    snippet: '虚构摘要',
    summary: '虚构的较长摘要',
    content: '',
    site_name: '虚构站点',
    date: null,
    rerank_score: 2,
    authority: 1,
  },
];
const defaultBalance = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '100.00', granted_balance: '0.00', topped_up_balance: '100.00' }],
};
const error = (message: string, status: number) => jsonResponse({ error: { message } }, status);

function upload(call: FakeCall, state: FakeState) {
  const fields = call.fields ?? [];
  const { file, purpose } = call.body;
  if (!file || purpose === undefined || fields.indexOf('purpose') > fields.indexOf('file'))
    return error('purpose must come before file', 400);
  const e = ext(file.name);
  if (purpose === 'user_data' ? !userData.includes(e) : !docs.includes(e) && !images.includes(e))
    return error('unsupported file for purpose', 400);
  const id = 'file-api-fake-' + state.nextId();
  state.files.set(id, {
    id,
    filename: file.name,
    purpose,
    bytes: file.size,
    expiresSeconds: Number(call.body['expires_after[seconds]']) || undefined,
    data: file.bytes,
  });
  return jsonResponse({ id, object: 'file', bytes: file.size, filename: file.name, purpose, created_at: Date.now() / 1000 });
}

function remove(call: FakeCall, state: FakeState) {
  const id = decodeURIComponent(call.path.slice('/files/'.length));
  if (!state.files.delete(id)) return error('No such file', 404);
  return jsonResponse({ id, object: 'file', deleted: true });
}

const isWav = (audio: Buffer) =>
  audio.length > WAV_HEADER &&
  audio.subarray(0, 4).toString() === 'RIFF' &&
  audio.subarray(8, 12).toString() === 'WAVE' &&
  audio.readUInt16LE(20) === 1 &&
  audio.readUInt16LE(34) === 16;

function recognize(call: FakeCall, options: FakeToolOptions) {
  const audio = call.body.file?.bytes ?? Buffer.alloc(0);
  if (!isWav(audio)) return error('invalid audio', 400);
  if (audio.length > ASR_MAX_BYTES) return error('too large', 413);
  const rate = audio.readUInt32LE(24);
  return jsonResponse({
    request_id: 'asr-fake',
    text: options.asrText ?? '虚构语音内容',
    duration_ms: Math.round(((audio.length - WAV_HEADER) / 2 / rate) * 1000),
  });
}

function speak(call: FakeCall, options: FakeToolOptions) {
  if (!call.body.text?.trim()) return error('empty text', 400);
  const size = options.ttsBytes ?? DEFAULT_TTS_BYTES;
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  return streamResponse(
    [bytes.subarray(0, size / 3), bytes.subarray(size / 3, (2 * size) / 3), bytes.subarray((2 * size) / 3)],
    call.body.format === 'wav' ? 'audio/wav' : 'audio/pcm',
  );
}

function search(call: FakeCall, options: FakeToolOptions) {
  const q = call.body.query ?? '';
  if (!q.trim() || [...q].length > 128) return error('bad query', 400);
  const results = options.search?.(q) ?? defaultSearch;
  return jsonResponse({ results: results.slice(0, call.body.count || DEFAULT_SEARCH_COUNT) });
}

function fetchPage(call: FakeCall, options: FakeToolOptions) {
  const page = options.pages?.[String(call.body.url)];
  if (page === 403) return error('blocked', 403);
  if (!page || page === 404) return error('not found', 404);
  return jsonResponse(page);
}

/** 对话以外的地址；对不上任何地址回 404 */
export function toolResponse(call: FakeCall, options: FakeToolOptions, state: FakeState): Response {
  const { path, method } = call;
  if (path === '/files' && method === 'POST') return upload(call, state);
  if (path.startsWith('/files/') && method === 'DELETE') return remove(call, state);
  if (path === '/v1/tools/asr') return recognize(call, options);
  if (path === '/v1/tools/tts') return speak(call, options);
  if (path === '/v1/tools/search') return search(call, options);
  if (path === '/v1/tools/fetch') return fetchPage(call, options);
  if (path === '/user/balance') return jsonResponse(options.balance ?? defaultBalance);
  return error('not found', 404);
}
