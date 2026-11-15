import { z } from 'zod';
import { readEventStream, responseData, tokenRequest, uploadFile } from '../ui/index';
import { AI_HTTP_TIMEOUT_MS, type AiProgress } from '../../shared/ai/index';
import {
  aiProgressSchema,
  importWorkspaceViewSchema,
  type ArrivalSource,
  type ImportPreview,
  type ImportsApi,
  type ImportWorkspaceView as Workspace,
  type workspaceEnqueueSchema,
} from '../../shared/import/index';
import type { FileMode } from './fileStatus';

/**
 * AI 导入工作区的请求（/api/ai/imports 下），页面和 hook 都从这里发，不自己拼地址。
 * 地址、正文、回答的类型按接口表（shared/import/imports-api.ts）。写入要带工作区自己的页面凭证 token
 * （列表回答里的 csrfToken，放在请求头 X-ERP-AI-Token），src/ui 的 call() 不带这个请求头，所以这里经 tokenRequest 发；
 * 读不要凭证。每次请求等到 AI_HTTP_TIMEOUT_MS 为止。
 */

type Options = {
  /** 工作区凭证：写入（带 body）时要 */
  token?: string;
  body?: unknown;
  onProgress?: (p: AiProgress) => void;
  signal?: AbortSignal;
  /** 服务端没给说明时显示的话 */
  failure?: string;
};
/** 识别的事件流没读到结果就断了：服务器那边可能已经存了，让人重新加载看 */
const recognitionInterrupted = '流式响应中断，没收到完整识别结果；请重新加载确认状态';

/**
 * 不带 body 是读，带 body 是 POST，写入带工作区凭证。返回事件流时读完（progress 交给 onProgress，只认收到 result 才算完成）；
 * 失败时错误带上 status、code 和原始返回（如新建撞上已有档案时的 candidates）。
 */
async function importRequest<T>(url: string, options: Options = {}): Promise<T> {
  const timeout = AbortSignal.timeout(AI_HTTP_TIMEOUT_MS);
  const limit = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const r = await tokenRequest(url, options.token || '', options.body, limit);
  if (r.ok && r.headers.get('content-type')?.includes('text/event-stream'))
    return readEventStream<T>(r, (event, data) => showProgress(event, data, options.onProgress), recognitionInterrupted);
  return responseData<T>(r, options.failure || '操作失败');
}
/** 进度只用来显示：认不出的那一条不显示，不挡识别 */
function showProgress(event: string, data: unknown, onProgress?: (p: AiProgress) => void) {
  if (event !== 'progress' || !onProgress) return;
  const progress = aiProgressSchema.safeParse(data);
  if (progress.success) onProgress(progress.data);
}

const base = '/api/ai/imports';
/** 识别工作区的键（挂在 /ai/imports 下的那些） */
type Key = Extract<keyof ImportsApi, `${string} /ai/imports${string}`>;
/** 写接口（带正文的键）和各自的正文 */
type WriteKey = { [K in Key]: ImportsApi[K] extends { body: unknown } ? K : never }[Key];
type Bodies = { [K in WriteKey]: ImportsApi[K]['body'] };
/** 键里的地址（“方法 /ai/imports/…”去掉方法和挂载段，前面接上 base）：工作区的键只有 :id 一个路径参数（工作区编号） */
const urlOf = (key: Key, id = '') => base + key.slice(key.indexOf(' /ai/imports') + ' /ai/imports'.length).replace(':id', id);
const read = <K extends Key>(key: K, id?: string, options?: Options) =>
  importRequest<ImportsApi[K]['response']>(urlOf(key, id), options);
const write = <K extends WriteKey>(key: K, id: string, token: string, body: Bodies[K]) =>
  importRequest<ImportsApi[K]['response']>(urlOf(key, id), { token, body });

/** 工作区列表：凭证、AI 状态、文件、归档、读不出来的、识别队列 */
export const readImports = () => read('GET /ai/imports');
export const readWorkspace = (id: string) => read('GET /ai/imports/:id', id);
/** 原件：下载，图片加 ?view=image 直接显示 */
export const workspaceFileUrl = (id: string) => base + '/' + id + '/file';
export const failureDownloadUrl = (id: string) => base + '/diagnostics/' + id + '?download=1';

