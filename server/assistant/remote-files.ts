// 传到 DeepSeek 的附件文件跟着本地一起删：用户删附件、清空会话、删会话时，本地删的同一个事务里记下要删的远端文件
// （助手审计里一条 pending），事务提交后去调 DeepSeek 的删除；删成一个记一条 deleted。接口调不通不影响本地删除，
// 留着下次再试（这个账号下次聊天、下次删东西的时候）。文件编号从会话各轮的原样记录里取（chat/session-history.ts 存的 turn.files）。
import { z } from 'zod';
import { many, parseStoredJson, rows } from '../core/index.js';
import type { Store } from '../core/index.js';
import { FILE_TTL_SECONDS, uploadedFilesSchema } from './chat/model-attachments.js';

const TOOL = 'attachments.remote';
/** 只重试这么久以内记下的：再早的在 DeepSeek 那边已经到期自己删了（上传时最多留 7 天，chat/model-attachments.ts） */
const RETRY_WINDOW_MS = FILE_TTL_SECONDS * 1000;
/** 这份文件写的助手审计 document：要删、删成的远端文件编号 */
const remoteDeletion = z.object({ fileIds: z.array(z.string()) });
const deletionEntry = rows.assistant_audit.pick({ id: true, state: true, document: true });
const turnFiles = z.object({ seq: z.number(), files: z.string() });

const deletionDocument = (fileIds: string[]): z.input<typeof remoteDeletion> => ({ fileIds });

/** 这个会话里传到 DeepSeek 的文件编号；给了 attachmentIds 就只要这几份附件的 */
function uploadedFileIds(store: Store, threadId: string, attachmentIds?: readonly string[]) {
  const ids = new Set<string>();
  const turns = many(
    store.db,
    turnFiles,
    "SELECT seq,json_extract(document,'$.turn.files') AS files FROM assistant_messages WHERE thread_id=? AND json_extract(document,'$.turn.files') IS NOT NULL",
    threadId,
  );
  for (const turn of turns) {
    const files = parseStoredJson(uploadedFilesSchema, turn.files, 'assistant_messages.document 的 turn.files（第 ' + turn.seq + ' 行）');
    for (const [fileId, file] of Object.entries(files))
      if (!attachmentIds || attachmentIds.includes(file.attachmentId)) ids.add(fileId);
  }
  return [...ids];
}

/** 本地删之前（同一个事务里）调：记下这个会话（或其中几份附件）传上去、要跟着删的文件。 */
export function queueRemoteDeletion(store: Store, userId: string, threadId: string, attachmentIds?: readonly string[]) {
  const fileIds = uploadedFileIds(store, threadId, attachmentIds);
  if (!fileIds.length) return;
  store.db
    .prepare('INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,?,?,?,?,?)')
    .run(userId, threadId, TOOL, 'pending', JSON.stringify(deletionDocument(fileIds)), new Date().toISOString());
}

/** 这个账号记下了、还没删成的远端文件都试一遍；remove 是 DeepSeek 的删除接口（文件已经不在也算删了）。返回还剩几个没删成。 */
export async function flushRemoteDeletions(store: Store, userId: string, remove: (fileId: string) => Promise<void>) {
  const entries = many(
    store.db,
    deletionEntry,
    'SELECT id,state,document FROM assistant_audit WHERE user_id=? AND tool=? AND created_at>? ORDER BY id',
    userId,
    TOOL,
    new Date(Date.now() - RETRY_WINDOW_MS).toISOString(),
  );
  const pending = new Set<string>();
  for (const entry of entries) {
    const { fileIds } = parseStoredJson(remoteDeletion, entry.document, 'assistant_audit.document（第 ' + entry.id + ' 条）');
    for (const id of fileIds) {
      if (entry.state === 'pending') pending.add(id);
      else pending.delete(id);
    }
  }
  let left = 0;
  for (const fileId of pending)
    try {
      await remove(fileId);
      store.db
        .prepare('INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,NULL,?,?,?,?)')
        .run(userId, TOOL, 'deleted', JSON.stringify(deletionDocument([fileId])), new Date().toISOString());
    } catch {
      // 调不通（断网、没填密钥）：留着，下次再试
      left++;
    }
  return left;
}
