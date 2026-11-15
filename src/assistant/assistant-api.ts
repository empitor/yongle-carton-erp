import { z } from 'zod';
import { inventoryPolicyBody, type AssistantApi, type JsonView } from '../../shared/assistant/index';
import type { ReadAloudRequest } from '../../shared/ai/index';
import { attachmentKinds, attachmentTransfers, isRecord } from '../../shared/core/index';
import { authChanged, call, parseAuthState, readJson, request, throwIfFailed, uploadFile } from '../ui/index';
import { attachmentUrl } from './attachment-slots';
import type { ChatAttachment } from './assistant-types';

/*
 * 助手前端的全部请求：会话、发一句话、核对卡片、附件、记忆、工具启停、朗读、语音。
 * 组件和 hook 只调这里的函数，不自己写地址；一个地址只在这里发一处。
 * JSON 的走接口表（shared/assistant/assistant-api.ts）；录音识别、朗读的音频流、上传附件、读附件原件、回复的事件流不是 JSON，照旧手写。
 */
const assistant = call<AssistantApi>();
type Reply<K extends keyof AssistantApi> = AssistantApi[K]['response'];

// ---- 会话 ----

/** 助手状态：会话列表、AI 能不能用、这个账号存的思考档位 */
export type AssistantState = Reply<'GET /assistant'>;
export const readAssistantState = () => assistant('GET /assistant');
export const readThread = (id: string) => assistant('GET /assistant/threads/:id', { params: { id } });
export const createThread = () => assistant('POST /assistant/threads', { body: {} });
/** 清空会话：返回清空后的会话 */
export const clearThreadHistory = (id: string) =>
  assistant('POST /assistant/threads/:id/clear', { params: { id }, body: { acknowledged: true } });
export const deleteThread = (id: string) =>
  assistant('POST /assistant/threads/:id/delete', { params: { id }, body: { acknowledged: true } });
/** 停止回复：告诉服务器别再往下办 */
export const cancelReply = (id: string) => assistant('POST /assistant/threads/:id/cancel', { params: { id }, body: {} });

/** 发一句话（或卡片确认、拒绝的结果）：返回回复的事件流响应，由 readEventStream（src/ui）读 */
export async function postChat(threadId: string, csrf: string, body: object, signal: AbortSignal): Promise<Response> {
  const r = await request('/api/assistant/threads/' + threadId + '/chat', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': csrf },
    body: JSON.stringify(body),
  });
  await throwIfFailed(r, '请求失败，请稍后重试。');
  return r;
}

/** 服务器要“看一眼页面”：把看到的交回去 */
export type PageResult = AssistantApi['POST /assistant/page/results']['body'];
export const sendPageResult = (body: PageResult) => assistant('POST /assistant/page/results', { body });

// ---- 核对卡片 ----

/** 删除卡片上改“库存怎么处理”（核对区下拉框选的值，只有 preserve、recalculate 两种）：返回重新生成的方案 */
export async function changeInventoryPolicy(id: string, inventoryPolicy: string) {
  const body = inventoryPolicyBody.safeParse({ inventoryPolicy });
  if (!body.success) throw new Error('库存怎么处理只能选列出的两种。');
  return assistant('POST /assistant/previews/:id/inventory-policy', { params: { id }, body: body.data });
}
/** 执行结果：各命令自己的样子；页面只按名字看其中几项（导出的文件、删了几段聊天、当前会话清空没有） */
type ExecutedResult = { readonly [key: string]: JsonView | undefined };
/** 确认执行：带上卡片上看到的范围摘要、要输的密码；结果不是对象（没有可看的项）时给空对象 */
export async function executePreview(id: string, extra: { deletionDigest?: string; password?: string }): Promise<ExecutedResult> {
  const result = await assistant('POST /assistant/previews/:id/execute', { params: { id }, body: { acknowledged: true, ...extra } });
  return isRecord(result) ? result : {};
}
export const rejectPreview = (id: string) =>
  assistant('POST /assistant/previews/:id/reject', { params: { id }, body: {} });

// ---- 附件 ----

/**
 * 上传附件的回答（服务端 server/assistant/router.ts 交回的 AssistantAttachment）。上传地址不在接口表里，回答按它核对；
 * kind、transfer 按 shared/core 列的取值收，和会话里的附件（ChatAttachment）同一个类型。
 */
export const chatAttachmentSchema: z.ZodType<ChatAttachment> = z.looseObject({
  id: z.string(),
  threadId: z.string(),
  name: z.string(),
  size: z.number(),
  mime: z.string(),
  kind: z.enum(attachmentKinds),
  sha256: z.string(),
  createdAt: z.string(),
  deleted: z.boolean(),
  transfer: z.enum(attachmentTransfers),
  width: z.number().optional(),
  height: z.number().optional(),
});
/** 传一份附件到这段会话；uploadId 相同的重传服务器不会重复保存 */
export async function uploadAttachment(
  threadId: string,
  file: File,
  o: { token: string; signal: AbortSignal; name: string; uploadId: string },
): Promise<ChatAttachment> {
  const reply = await uploadFile('/api/assistant/threads/' + threadId + '/attachments', file, {
    token: o.token,
    signal: o.signal,
    headers: { 'X-File-Name': encodeURIComponent(o.name), 'X-Upload-Id': o.uploadId },
    failure: o.name + ' 上传失败',
  });
  const parsed = chatAttachmentSchema.safeParse(reply);
  if (!parsed.success) throw new Error(o.name + ' 上传后服务器回的内容不对，请重试。');
  return parsed.data;
}
export const deleteAttachment = (id: string) =>
  assistant('POST /assistant/attachments/:id/delete', { params: { id }, body: { acknowledged: true } });
