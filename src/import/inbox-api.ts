import { LIST_PAGE_SIZE, call, readAuthState, uploadFile } from '../ui/index';
import {
  inboxChannels,
  type ConvertedKind,
  type InboxApi,
  type InboxStatus,
} from '../../shared/import/index';

/** 收件箱的请求（/inbox 下，接口表 shared/import/inbox-api.ts），页面和服务接口都从这里发。 */
const inbox = call<InboxApi>();

/** 列表的筛选：处理状态、来源（空是全部）、关键词、页码 */
export type InboxFilter = { status: InboxStatus; channel: string; q: string; page: number };

/** 一页列表：rows、各状态的条数 counts、page、filteredRecords */
export function readInbox({ status, channel, q, page }: InboxFilter, pageSize = LIST_PAGE_SIZE) {
  return inbox('GET /inbox', {
    query: { status, page, pageSize, channel: inboxChannels.find((c) => c === channel), q: q.trim() || undefined },
  });
}
export const readInboxItem = (id: number) => inbox('GET /inbox/:id', { params: { id } });
/** 消息来源：手动和各家机器人，带连没连上 */
export const readInboxChannels = () => inbox('GET /inbox/channels');
export const inboxFileUrl = (id: number) => '/api/inbox/' + id + '/file';

/** 改处理状态；转成订单时带上转成了什么 */
export const setInboxStatus = (
  row: { id: number; version: number },
  status: InboxStatus,
  convertedKind?: ConvertedKind,
) =>
  inbox('POST /inbox/:id/status', {
    params: { id: row.id },
    body: { status, expectedVersion: row.version, ...(convertedKind ? { convertedKind } : {}) },
  });

/** 交给 AI 识别：建一份识别文件，返回 workspaceId */
export const convertInboxItem = (row: { id: number; version: number }, kind: ConvertedKind) =>
  inbox('POST /inbox/:id/convert', { params: { id: row.id }, body: { kind, expectedVersion: row.version } });

export const addInboxText = (text: string) => inbox('POST /inbox', { body: { text } });

/** 一份份上传到收件箱（凭证先读一次） */
export async function uploadInboxFiles(files: File[]) {
  const { csrf } = await readAuthState();
  for (const file of files)
    await uploadFile('/api/inbox/upload?name=' + encodeURIComponent(file.name), file, {
      token: csrf,
      contentType: file.type,
      failure: file.name + ' 上传失败',
    });
}
