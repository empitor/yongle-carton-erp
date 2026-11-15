import { z } from 'zod';
import { DEEPSEEK_LIMITS, type UploadPurpose } from '../../shared/ai/index.js';
import { AiConnectionError } from './errors.js';
import {
  closeAfter,
  openDeepSeek,
  readJson,
  readShaped,
  SMALL_JSON_BYTES,
  type AiTransport,
} from './transport.js';
import { fileBlob, isImage, isTable, knownFile, safeName } from './file-types.js';

/**
 * DeepSeek 的文件接口：上传（带过期时间）、删除，以及“上传、用完、删除”的包装。
 * 对话里用 { type: 'file', file_id } 引用上传后的文件。
 */
export type UploadInput = { name: string; data: Buffer; purpose: UploadPurpose };
export type UploadedFile = { id: string; name: string; purpose: UploadPurpose; bytes: number };
export type FilePart = { type: 'file'; file_id: string };

/** 上传前按官方上限核对，不对的直接拒，不发出去。 */
function checkUpload(input: UploadInput) {
  if (!knownFile(input.name)) throw new AiConnectionError('unreadable', '这种文件 DeepSeek 读不了。', 415);
  if (!input.data.length) throw new AiConnectionError('unreadable', '文件是空的。', 400);
  const limit = isImage(input.name)
    ? DEEPSEEK_LIMITS.imageBytes
    : isTable(input.name)
      ? DEEPSEEK_LIMITS.tableBytes
      : DEEPSEEK_LIMITS.documentBytes;
  if (input.data.length > limit)
    throw new AiConnectionError('too_large', '文件太大，超过 DeepSeek 的上限（图片 64 MB、文档 100 MB、表格 32 MB）。', 413);
  if (input.purpose === 'user_data' && !isImage(input.name) && !isTable(input.name))
    throw new AiConnectionError('validation', 'PDF、Word 这类文档要按文档解析上传（程序问题）。', 400);
  if (input.purpose !== 'user_data' && isTable(input.name))
    throw new AiConnectionError('validation', '表格要按数据上传（程序问题）。', 400);
}

/** 上传的文件多久过期：默认 1 小时，官方允许 1 小时到 30 天 */
const EXPIRY_SECONDS = { min: 3600, max: 2_592_000 } as const;
const expirySeconds = (seconds: number = EXPIRY_SECONDS.min) =>
  Math.max(EXPIRY_SECONDS.min, Math.min(EXPIRY_SECONDS.max, seconds));
const uploadedSchema = z.object({ id: z.string().min(1) });

export async function uploadFile(
  transport: AiTransport,
  key: string,
  input: UploadInput,
  opts: { signal?: AbortSignal; expiresSeconds?: number } = {},
): Promise<UploadedFile> {
  checkUpload(input);
  const name = safeName(input.name);
  const form = new FormData();
  // 官方要求 purpose 排在 file 前面
  form.append('purpose', input.purpose);
  form.append('expires_after[anchor]', 'created_at');
  form.append('expires_after[seconds]', String(expirySeconds(opts.expiresSeconds)));
  form.append('file', fileBlob(name, input.data), name);
  // 上传限 120 秒、解析限 120 秒，期间不发数据
  const { response, deadline } = await openDeepSeek(transport, {
    op: 'upload', path: '/files', key, form, timeoutMs: 300_000, signal: opts.signal,
  });
  return closeAfter(deadline, async () => {
    const body = await readShaped(response, uploadedSchema, SMALL_JSON_BYTES, deadline);
    return { id: body.id, name: input.name, purpose: input.purpose, bytes: input.data.length };
  });
}

/** 删除用完的文件；已经不在（404）也算删了。 */
export async function deleteFile(transport: AiTransport, key: string, id: string, signal?: AbortSignal) {
  try {
    const { response, deadline } = await openDeepSeek(transport, {
      op: 'delete', path: '/files/' + encodeURIComponent(id), method: 'DELETE', key, timeoutMs: 30_000, signal,
    });
    await closeAfter(deadline, () => readJson(response, SMALL_JSON_BYTES, deadline));
  } catch (error) {
    if (error instanceof AiConnectionError && error.upstreamStatus === 404) return;
    throw error;
  }
}

const PARALLEL_UPLOADS = 3;
export type FileApi = {
  upload: (input: UploadInput, opts: { signal?: AbortSignal; expiresSeconds?: number }) => Promise<UploadedFile>;
  remove: (id: string) => Promise<void>;
};
/**
 * 上传、用完、删除：文件先传到 DeepSeek（带 1 小时过期），job 结束（成功、失败、取消）都把这次传上去的删掉。
 * 删不掉不报错，靠过期兜底；上传到一半失败，等正在传的都结束、删掉已传的再抛错。
 */
export async function withUploadedFiles<T>(
  api: FileApi,
  files: UploadInput[],
  job: (parts: FilePart[], uploaded: UploadedFile[]) => Promise<T>,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; onCleanupFailure?: (count: number) => void } = {},
): Promise<T> {
  // 按原顺序放，传上去一份填一格；没传完的格子是空的
  const uploaded = new Array<UploadedFile | undefined>(files.length);
  const isUploaded = (f: UploadedFile | undefined) => f !== undefined;
  try {
    let next = 0,
      done = 0;
    // 出错的先后：有一个就不再开新的上传，最后抛第一个
    const failures: unknown[] = [];
    const worker = async () => {
      while (next < files.length && !failures.length) {
        const index = next++;
        try {
          uploaded[index] = await api.upload(files[index], { signal: opts.signal, expiresSeconds: EXPIRY_SECONDS.min });
          opts.onProgress?.(++done, files.length);
        } catch (error) {
          failures.push(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, files.length) }, worker));
    if (failures.length) throw failures[0];
    // 没有失败时每一格都传好了
    const ready = uploaded.filter(isUploaded);
    return await job(
      ready.map((f) => ({ type: 'file', file_id: f.id })),
      ready,
    );
  } finally {
    let failed = 0;
    // 清理不跟着调用方取消：取消了也要删
    await Promise.all(uploaded.filter(isUploaded).map((f) => api.remove(f.id).catch(() => void failed++)));
    if (failed) opts.onCleanupFailure?.(failed);
  }
}