/** 对一份文件办的事（POST /ai/imports/:id/<办的事>）：改识别类型、排队识别、保存修改、撤回、保存对应、取消、关联到货单 */
type WorkspaceAction = 'mode' | 'enqueue' | 'edit' | 'undo' | 'mapping' | 'cancel' | 'arrival/link';
/** 这件事的正文：都带打开时的版本号 expectedRevision */
type ActionBody<A extends WorkspaceAction> = Bodies[`POST /ai/imports/:id/${A}`];
export const workspaceAction = <A extends WorkspaceAction>(token: string, id: string, action: A, body: ActionBody<A>) =>
  write(`POST /ai/imports/:id/${action}`, id, token, body);

/** 当场识别订单（流式，边收边经 onProgress 报进度）；force 为真时覆盖已有结果 */
export const analyzeWorkspace = (
  token: string,
  id: string,
  body: z.input<typeof workspaceEnqueueSchema> & { force?: boolean },
  onProgress: (p: AiProgress) => void,
) => importRequest<Workspace>(base + '/' + id + '/analyze', { token, body: { ...body, stream: true }, onProgress });

/** 到货单识别（流式），回到货原件的识别记录；force 为真时覆盖已有结果 */
export const recognizeArrivalFile = (token: string, id: string, force: boolean, onProgress: (p: AiProgress) => void) =>
  importRequest<ArrivalSource>(base + '/' + id + '/arrival/recognize', { token, body: { stream: true, force }, onProgress });

/** 导入订单的预览（按这一版识别结果生成），和按预览正式导入（带回预览的识别版本和摘要，预览以后数据变了会被拒） */
export const previewImport = (token: string, id: string, revision: number) =>
  write('POST /ai/imports/:id/preview', id, token, { expectedRevision: revision });
export const executeImport = (token: string, id: string, preview: ImportPreview, distinctProducts: string[]) =>
  write('POST /ai/imports/:id/execute', id, token, {
    expectedRevision: preview.plan.source.revision,
    previewDigest: preview.previewDigest,
    acknowledged: true,
    distinctProducts,
  });

/** 客户、产品的候选档案 */
export const readMatches = (id: string, signal: AbortSignal) =>
  read('GET /ai/imports/:id/matches', id, { signal, failure: '读取失败' });
/** 按标准订单检查：还要补的、能后补的提示（还没识别是 null） */
export const readStandardOrder = (id: string) => read('GET /ai/imports/:id/standard-order', id);

/** 识别失败记录，一页 FAILURE_PAGE（shared/import）条；给了 workspaceId 只看这份文件的 */
export function readFailures(offset: number, workspaceId: string) {
  const q = new URLSearchParams({ offset: String(offset) });
  if (workspaceId) q.set('workspaceId', workspaceId);
  return importRequest<ImportsApi['GET /ai/imports/diagnostics']['response']>(
    urlOf('GET /ai/imports/diagnostics') + '?' + q.toString(),
    { failure: '读取识别失败记录失败' },
  );
}

/** 上传的回答（上传地址收原始字节，不在接口表里，按结构认）：这份工作区，撞上还没处理的同一份文件时带 duplicate */
const uploaded = z.object({ duplicate: z.boolean().optional(), workspace: importWorkspaceViewSchema });
/** 上传一份原件；mode 是新文件按哪种类型识别。回答：是不是撞上了还没处理的同一份文件、这份工作区 */
export async function uploadWorkspaceFile(token: string, file: File, mode: FileMode) {
  const reply = uploaded.safeParse(
    await uploadFile(base + '/upload', file, {
      token,
      tokenHeader: 'X-ERP-AI-Token',
      signal: AbortSignal.timeout(AI_HTTP_TIMEOUT_MS),
      headers: { 'X-File-Name': encodeURIComponent(file.name), 'X-Import-Mode': mode },
      failure: file.name + ' 上传失败',
    }),
  );
  if (!reply.success) throw new Error(file.name + ' 已上传，但读不出结果，请刷新后查看。');
  return { duplicate: reply.data.duplicate === true, workspace: reply.data.workspace };
}

/** 批量归档、恢复、永久删除的逐份结果 */
export type RemovalResult = ImportsApi['POST /ai/imports/batch']['response']['results'][number];
type ChangeAction = 'archive' | 'restore' | 'delete';
/**
 * 识别文件的归档、恢复、永久删除：AI 导入页和数据管理都走这里。
 * 归档、恢复的写法同单据、档案的批量归档；永久删除只给本机管理员。token 不给就现读工作区凭证。
 */
export async function changeWorkspaceFiles(action: ChangeAction, items: { id: string; version: number }[], token?: string) {
  const key = token ?? (await readImports()).csrfToken;
  return action === 'delete'
    ? write('POST /ai/imports/delete-many', '', key, { items })
    : write('POST /ai/imports/batch', '', key, { action, acknowledged: true, items });
}