/** 还没传完的附件移除：告诉服务器这次上传不要了 */
export const cancelAttachmentUpload = (threadId: string, uploadId: string) =>
  assistant('POST /assistant/threads/:id/attachments/cancel-upload', {
    params: { id: threadId },
    body: { uploadId, acknowledged: true },
  });
/** 预览用：读附件原文件的字节 */
export async function readAttachmentBytes(file: ChatAttachment, signal: AbortSignal) {
  const response = await request(attachmentUrl(file), { signal });
  // 失败按统一方式读：网关错误页不报语法错误，会话失效回登录页
  await throwIfFailed(response, '附件无法读取');
  return response.arrayBuffer();
}

// ---- 记忆（只动当前账号自己的） ----

/** 记忆面板一次要的全部（shared/assistant 的 MemoryView）：下面几个都返回改完后的全部记忆 */
export type AssistantMemoryView = Reply<'GET /assistant/memory'>;
/** 一条记忆。source：assistant 助手记的，manual 自己加的 */
export type AssistantMemoryItem = AssistantMemoryView['memories'][number];
export const readMemories = () => assistant('GET /assistant/memory');
export const addMemory = (content: string) => assistant('POST /assistant/memory', { body: { content } });
export const updateMemory = (id: number, content: string) =>
  assistant('POST /assistant/memory/:id', { params: { id }, body: { content } });
/** 删掉一条记忆：记忆面板和回复下面的“忘掉”都走这一个 */
export const forgetMemory = (id: number) =>
  assistant('POST /assistant/memory/:id/delete', { params: { id }, body: {} });
export const clearMemories = () => assistant('POST /assistant/memory/clear', { body: {} });
export const setMemoryAutoSave = (autoSave: boolean) =>
  assistant('POST /assistant/memory/settings', { body: { autoSave } });

// ---- 工具分组和工具的启停（设置 → 高级） ----

export type PluginManagementState = Reply<'GET /assistant/plugins'>;
export type ManagedPlugin = PluginManagementState['plugins'][number];
export type ManagedTool = ManagedPlugin['tools'][number];
export const readPlugins = () => assistant('GET /assistant/plugins');
export const setPluginEnabled = (id: string, enabled: boolean, expectedRevision: number) =>
  assistant('POST /assistant/plugins/settings', { body: { id, enabled, expectedRevision } });
export const setToolEnabled = (name: string, enabled: boolean, expectedRevision: number) =>
  assistant('POST /assistant/tools/settings', { body: { name, enabled, expectedRevision } });

// ---- 朗读、语音 ----

/** 朗读一条回复：返回音频流和服务器给的采样率（没给是 0），调用方边收边播 */
export async function openReadAloud(csrf: string, body: ReadAloudRequest, signal: AbortSignal) {
  const response = await request('/api/assistant/speak', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': csrf },
    body: JSON.stringify(body),
    signal,
  });
  await throwIfFailed(response, '朗读失败，请重试。');
  if (!response.body) throw new Error('朗读失败，请重试。');
  return {
    stream: response.body,
    sampleRate: Number(response.headers.get('X-Audio-Sample-Rate')) || 0,
  };
}

/**
 * 录完音交识别前现读一次登录状态（能随录音一起停），确认还是录音的那个账号，返回页面凭证。
 * 网关错误页、空响应读不出 JSON 时不报英文语法错误。
 */
export async function speechToken(userId: string | undefined, signal: AbortSignal) {
  const response = await request('/api/auth/state', { cache: 'no-store', signal });
  const auth = parseAuthState(await readJson(response));
  if (response.status === 401) authChanged();
  if (!response.ok || !auth?.csrf || auth.actor?.id !== userId)
    throw Error('登录状态已变化，请重新登录后录音。');
  return auth.csrf;
}

/** 录音识别的回答（shared/ai 的 SpeechResult）：只用识别出的文字 */
export const speechReplySchema = z.object({ text: z.string() });
/** 录音交给 DeepSeek 识别，返回识别出的文字（去掉首尾空白） */
export async function transcribe(csrf: string, pcm: ArrayBuffer, signal: AbortSignal) {
  // 和别的上传同一个入口：失败时统一读说明，会话失效回登录页，网关错误页说服务暂时不可用
  const data = speechReplySchema.safeParse(
    await uploadFile('/api/assistant/transcribe', new Blob([pcm]), {
      token: csrf,
      signal,
      failure: '语音识别失败，请重试。',
    }),
  );
  if (!data.success) throw Error('语音识别的结果格式不对，请重试。');
  return data.data.text.trim();
}
